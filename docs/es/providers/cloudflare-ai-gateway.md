---
title: "Gateway de IA de Cloudflare"
summary: "Configuración de Cloudflare AI Gateway (autenticación + selección de modelo)"
read_when:
  - Quiere usar Cloudflare AI Gateway con OpenClaw
  - Necesita el ID de la cuenta, el ID del Gateway o la variable de entorno de la clave de API
---

# Gateway de IA de Cloudflare

Cloudflare AI Gateway se sitúa delante de las API de los proveedores y le permite añadir analítica, caché y controles. Para Anthropic, OpenClaw utiliza la API de Anthropic Messages a través del endpoint de su Gateway.

- Proveedor: `cloudflare-ai-gateway`
- URL base: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- Modelo predeterminado: `cloudflare-ai-gateway/claude-sonnet-4-5`
- Clave de API: `CLOUDFLARE_AI_GATEWAY_API_KEY` (su clave de API del proveedor para solicitudes a través del Gateway)

Para los modelos de Anthropic, use su clave de API de Anthropic.

## Inicio rápido

1. Configure la clave de API del proveedor y los detalles del Gateway:

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. Configure un modelo predeterminado:

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

Si habilitó la autenticación del Gateway en Cloudflare, agregue el encabezado `cf-aig-authorization` (esto es adicional a su clave de API del proveedor).

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

## Nota sobre el entorno

Si el Gateway se ejecuta como un daemon (launchd/systemd), asegúrese de que `CLOUDFLARE_AI_GATEWAY_API_KEY` esté disponible para ese proceso (por ejemplo, en `~/.openclaw/.env` o mediante `env.shellEnv`).
