---
title: "Vercel AI Gateway"
summary: "Configuración de Vercel AI Gateway (autenticación + selección de modelo)"
read_when:
  - Quieres usar Vercel AI Gateway con OpenClaw
  - Necesitas la variable de entorno de clave de API o la opción de autenticación CLI
---

# Vercel AI Gateway

El [Vercel AI Gateway](https://vercel.com/ai-gateway) proporciona una API unificada para acceder a cientos de modelos mediante un único endpoint.

- Proveedor: `vercel-ai-gateway`
- Autenticación: `AI_GATEWAY_API_KEY`
- API: Compatible con Anthropic Messages

## Inicio rápido

1. Establece la clave de API (recomendado: almacénala para el Gateway):

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. Establece un modelo por defecto:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## Ejemplo no interactivo

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## Nota sobre entorno

Si el Gateway se ejecuta como un daemon (launchd/systemd), asegúrate de que `AI_GATEWAY_API_KEY`
esté disponible para ese proceso (por ejemplo, en `~/.openclaw/.env` o mediante
`env.shellEnv`).
