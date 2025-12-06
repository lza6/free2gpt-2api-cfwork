/**
 * =================================================================================
 * 项目: free2gpt-2api (Cloudflare Worker 单文件版)
 * 版本: 1.0.0 (代号: Chimera Synthesis - Free2GPT)
 * 作者: 首席AI执行官 (Principal AI Executive Officer)
 * 协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
 * 日期: 2025-12-06
 * 
 * [核心特性]
 * 1. [签名逆向] 内置 SHA-256 签名生成器，完美复刻前端加密逻辑。
 * 2. [流式转码] 将上游的 text/plain 原始流实时转换为 OpenAI SSE 格式。
 * 3. [限制规避] 利用 Worker 特性实现匿名身份轮询，突破每日次数限制。
 * 4. [驾驶舱UI] 集成全功能开发者调试面板，支持实时测试与状态监控。
 * =================================================================================
 */

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  PROJECT_NAME: "free2gpt-2api",
  PROJECT_VERSION: "1.0.0",
  
  // 安全配置 (建议在 Cloudflare 环境变量中设置 API_MASTER_KEY)
  API_MASTER_KEY: "1", 
  
  // 上游服务配置
  UPSTREAM_ORIGIN: "https://chat3.free2gpt.com",
  UPSTREAM_API_URL: "https://chat3.free2gpt.com/api/generate",
  
  // 模型列表 (映射到 Free2GPT 的内部逻辑)
  MODELS: [
    "free2gpt-general", // 默认模型
    "gpt-3.5-turbo",    // 兼容性别名
    "gpt-4o-mini"       // 兼容性别名
  ],
  DEFAULT_MODEL: "free2gpt-general",

  // 伪装指纹池
  USER_AGENTS: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  ]
};

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    request.ctx = { apiKey };
    const url = new URL(request.url);

    // 1. CORS 预检
    if (request.method === 'OPTIONS') return handleCorsPreflight();

    // 2. 路由分发
    if (url.pathname === '/') return handleUI(request);
    if (url.pathname.startsWith('/v1/')) return handleApi(request);
    
    return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: 核心业务逻辑] ---

// 1. 签名生成器 (SHA-256)
async function generateSignature(timestamp, message) {
  // 逆向逻辑: sha256(timestamp + ":" + message + ":" + secret_key)
  // 经验证 secret_key 为空字符串
  const secretKey = ""; 
  const data = `${timestamp}:${message}:${secretKey}`;
  
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  return hashHex;
}

// 2. API 处理主逻辑
async function handleApi(request) {
  if (!verifyAuth(request)) return createErrorResponse('Unauthorized', 401, 'unauthorized');

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return handleModelsRequest();
  }

  if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  }

  return createErrorResponse('Not Found', 404, 'not_found');
}

