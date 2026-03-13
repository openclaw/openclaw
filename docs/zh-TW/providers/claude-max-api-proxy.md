---
summary: >-
  Community proxy to expose Claude subscription credentials as an
  OpenAI-compatible endpoint
read_when:
  - You want to use Claude Max subscription with OpenAI-compatible tools
  - You want a local API server that wraps Claude Code CLI
  - You want to evaluate subscription-based vs API-key-based Anthropic access
title: Claude Max API Proxy
---

# Claude Max API 代理伺服器

**claude-max-api-proxy** 是一個社群工具，將你的 Claude Max/Pro 訂閱轉換成相容 OpenAI API 格式的端點。這讓你可以用任何支援 OpenAI API 格式的工具來使用你的訂閱。

<Warning>
此路徑僅為技術相容性。Anthropic 過去曾封鎖部分訂閱在 Claude Code 以外的使用。你必須自行判斷是否使用，並在依賴前確認 Anthropic 當前條款。
</Warning>

## 為什麼要使用？

| 方案            | 費用                                             | 適合用途                 |
| --------------- | ------------------------------------------------ | ------------------------ |
| Anthropic API   | 按 token 計費（Opus 輸入約 $15/M，輸出約 $75/M） | 生產環境應用、高流量     |
| Claude Max 訂閱 | $200/月 固定費用                                 | 個人使用、開發、無限使用 |

如果你有 Claude Max 訂閱，且想用 OpenAI 相容工具，這個代理可能在某些工作流程中降低成本。生產環境仍建議使用 API 金鑰以符合政策。

## 運作原理

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

此代理：

1. 接收 OpenAI 格式請求於 `http://localhost:3456/v1/chat/completions`
2. 轉換成 Claude Code CLI 指令
3. 回傳 OpenAI 格式回應（支援串流）

## 安裝

bash

# 需要 Node.js 20+ 與 Claude Code CLI

npm install -g claude-max-api-proxy

# 確認 Claude CLI 已驗證

claude --version

## 使用說明

### 啟動伺服器

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### 測試它

bash

# 健康檢查

curl http://localhost:3456/health

# 列出模型

curl http://localhost:3456/v1/models

# 聊天補全

curl http://localhost:3456/v1/chat/completions \
 -H "Content-Type: application/json" \
 -d '{
"model": "claude-opus-4",
"messages": [{"role": "user", "content": "Hello!"}]
}'

### 使用 OpenClaw

你可以將 OpenClaw 指向此代理作為自訂的 OpenAI 相容端點：

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

| 模型 ID           | 對應模型        |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## macOS 自動啟動

建立一個 LaunchAgent 以自動執行代理：

bash
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

## 連結

- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **Issues:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## 注意事項

- 這是一個 **社群工具**，非 Anthropic 或 OpenClaw 官方支援
- 需要有效的 Claude Max/Pro 訂閱，並且已透過 Claude Code CLI 完成認證
- 代理伺服器在本地執行，不會將資料傳送到任何第三方伺服器
- 完全支援串流回應

## 參考資料

- [Anthropic 提供者](/providers/anthropic) - 透過 Claude setup-token 或 API 金鑰的原生 OpenClaw 整合
- [OpenAI 提供者](/providers/openai) - 適用於 OpenAI/Codex 訂閱
