---
summary: "Gamitin ang Claude Max/Pro subscription bilang isang OpenAI-compatible na API endpoint"
read_when:
  - Gusto mong gamitin ang Claude Max subscription kasama ng mga OpenAI-compatible na tool
  - Gusto mo ng lokal na API server na bumabalot sa Claude Code CLI
  - Gusto mong makatipid sa pamamagitan ng paggamit ng subscription sa halip na mga API key
title: "Claude Max API Proxy"
---

# Claude Max API Proxy

**claude-max-api-proxy** is a community tool that exposes your Claude Max/Pro subscription as an OpenAI-compatible API endpoint. This allows you to use your subscription with any tool that supports the OpenAI API format.

## Bakit Ito Gagamitin?

| Paraan                  | Gastos                                                                                        | Pinakamainam Para Sa                                     |
| ----------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Anthropic API           | Bayad kada token (~$15/M input, $75/M output para sa Opus) | Production apps, mataas na volume                        |
| Claude Max subscription | $200/buwan na flat                                                                            | Personal na gamit, development, walang limit na paggamit |

Kung mayroon kang Claude Max subscription at gusto mo itong gamitin sa mga OpenAI-compatible na tool, makakatipid ka ng malaking halaga gamit ang proxy na ito.

## Paano Ito Gumagana

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

Ang proxy ay:

1. Tumatanggap ng mga request na nasa OpenAI format sa `http://localhost:3456/v1/chat/completions`
2. Kino-convert ang mga ito sa mga command ng Claude Code CLI
3. Ibinabalik ang mga response sa OpenAI format (may suportang streaming)

## Pag-install

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## Paggamit

### Simulan ang server

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### Subukan ito

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

### Gamit ang OpenClaw

Maaari mong ituro ang OpenClaw sa proxy bilang isang custom na OpenAI-compatible endpoint:

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

## Mga Available na Model

| Model ID          | Katumbas        |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## Auto-Start sa macOS

Gumawa ng LaunchAgent para awtomatikong patakbuhin ang proxy:

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

## Mga Link

- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **Issues:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## Mga Tala

- Isa itong **community tool**, at hindi opisyal na sinusuportahan ng Anthropic o OpenClaw
- Nangangailangan ng aktibong Claude Max/Pro subscription na may naka-authenticate na Claude Code CLI
- Lokal na tumatakbo ang proxy at hindi nagpapadala ng data sa anumang third-party na server
- Ganap na sinusuportahan ang streaming responses

## Tingnan Din

- [Anthropic provider](/providers/anthropic) - Native na OpenClaw integration gamit ang Claude setup-token o mga API key
- [OpenAI provider](/providers/openai) - Para sa mga OpenAI/Codex subscription
