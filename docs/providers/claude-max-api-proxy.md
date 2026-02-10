---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Use Claude Max/Pro subscription as an OpenAI-compatible API endpoint"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to use Claude Max subscription with OpenAI-compatible tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want a local API server that wraps Claude Code CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to save money by using subscription instead of API keys（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Claude Max API Proxy"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Claude Max API Proxy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**claude-max-api-proxy** is a community tool that exposes your Claude Max/Pro subscription as an OpenAI-compatible API endpoint. This allows you to use your subscription with any tool that supports the OpenAI API format.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Why Use This?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Approach                | Cost                                                | Best For                                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | --------------------------------------------------- | ------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Anthropic API           | Pay per token (~$15/M input, $75/M output for Opus) | Production apps, high volume               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Claude Max subscription | $200/month flat                                     | Personal use, development, unlimited usage |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you have a Claude Max subscription and want to use it with OpenAI-compatible tools, this proxy can save you significant money.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How It Works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     (OpenAI format)              (converts format)      (uses your login)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The proxy:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Accepts OpenAI-format requests at `http://localhost:3456/v1/chat/completions`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Converts them to Claude Code CLI commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Returns responses in OpenAI format (streaming supported)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Installation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Requires Node.js 20+ and Claude Code CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
npm install -g claude-max-api-proxy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Verify Claude CLI is authenticated（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
claude --version（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Start the server（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
claude-max-api（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Server runs at http://localhost:3456（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Test it（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Health check（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl http://localhost:3456/health（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# List models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl http://localhost:3456/v1/models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Chat completion（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl http://localhost:3456/v1/chat/completions \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Content-Type: application/json" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -d '{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "model": "claude-opus-4",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "messages": [{"role": "user", "content": "Hello!"}]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### With OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can point OpenClaw at the proxy as a custom OpenAI-compatible endpoint:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    OPENAI_API_KEY: "not-needed",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    OPENAI_BASE_URL: "http://localhost:3456/v1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "openai/claude-opus-4" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Available Models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Model ID          | Maps To         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------- | --------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `claude-opus-4`   | Claude Opus 4   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `claude-sonnet-4` | Claude Sonnet 4 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `claude-haiku-4`  | Claude Haiku 4  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Auto-Start on macOS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create a LaunchAgent to run the proxy automatically:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cat > ~/Library/LaunchAgents/com.claude-max-api.plist << 'EOF'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<?xml version="1.0" encoding="UTF-8"?>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<plist version="1.0">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<dict>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <key>Label</key>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <string>com.claude-max-api</string>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <key>RunAtLoad</key>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <true/>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <key>KeepAlive</key>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <true/>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <key>ProgramArguments</key>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <array>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <string>/usr/local/bin/node</string>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <string>/usr/local/lib/node_modules/claude-max-api-proxy/dist/server/standalone.js</string>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </array>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <key>EnvironmentVariables</key>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <dict>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <key>PATH</key>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <string>/usr/local/bin:/opt/homebrew/bin:~/.local/bin:/usr/bin:/bin</string>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </dict>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</dict>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</plist>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
EOF（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-max-api.plist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Links（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Issues:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- This is a **community tool**, not officially supported by Anthropic or OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requires an active Claude Max/Pro subscription with Claude Code CLI authenticated（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The proxy runs locally and does not send data to any third-party servers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Streaming responses are fully supported（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## See Also（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Anthropic provider](/providers/anthropic) - Native OpenClaw integration with Claude setup-token or API keys（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [OpenAI provider](/providers/openai) - For OpenAI/Codex subscriptions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
