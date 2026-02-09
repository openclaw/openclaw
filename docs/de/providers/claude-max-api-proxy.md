---
summary: "„Verwenden Sie ein Claude-Max/Pro-Abonnement als OpenAI-kompatiblen API-Endpunkt“"
read_when:
  - Sie möchten ein Claude-Max-Abonnement mit OpenAI-kompatiblen Tools verwenden
  - Sie möchten einen lokalen API-Server, der die Claude Code CLI kapselt
  - Sie möchten Geld sparen, indem Sie ein Abonnement statt API-Schlüsseln verwenden
title: "Claude Max API Proxy"
---

# Claude Max API Proxy

**claude-max-api-proxy** ist ein Community-Tool, das Ihr Claude-Max/Pro-Abonnement als OpenAI-kompatiblen API-Endpunkt bereitstellt. Dadurch können Sie Ihr Abonnement mit jedem Tool verwenden, das das OpenAI-API-Format unterstützt.

## Warum dies verwenden?

| Ansatz                | Kosten                                                                                                                                     | Am besten geeignet für                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Anthropic API         | Zahlung pro Token (~15 $ pro Mio. Input, 75 $ pro Mio. Output für Opus) | Produktionsanwendungen, hohes Volumen                 |
| Claude-Max-Abonnement | 200 $/Monat pauschal                                                                                                                       | Persönliche Nutzung, Entwicklung, unbegrenzte Nutzung |

Wenn Sie ein Claude-Max-Abonnement haben und es mit OpenAI-kompatiblen Tools verwenden möchten, kann Ihnen dieser Proxy erheblich Geld sparen.

## Funktionsweise

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

Der Proxy:

1. Akzeptiert Anfragen im OpenAI-Format unter `http://localhost:3456/v1/chat/completions`
2. Konvertiert diese in Claude-Code-CLI-Befehle
3. Gibt Antworten im OpenAI-Format zurück (Streaming wird unterstützt)

## Installation

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## Nutzung

### Server starten

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### Testen

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

### Mit OpenClaw

Sie können OpenClaw so konfigurieren, dass der Proxy als benutzerdefinierter OpenAI-kompatibler Endpunkt verwendet wird:

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

## Verfügbare Modelle

| Modell-ID         | Karten zu       |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## Automatischer Start unter macOS

Erstellen Sie einen LaunchAgent, um den Proxy automatisch auszuführen:

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

## Hinweise

- Dies ist ein **Community-Tool** und wird weder von Anthropic noch von OpenClaw offiziell unterstützt
- Erfordert ein aktives Claude-Max/Pro-Abonnement mit authentifizierter Claude Code CLI
- Der Proxy läuft lokal und sendet keine Daten an Server von Drittanbietern
- Streaming-Antworten werden vollständig unterstützt

## Siehe auch

- [Anthropic-Anbieter](/providers/anthropic) – Native OpenClaw-Integration mit Claude-Setup-Token oder API-Schlüsseln
- [OpenAI-Anbieter](/providers/openai) – Für OpenAI-/Codex-Abonnements
