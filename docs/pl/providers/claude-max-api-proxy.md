---
summary: "Używaj subskrypcji Claude Max/Pro jako punktu końcowego API zgodnego z OpenAI"
read_when:
  - Chcesz używać subskrypcji Claude Max z narzędziami zgodnymi z OpenAI
  - Chcesz lokalny serwer API, który opakowuje CLI Claude Code
  - Chcesz zaoszczędzić pieniądze, korzystając z subskrypcji zamiast kluczy API
title: "Proxy API Claude Max"
---

# Proxy API Claude Max

**claude-max-api-proxy** to narzędzie społecznościowe, które udostępnia Twoją subskrypcję Claude Max/Pro jako punkt końcowy API zgodny z OpenAI. Pozwala to używać subskrypcji z dowolnym narzędziem obsługującym format API OpenAI.

## Dlaczego warto z tego korzystać?

| Podejście              | Koszt                                                                                               | Najlepsze zastosowanie                        |
| ---------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| API Anthropic          | Płatność za token (~15 USD/M wejścia, 75 USD/M wyjścia dla Opus) | Aplikacje produkcyjne, duży wolumen           |
| Subskrypcja Claude Max | 200 USD/miesiąc ryczałt                                                                             | Użytek osobisty, rozwój, nielimitowane użycie |

Jeśli masz subskrypcję Claude Max i chcesz używać jej z narzędziami zgodnymi z OpenAI, ten proxy może pozwolić na znaczące oszczędności.

## Jak to działa

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

Proxy:

1. Akceptuje żądania w formacie OpenAI pod adresem `http://localhost:3456/v1/chat/completions`
2. Konwertuje je na polecenia CLI Claude Code
3. Zwraca odpowiedzi w formacie OpenAI (obsługiwane strumieniowanie)

## Instalacja

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## Użycie

### Uruchomienie serwera

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### Test

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

### Z OpenClaw

Możesz wskazać w OpenClaw proxy jako niestandardowy punkt końcowy zgodny z OpenAI:

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

## Dostępne modele

| ID modelu         | Mapowanie       |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## Automatyczny start na macOS

Utwórz LaunchAgent, aby uruchamiać proxy automatycznie:

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

## Linki

- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **Zgłoszenia problemów:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## Uwagi

- To **narzędzie społecznościowe**, nieoficjalnie wspierane przez Anthropic ani OpenClaw
- Wymaga aktywnej subskrypcji Claude Max/Pro z uwierzytelnionym CLI Claude Code
- Proxy działa lokalnie i nie wysyła danych do żadnych serwerów stron trzecich
- Odpowiedzi strumieniowane są w pełni obsługiwane

## Zobacz także

- [Dostawca Anthropic](/providers/anthropic) – Natywna integracja OpenClaw z Claude przy użyciu setup-token lub kluczy API
- [Dostawca OpenAI](/providers/openai) – Dla subskrypcji OpenAI/Codex
