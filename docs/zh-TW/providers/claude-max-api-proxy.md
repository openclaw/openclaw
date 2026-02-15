---
summary: "將 Claude Max/Pro 訂閱作為相容於 OpenAI 的 API 端點使用"
read_when:
  - 您想將 Claude Max 訂閱與相容於 OpenAI 的工具搭配使用
  - 您需要一個包裝 Claude Code CLI 的本地 API 伺服器
  - 您想透過訂閱而非 API 金鑰來節省費用
title: "Claude Max API Proxy"
---

# Claude Max API Proxy

**claude-max-api-proxy** 是一個社群工具，它將您的 Claude Max/Pro 訂閱展示為相容於 OpenAI 的 API 端點。這讓您可以將您的訂閱與任何支援 OpenAI API 格式的工具搭配使用。

## 為什麼要使用這個？

| 方法            | 成本                                            | 最適合                     |
| --------------- | ----------------------------------------------- | -------------------------- |
| Anthropic API   | 按 Token 付費 (Opus 約每百萬輸入 $15，輸出 $75) | 正式生產應用、高用量       |
| Claude Max 訂閱 | 每月 $200 固定費用                              | 個人使用、開發、無限量使用 |

如果您擁有 Claude Max 訂閱，並希望將其與相容於 OpenAI 的工具搭配使用，此 Proxy 可以為您節省大量費用。

## 運作方式

```
您的應用程式 → claude-max-api-proxy → Claude Code CLI → Anthropic (透過訂閱)
     (OpenAI 格式)              (轉換格式)      (使用您的登入資訊)
```

此 Proxy：

1. 在 `http://localhost:3456/v1/chat/completions` 接收 OpenAI 格式的請求
2. 將其轉換為 Claude Code CLI 指令
3. 以 OpenAI 格式回傳回應（支援串流傳輸）

## 安裝

```bash
# 需要 Node.js 20+ 與 Claude Code CLI
npm install -g claude-max-api-proxy

# 確認 Claude CLI 已通過驗證
claude --version
```

## 使用方法

### 啟動伺服器

```bash
claude-max-api
# 伺服器執行於 http://localhost:3456
```

### 測試

```bash
# 健康檢查
curl http://localhost:3456/health

# 列出模型
curl http://localhost:3456/v1/models

# 對話補全
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### 搭配 OpenClaw

您可以將 OpenClaw 指向此 Proxy 作為自定義的 OpenAI 相容端點：

```json5
{
  env: {
    OPENAI_API_KEY: "not-needed",
    OPENAI_BASE_URL: "http://localhost:3456/v1",
  },
  agents: {
    defaults: {
      model: { primary: "openai/claude-opus-4" },
    },
  },
}
```

## 可用模型

| 模型 ID           | 對應至          |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## 在 macOS 上自動啟動

建立一個 LaunchAgent 來自動執行 Proxy：

```bash
cat > ~/Library/LaunchAgents/com.claude-max-api.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-max-api</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/lib/node_modules/claude-max-api-proxy/dist/server/standalone.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:~/.local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-max-api.plist
```

## 連結

- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **問題回報 (Issues):** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## 注意事項

- 這是**社群工具**，並非由 Anthropic 或 OpenClaw 官方支援
- 需要有效的 Claude Max/Pro 訂閱，且 Claude Code CLI 已通過驗證
- Proxy 在本地執行，不會將資料傳送到任何第三方伺服器
- 完全支援串流回應

## 延伸閱讀

- [Anthropic 供應商](/providers/anthropic) - 透過 Claude setup-token 或 API 金鑰進行的原生 OpenClaw 整合
- [OpenAI 供應商](/providers/openai) - 用於 OpenAI/Codex 訂閱
