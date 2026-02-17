---
summary: "Usa la suscripción de Claude Max/Pro como un endpoint de API compatible con OpenAI"
read_when:
  - Quieres usar la suscripción de Claude Max con herramientas compatibles con OpenAI
  - Quieres un servidor API local que envuelva Claude Code CLI
  - Quieres ahorrar dinero usando la suscripción en lugar de claves API
title: "Claude Max API Proxy"
---

# Claude Max API Proxy

**claude-max-api-proxy** es una herramienta comunitaria que expone tu suscripción de Claude Max/Pro como un endpoint de API compatible con OpenAI. Esto te permite usar tu suscripción con cualquier herramienta que soporte el formato de API de OpenAI.

## ¿Por qué usar esto?

| Enfoque                | Costo                                                   | Mejor para                               |
| ---------------------- | ------------------------------------------------------- | ---------------------------------------- |
| API de Anthropic       | Pago por token (~$15/M entrada, $75/M salida para Opus) | Aplicaciones de producción, alto volumen |
| Suscripción Claude Max | $200/mes fijo                                           | Uso personal, desarrollo, uso ilimitado  |

Si tienes una suscripción de Claude Max y quieres usarla con herramientas compatibles con OpenAI, este proxy puede ahorrarte dinero significativo.

## Cómo funciona

```
Tu App → claude-max-api-proxy → Claude Code CLI → Anthropic (vía suscripción)
     (formato OpenAI)              (convierte formato)      (usa tu inicio de sesión)
```

El proxy:

1. Acepta solicitudes en formato OpenAI en `http://localhost:3456/v1/chat/completions`
2. Las convierte en comandos de Claude Code CLI
3. Devuelve respuestas en formato OpenAI (streaming soportado)

## Instalación

```bash
# Requiere Node.js 20+ y Claude Code CLI
npm install -g claude-max-api-proxy

# Verifica que Claude CLI esté autenticado
claude --version
```

## Uso

### Iniciar el servidor

```bash
claude-max-api
# El servidor corre en http://localhost:3456
```

### Pruébalo

```bash
# Verificación de salud
curl http://localhost:3456/health

# Listar modelos
curl http://localhost:3456/v1/models

# Completación de chat
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "¡Hola!"}]
  }'
```

### Con OpenClaw

Puedes apuntar OpenClaw al proxy como un endpoint personalizado compatible con OpenAI:

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

| ID del modelo     | Mapea a         |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## Inicio automático en macOS

Crea un LaunchAgent para ejecutar el proxy automáticamente:

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

- Esta es una **herramienta comunitaria**, no está soportada oficialmente por Anthropic u OpenClaw
- Requiere una suscripción activa de Claude Max/Pro con Claude Code CLI autenticado
- El proxy se ejecuta localmente y no envía datos a servidores de terceros
- Las respuestas en streaming están completamente soportadas

## Ver también

- [Proveedor Anthropic](/es-ES/providers/anthropic) - Integración nativa de OpenClaw con token de configuración de Claude o claves API
- [Proveedor OpenAI](/es-ES/providers/openai) - Para suscripciones de OpenAI/Codex
