# 🛠️ OpenClaw OpenAI Proxy 修复工具指南 (Tools Guide)

这个脚本用于修复 OpenClaw 在使用非官方 OpenAI 代理（如 `ppserver.xyz`）时的 Bug。

### 📌 脚本位置

`/Users/ppg/PPClaw/openclaw/BuildTools/patch_openai_proxy.sh`

### ❓ 为什么要用这个脚本？

1. **官方 Bug**：官方 OpenClaw 目前忽略了 `openclaw.json` 里的 `baseUrl` 配置，强制连接 `api.openai.com`。
2. **安全防护**：代理服务器（如经过 Cloudflare）通常需要自定义 `User-Agent`，脚本支持了这一配置。
3. **协议匹配**：脚本会自动处理 WebSocket (wss://) 与 HTTP (https://) 的转换。

---

### 🚀 使用场景

- **当你通过 `git pull` 更新了 OpenClaw 代码后**
- **当你发现自定义 GPT-5.4 又连不上时**
- **当你重装项目后**

### 💻 如何执行

```bash
cd /Users/ppg/PPClaw/openclaw/BuildTools
./patch_openai_proxy.sh
```

### 📝 脚本会自动完成以下操作：

1. **扫描源代码**：找到 `openai-ws-connection.ts` 和 `attempt.ts`。
2. **注入补丁**：将支持自定义 URL 和 Headers 的代码注入其中。
3. **重新编译**：执行 `pnpm build`。
4. **重启服务**：执行 `restart_openclaw.sh` 确保生效。

---

> [!IMPORTANT]
> 执行本脚本前，请确保你在 `openclaw.json` 里已经配置好了正确的 `baseUrl` 和 `headers`。
