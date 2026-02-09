---
title: "Cloudflare AI Gateway"
summary: "Konfigurering av Cloudflare AI Gateway (autentisering + modellval)"
read_when:
  - Du vill använda Cloudflare AI Gateway med OpenClaw
  - Du behöver konto-ID, gateway-ID eller miljövariabeln för API-nyckel
---

# Cloudflare AI Gateway

Cloudflare AI Gateway sitter framför leverantör API:er och låter dig lägga till analys, caching och kontroller. För Anthropic, använder OpenClaw Anthropic Messages API genom din Gateway-slutpunkt.

- Leverantör: `cloudflare-ai-gateway`
- Bas-URL: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- Standardmodell: `cloudflare-ai-gateway/claude-sonnet-4-5`
- API-nyckel: `CLOUDFLARE_AI_GATEWAY_API_KEY` (din leverantörs-API-nyckel för begäranden via Gateway)

För Anthropic-modeller använder du din Anthropic API-nyckel.

## Snabbstart

1. Ställ in leverantörens API-nyckel och Gateway-detaljer:

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. Ställ in en standardmodell:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },
    },
  },
}
```

## Icke-interaktivt exempel

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## Autentiserade gateways

Om du har aktiverat Gateway-autentisering i Cloudflare, lägg till rubriken `cf-aig-authorization` (detta är utöver din leverantörs API-nyckel).

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

## Miljönotering

Om Gateway körs som en daemon (launchd/systemd), se till att `CLOUDFLARE_AI_GATEWAY_API_KEY` är tillgänglig för den processen (till exempel i `~/.openclaw/.env` eller via `env.shellEnv`).
