---
summary: "Brug Claude Max/Pro-abonnement som et OpenAI-kompatibelt API-endpoint"
read_when:
  - Du vil bruge Claude Max-abonnement med OpenAI-kompatible værktøjer
  - Du vil have en lokal API-server, der wrapper Claude Code CLI
  - Du vil spare penge ved at bruge abonnement i stedet for API-nøgler
title: "Claude Max API-proxy"
---

# Claude Max API-proxy

**claude-max-api-proxy** er et fællesskabsværktøj, der udsætter dit Claude Max/Pro-abonnement som et OpenAI-kompatibelt API-endepunkt. Dette giver dig mulighed for at bruge dit abonnement med ethvert værktøj, der understøtter OpenAI API-format.

## Hvorfor bruge dette?

| Tilgang               | Omkostning                                                                                               | Bedst til                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Anthropic API         | Betal pr. token (~$15/M input, $75/M output for Opus) | Produktionsapps, høj volumen               |
| Claude Max-abonnement | $200/måned fast                                                                                          | Personlig brug, udvikling, ubegrænset brug |

Hvis du har et Claude Max-abonnement og vil bruge det med OpenAI-kompatible værktøjer, kan denne proxy spare dig for betydelige beløb.

## Sådan virker det

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

Proxyen:

1. Accepterer forespørgsler i OpenAI-format på `http://localhost:3456/v1/chat/completions`
2. Konverterer dem til Claude Code CLI-kommandoer
3. Returnerer svar i OpenAI-format (streaming understøttes)

## Installation

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## Brug

### Start serveren

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### Test den

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

### Med OpenClaw

Du kan pege OpenClaw på proxyen som et tilpasset OpenAI-kompatibelt endpoint:

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

## Tilgængelige modeller

| Model-ID          | Mapper til      |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## Automatisk start på macOS

Opret en LaunchAgent for at køre proxyen automatisk:

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

## Links

- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **Issues:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## Noter

- Dette er et **community-værktøj**, ikke officielt understøttet af Anthropic eller OpenClaw
- Kræver et aktivt Claude Max/Pro-abonnement med Claude Code CLI autentificeret
- Proxyen kører lokalt og sender ikke data til tredjepartsservere
- Streaming-svar understøttes fuldt ud

## Se også

- [Anthropic-udbyder](/providers/anthropic) - Native OpenClaw-integration med Claude setup-token eller API-nøgler
- [OpenAI-udbyder](/providers/openai) - Til OpenAI/Codex-abonnementer
