---
title: "Cloudflare AI Gateway"
summary: "Configuración de Cloudflare AI Gateway (autenticación + selección de modelo)"
read_when:
  - Quieres usar Cloudflare AI Gateway con OpenClaw
  - Necesitas el ID de cuenta, ID de gateway o variable de entorno de clave de API
---

# Cloudflare AI Gateway

Cloudflare AI Gateway se sitúa frente a las APIs de proveedores y te permite agregar analíticas, caché y controles. Para Anthropic, OpenClaw usa la API de Anthropic Messages mediante tu endpoint de Gateway.

- Proveedor: `cloudflare-ai-gateway`
- URL base: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- Modelo por defecto: `cloudflare-ai-gateway/claude-sonnet-4-5`
- Clave de API: `CLOUDFLARE_AI_GATEWAY_API_KEY` (tu clave de API del proveedor para solicitudes mediante el Gateway)

Para modelos de Anthropic, usa tu clave de API de Anthropic.

## Inicio rápido

1. Establece la clave de API del proveedor y los detalles del Gateway:

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. Establece un modelo por defecto:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },
    },
  },
}
```

## Ejemplo no interactivo

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## Gateways autenticados

Si habilitaste la autenticación del Gateway en Cloudflare, agrega el encabezado `cf-aig-authorization` (esto es adicional a tu clave de API del proveedor).

```json5
{
  models: {
    providers: {
      "cloudflare-ai-gateway": {
        headers: {
          "cf-aig-authorization": "Bearer <cloudflare-ai-gateway-token>",
        },
      },
    },
  },
}
```

## Nota sobre entorno

Si el Gateway se ejecuta como un daemon (launchd/systemd), asegúrate de que `CLOUDFLARE_AI_GATEWAY_API_KEY` esté disponible para ese proceso (por ejemplo, en `~/.openclaw/.env` o mediante `env.shellEnv`).
