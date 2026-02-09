---
summary: "Gebruik een Claude Max/Pro-abonnement als een OpenAI-compatibel API-eindpunt"
read_when:
  - Je wilt een Claude Max-abonnement gebruiken met OpenAI-compatibele tools
  - Je wilt een lokale API-server die de Claude Code CLI omwikkelt
  - Je wilt geld besparen door een abonnement te gebruiken in plaats van API-sleutels
title: "Claude Max API-proxy"
---

# Claude Max API-proxy

**claude-max-api-proxy** is een communitytool die je Claude Max/Pro-abonnement blootstelt als een OpenAI-compatibel API-eindpunt. Dit stelt je in staat om je abonnement te gebruiken met elke tool die het OpenAI API-formaat ondersteunt.

## Waarom dit gebruiken?

| Aanpak                | Kosten                                                                                      | Het meest geschikt voor                              |
| --------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Anthropic API         | Betalen per token (~$15/M input, $75/M output voor Opus) | Productie-apps, hoog volume                          |
| Claude Max-abonnement | $200/maand vast                                                                             | Persoonlijk gebruik, ontwikkeling, onbeperkt gebruik |

Als je een Claude Max-abonnement hebt en dit wilt gebruiken met OpenAI-compatibele tools, kan deze proxy je aanzienlijk geld besparen.

## Hoe het werkt

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

De proxy:

1. Accepteert OpenAI-formaat verzoeken op `http://localhost:3456/v1/chat/completions`
2. Zet deze om naar Claude Code CLI-opdrachten
3. Geeft antwoorden terug in OpenAI-formaat (streaming ondersteund)

## Installatie

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## Gebruik

### Start de server

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### Test het

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

### Met OpenClaw

Je kunt OpenClaw naar de proxy laten wijzen als een aangepaste OpenAI-compatibele endpoint:

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

## Beschikbare modellen

| Model-ID          | Kaarten aan     |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## Automatisch starten op macOS

Maak een LaunchAgent aan om de proxy automatisch te laten draaien:

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

## Notities

- Dit is een **communitytool**, niet officieel ondersteund door Anthropic of OpenClaw
- Vereist een actief Claude Max/Pro-abonnement met geauthenticeerde Claude Code CLI
- De proxy draait lokaal en stuurt geen gegevens naar servers van derden
- Streaming-antwoorden worden volledig ondersteund

## Zie ook

- [Anthropic provider](/providers/anthropic) - Native OpenClaw-integratie met Claude setup-token of API-sleutels
- [OpenAI provider](/providers/openai) - Voor OpenAI/Codex-abonnementen
