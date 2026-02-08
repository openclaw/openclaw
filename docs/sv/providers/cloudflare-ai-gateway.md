---
title: "Cloudflare AI Gateway"
summary: "Konfigurering av Cloudflare AI Gateway (autentisering + modellval)"
read_when:
  - Du vill använda Cloudflare AI Gateway med OpenClaw
  - Du behöver konto-ID, gateway-ID eller miljövariabeln för API-nyckel
x-i18n:
  source_path: providers/cloudflare-ai-gateway.md
  source_hash: db77652c37652ca2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:07Z
---

# Cloudflare AI Gateway

Cloudflare AI Gateway ligger framför leverantörernas API:er och låter dig lägga till analys, cachelagring och kontroller. För Anthropic använder OpenClaw Anthropic Messages API via din Gateway-slutpunkt.

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