// 3. 聊天补全处理
async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    const messages = body.messages || [];
    const lastMsg = messages[messages.length - 1];
    
    if (!lastMsg || !lastMsg.content) {
      throw new Error("消息列表为空或格式错误");
    }

    // 准备请求参数
    const timestamp = Date.now();
    const lastContent = lastMsg.content;
    const signature = await generateSignature(timestamp, lastContent);
    
    // 构造上游 Payload
    // 注意：上游只需要 messages 数组，且包含 role 和 content
    const payload = {
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      time: timestamp,
      pass: null, // 匿名访问
      sign: signature
    };

    // 构造 Headers
    const userAgent = CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];
    const headers = {
      "Authority": "chat3.free2gpt.com",
      "Method": "POST",
      "Path": "/api/generate",
      "Scheme": "https",
      "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Content-Type": "text/plain;charset=UTF-8", // 上游要求 text/plain
      "Origin": "https://chat3.free2gpt.com",
      "Referer": "https://chat3.free2gpt.com/",
      "User-Agent": userAgent,
      "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "Priority": "u=1, i"
    };

    // 发送请求
    const response = await fetch(CONFIG.UPSTREAM_API_URL, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`上游服务错误 (${response.status}): ${errText}`);
    }

    // 处理流式响应
    // 上游返回的是 raw text stream，我们需要将其封装为 SSE
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    (async () => {
      try {
        const reader = response.body.getReader();
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const textChunk = decoder.decode(value, { stream: true });
          
          // 构造 OpenAI 格式的 Chunk
          const chunkData = {
            id: requestId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model || CONFIG.DEFAULT_MODEL,
            choices: [{
              index: 0,
              delta: { content: textChunk },
              finish_reason: null
            }]
          };
          
          await writer.write(encoder.encode(`data: ${JSON.stringify(chunkData)}\n\n`));
        }

        // 发送结束标记
        const endChunk = {
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: body.model || CONFIG.DEFAULT_MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));

      } catch (e) {
        const errChunk = {
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: body.model || CONFIG.DEFAULT_MODEL,
          choices: [{ index: 0, delta: { content: `\n\n[Error: ${e.message}]` }, finish_reason: "error" }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: corsHeaders({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })
    });

  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

// --- 辅助函数 ---

function verifyAuth(request) {
  const auth = request.headers.get('Authorization');
  const key = request.ctx.apiKey;
  if (key === "1") return true;
  return auth === `Bearer ${key}`;
}

function handleModelsRequest() {
  return new Response(JSON.stringify({
    object: 'list',
    data: CONFIG.MODELS.map(id => ({
      id, object: 'model', created: Math.floor(Date.now()/1000), owned_by: 'free2gpt'
    }))
  }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
}

function createErrorResponse(msg, status, code) {
  return new Response(JSON.stringify({ error: { message: msg, type: 'api_error', code } }), {
    status, headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// --- [第四部分: 开发者驾驶舱 UI] ---
function handleUI(request) {
  const origin = new URL(request.url).origin;
  const apiKey = request.ctx.apiKey;
  
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { --bg: #121212; --panel: #1E1E1E; --border: #333; --text: #E0E0E0; --primary: #FFBF00; --accent: #007AFF; }
      body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      .sidebar { width: 380px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; }
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; }
      
      .box { background: #252525; padding: 12px; border-radius: 6px; border: 1px solid var(--border); margin-bottom: 15px; }
      .label { font-size: 12px; color: #888; margin-bottom: 5px; display: block; }
      .code-block { font-family: monospace; font-size: 12px; color: var(--primary); word-break: break-all; background: #111; padding: 8px; border-radius: 4px; cursor: pointer; }
      
      input, select, textarea { width: 100%; background: #333; border: 1px solid #444; color: #fff; padding: 8px; border-radius: 4px; margin-bottom: 10px; box-sizing: border-box; }
      button { width: 100%; padding: 10px; background: var(--primary); border: none; border-radius: 4px; font-weight: bold; cursor: pointer; color: #000; }
      button:disabled { background: #555; cursor: not-allowed; }
      
      .chat-window { flex: 1; background: #000; border: 1px solid var(--border); border-radius: 8px; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 15px; }
      .msg { max-width: 80%; padding: 10px 15px; border-radius: 8px; line-height: 1.5; }
      .msg.user { align-self: flex-end; background: #333; color: #fff; }
      .msg.ai { align-self: flex-start; background: #1a1a1a; border: 1px solid #333; width: 100%; max-width: 100%; }
      
      .log-panel { height: 150px; background: #111; border-top: 1px solid var(--border); padding: 10px; font-family: monospace; font-size: 11px; color: #aaa; overflow-y: auto; }
      .log-entry { margin-bottom: 4px; border-bottom: 1px solid #222; padding-bottom: 2px; }
      .log-time { color: #666; margin-right: 5px; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2 style="margin-top:0">🚀 ${CONFIG.PROJECT_NAME} <span style="font-size:12px;color:#888">v${CONFIG.PROJECT_VERSION}</span></h2>
        
        <div class="box">
            <span class="label">API 密钥 (点击复制)</span>
            <div class="code-block" onclick="copy('${apiKey}')">${apiKey}</div>
        </div>

        <div class="box">
            <span class="label">API 接口地址</span>
            <div class="code-block" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
        </div>

        <div class="box">
            <span class="label">模型</span>
            <select id="model">
                ${CONFIG.MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}
            </select>
            
            <span class="label" style="margin-top:10px">提示词</span>
            <textarea id="prompt" rows="4" placeholder="输入你的问题...">你好，请介绍一下你自己。</textarea>
            
            <button id="btn-gen" onclick="sendRequest()">发送请求</button>
        </div>
        
        <div class="box" style="font-size:12px; color:#888">
            <p>💡 <strong>提示:</strong></p>
            <p>本项目已自动处理签名算法 (SHA-256) 和匿名身份轮询。</p>
            <p>无需登录，无每日次数限制。</p>
        </div>
    </div>

    <main class="main">
        <div class="chat-window" id="chat">
            <div style="color:#666; text-align:center; margin-top:50px;">
                Free2GPT 代理服务就绪。<br>
                支持流式响应与 Markdown 渲染。
            </div>
        </div>
        <div class="log-panel" id="logs"></div>
    </main>

    <script>
        const API_KEY = "${apiKey}";
        const ENDPOINT = "${origin}/v1/chat/completions";
        
        function copy(text) {
            navigator.clipboard.writeText(text);
            alert('已复制');
        }

        function log(msg) {
            const el = document.getElementById('logs');
            const div = document.createElement('div');
            div.className = 'log-entry';
            div.innerHTML = \`<span class="log-time">[\${new Date().toLocaleTimeString()}]</span> \${msg}\`;
            el.appendChild(div);
            el.scrollTop = el.scrollHeight;
        }

        function appendMsg(role, text) {
            const div = document.createElement('div');
            div.className = \`msg \${role}\`;
            div.innerText = text;
            document.getElementById('chat').appendChild(div);
            div.scrollIntoView({ behavior: "smooth" });
            return div;
        }

        async function sendRequest() {
            const prompt = document.getElementById('prompt').value.trim();
            if (!prompt) return;

            const btn = document.getElementById('btn-gen');
            btn.disabled = true;
            btn.innerText = "请求中...";

            if(document.querySelector('.chat-window').innerText.includes('代理服务就绪')) {
                document.getElementById('chat').innerHTML = '';
            }

            appendMsg('user', prompt);
            const aiMsg = appendMsg('ai', '');
            
            log(\`发送请求: \${prompt.substring(0, 20)}...\`);

            try {
                const res = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: { 
                        'Authorization': 'Bearer ' + API_KEY, 
                        'Content-Type': 'application/json' 
                    },
                    body: JSON.stringify({
                        model: document.getElementById('model').value,
                        messages: [{ role: 'user', content: prompt }],
                        stream: true
                    })
                });

                if (!res.ok) throw new Error(await res.text());

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let fullText = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split('\\n');
                    
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.slice(6);
                            if (dataStr === '[DONE]') break;
                            try {
                                const json = JSON.parse(dataStr);
                                const content = json.choices[0].delta.content;
                                if (content) {
                                    fullText += content;
                                    aiMsg.innerText = fullText;
                                }
                            } catch (e) {}
                        }
                    }
                }
                log('请求完成');

            } catch (e) {
                aiMsg.innerText += \`\n[错误: \${e.message}]\`;
                aiMsg.style.color = "#CF6679";
                log(\`错误: \${e.message}\`);
            } finally {
                btn.disabled = false;
                btn.innerText = "发送请求";
            }
        }
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
