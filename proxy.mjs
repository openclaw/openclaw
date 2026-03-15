import http from 'http'; 
 import httpProxy from 'http-proxy'; 
 import { spawn } from 'child_process'; 
 
 // 初始化反向代理 
 const proxy = httpProxy.createProxyServer({ 
   target: 'http://127.0.0.1:18789', 
   ws: true, // 关键：支持 WebSocket 转发（OpenClaw 核心依赖） 
   changeOrigin: true, 
   autoRewrite: true 
 }); 
 
 // 处理代理错误 
 proxy.on('error', (err) => { 
   console.error('[proxy] 代理错误:', err); 
 }); 
 
 // 启动 OpenClaw 内部服务（监听 127.0.0.1:18789） 
 const openclawProcess = spawn('node', [ 
   'openclaw.mjs', 
   'gateway', 
   '--allow-unconfigured', 
   '--port', '18789' 
 ], { 
   stdio: 'inherit', 
   env: { 
     ...process.env, 
     OPENCLAW_HOST_ADDRESS: '127.0.0.1', // 强制内部监听 
     MODELS_DEFAULT: 'nvidia/minimaxai/minimax-m2.1', 
     MODELS_DISABLED_PROVIDERS: '["anthropic"]', 
     OPENCLAW_DATA_DIR: '/data/.openclaw', // 配置写入持久化目录 
     OPENCLAW_WORKSPACE_DIR: '/data/workspace' // 工作区写入持久化目录 
   } 
 }); 
 
 // 启动代理服务器（监听 Railway 的 $PORT 端口） 
 const server = http.createServer((req, res) => { 
   // 转发所有 HTTP 请求到 OpenClaw 
   proxy.web(req, res, (err) => { 
     if (err) { 
       res.writeHead(503, { 'Content-Type': 'text/plain' }); 
       res.end('OpenClaw 服务正在启动，请稍后重试'); 
     } 
   }); 
 }); 
 
 // 处理 WebSocket 升级请求（关键） 
 server.on('upgrade', (req, socket, head) => { 
   proxy.ws(req, socket, head); 
 }); 
 
 // 启动代理服务 
 const PORT = process.env.PORT || 3000; 
 server.listen(PORT, '0.0.0.0', () => { 
   console.log(`[proxy] 反向代理启动成功，监听公网端口: ${PORT}`); 
   console.log(`[proxy] 转发至 OpenClaw 内部地址: 127.0.0.1:18789`); 
 }); 
 
 // 进程退出处理 
 process.on('SIGTERM', () => { 
   openclawProcess.kill(); 
   server.close(); 
   process.exit(0); 
 });