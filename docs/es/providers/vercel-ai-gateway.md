---
title: "Vercel AI Gateway"
summary: "Configuración de Vercel AI Gateway (autenticación + selección de modelo)"
read_when:
  - Quiere usar Vercel AI Gateway con OpenClaw
  - Necesita la variable de entorno de la clave de API o la opción de autenticación de la CLI
---

# Vercel AI Gateway

El [Vercel AI Gateway](https://vercel.com/ai-gateway) proporciona una API unificada para acceder a cientos de modelos a través de un único endpoint.

- Proveedor: `vercel-ai-gateway`
- Autenticación: `AI_GATEWAY_API_KEY`
- API: compatible con Anthropic Messages

## Inicio rápido

1. Configure la clave de API (recomendado: guardarla para el Gateway):

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. Configure un modelo predeterminado:

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

## Nota sobre el entorno

Si el Gateway se ejecuta como un demonio (launchd/systemd), asegúrese de que `AI_GATEWAY_API_KEY`
esté disponible para ese proceso (por ejemplo, en `~/.openclaw/.env` o mediante
`env.shellEnv`).
