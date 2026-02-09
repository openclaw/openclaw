---
summary: "Use la suscripción Claude Max/Pro como un endpoint de API compatible con OpenAI"
read_when:
  - Quiere usar la suscripción Claude Max con herramientas compatibles con OpenAI
  - Quiere un servidor de API local que envuelva la CLI de Claude Code
  - Quiere ahorrar dinero usando una suscripción en lugar de claves de API
title: "Proxy de API de Claude Max"
---

# Proxy de API de Claude Max

**claude-max-api-proxy** es una herramienta de la comunidad que expone su suscripción Claude Max/Pro como un endpoint de API compatible con OpenAI. Esto le permite usar su suscripción con cualquier herramienta que admita el formato de la API de OpenAI.

## ¿Por qué usar esto?

| Enfoque                | Costo                                                                                            | Ideal para                              |
| ---------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------- |
| API de Anthropic       | Pago por token (~$15/M de entrada, $75/M de salida para Opus) | Apps de producción, alto volumen        |
| Suscripción Claude Max | $200/mes fijo                                                                                    | Uso personal, desarrollo, uso ilimitado |

Si tiene una suscripción Claude Max y quiere usarla con herramientas compatibles con OpenAI, este proxy puede ahorrarle una cantidad significativa de dinero.

## Cómo funciona

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

El proxy:

1. Acepta solicitudes en formato OpenAI en `http://localhost:3456/v1/chat/completions`
2. Las convierte en comandos de la CLI de Claude Code
3. Devuelve respuestas en formato OpenAI (streaming compatible)

## Instalación

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## Uso

### Iniciar el servidor

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### Probarlo

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

### Con OpenClaw

Puede apuntar OpenClaw al proxy como un endpoint personalizado compatible con OpenAI:

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

## Modelos disponibles

| ID del modelo     | Mapas a         |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## Inicio automático en macOS

Cree un LaunchAgent para ejecutar el proxy automáticamente:

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

## Enlaces

- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **Issues:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## Notas

- Esta es una **herramienta de la comunidad**, no está oficialmente respaldada por Anthropic ni por OpenClaw
- Requiere una suscripción activa de Claude Max/Pro con la CLI de Claude Code autenticada
- El proxy se ejecuta localmente y no envía datos a servidores de terceros
- Las respuestas por streaming están totalmente soportadas

## Ver también

- [Proveedor de Anthropic](/providers/anthropic) - Integración nativa de OpenClaw con configuración mediante setup-token o claves de API
- [Proveedor de OpenAI](/providers/openai) - Para suscripciones de OpenAI/Codex
