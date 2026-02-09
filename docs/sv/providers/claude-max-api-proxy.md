---
summary: "Använd Claude Max/Pro-prenumeration som en OpenAI-kompatibel API-ändpunkt"
read_when:
  - Du vill använda Claude Max-prenumeration med OpenAI-kompatibla verktyg
  - Du vill ha en lokal API-server som omsluter Claude Code CLI
  - Du vill spara pengar genom att använda en prenumeration i stället för API-nycklar
title: "Claude Max API-proxy"
---

# Claude Max API-proxy

**claude-max-api-proxy** är ett gemenskapsverktyg som exponerar din Claude Max/Pro-prenumeration som en OpenAI-kompatibel API-slutpunkt. Detta gör att du kan använda din prenumeration med alla verktyg som stöder OpenAI API-format.

## Varför använda detta?

| Tillvägagångssätt        | Kostnad                                                                                    | Bäst för                                           |
| ------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Anthropic API            | Betala per token (~$15/M indata, $75/M utdata för Opus) | Produktionsappar, hög volym                        |
| Claude Max-prenumeration | $200/månad fast                                                                            | Personligt bruk, utveckling, obegränsad användning |

Om du har en Claude Max-prenumeration och vill använda den med OpenAI-kompatibla verktyg kan denna proxy spara dig betydande kostnader.

## Hur det fungerar

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

Proxyn:

1. Tar emot förfrågningar i OpenAI-format på `http://localhost:3456/v1/chat/completions`
2. Konverterar dem till Claude Code CLI-kommandon
3. Returnerar svar i OpenAI-format (streaming stöds)

## Installation

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## Användning

### Starta servern

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### Testa den

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

Du kan peka OpenClaw mot proxyn som en anpassad OpenAI-kompatibel ändpunkt:

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

## Tillgängliga modeller

| Modell-ID         | Mappas till     |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## Autostart på macOS

Skapa en LaunchAgent för att köra proxyn automatiskt:

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

## Länkar

- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **Issues:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## Noteringar

- Detta är ett **communityverktyg** och stöds inte officiellt av Anthropic eller OpenClaw
- Kräver en aktiv Claude Max/Pro-prenumeration med Claude Code CLI autentiserad
- Proxyn körs lokalt och skickar inte data till några tredjepartsservrar
- Strömmande svar stöds fullt ut

## Se även

- [Anthropic provider](/providers/anthropic) – Inbyggd OpenClaw-integration med Claude via setup-token eller API-nycklar
- [OpenAI provider](/providers/openai) – För OpenAI-/Codex-prenumerationer
