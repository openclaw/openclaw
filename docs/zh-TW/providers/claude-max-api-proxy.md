---
summary: "使用 Claude Max/Pro 訂閱作為 OpenAI 相容的 API 端點"
read_when:
  - 您想將 Claude Max 訂閱與 OpenAI 相容的工具一起使用
  - 您想要一個包裝 Claude Code CLI 的本地 API 伺服器
  - 您想透過訂閱而非 API 密鑰來省錢
title: "Claude Max API 代理"
---

# Claude Max API 代理

**claude-max-api-proxy** 是一個社群工具，可將您的 Claude Max/Pro 訂閱公開為 OpenAI 相容的 API 端點。這使您能夠將訂閱與任何支援 OpenAI API 格式的工具一起使用。

## 為何使用此工具？

| 方法 | 費用 | 最適用於 |
| ----------------------- | --------------------------------------------------- | ------------------------------------------ |
| Anthropic API | 按權杖付費 (~$15/百萬輸入， $75/百萬輸出 (Opus)) | 生產應用、高流量 |
| Claude Max 訂閱 | 每月固定 $200 | 個人使用、開發、無限使用 |

如果您擁有 Claude Max 訂閱並想將其與 OpenAI 相容的工具一起使用，這個代理可以為您節省大量費用。

## 運作方式

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

此代理：

1.  接受位於 `http://localhost:3456/v1/chat/completions` 的 OpenAI 格式請求
2.  將其轉換為 Claude Code CLI 指令
3.  以 OpenAI 格式回傳回應 (支援區塊串流傳輸)

## 安裝

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## 使用方法

### 啟動伺服器

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### 測試

```bash
# Health check
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### 搭配 OpenClaw 使用

您可以將 OpenClaw 指向此代理作為自訂的 OpenAI 相容端點：

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

| 模型 ID | 對應至 |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## 在 macOS 上自動啟動

建立一個 LaunchAgent 以自動執行此代理：

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

-   **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
-   **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
-   **Issues:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## 注意事項

-   這是一個 **社群工具**，並非 Anthropic 或 OpenClaw 官方支援。
-   需要有效的 Claude Max/Pro 訂閱，並已透過 Claude Code CLI 進行驗證。
-   此代理在本地執行，不會將資料傳送至任何第三方伺服器。
-   完全支援區塊串流傳輸回應。

## 參見

-   [Anthropic 供應商](/providers/anthropic) - 使用 Claude setup-token 或 API 密鑰的原生 OpenClaw 整合
-   [OpenAI 供應商](/providers/openai) - 適用於 OpenAI/Codex 訂閱
