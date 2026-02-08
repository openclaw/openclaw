---
title: "Cloudflare AI Gateway"
summary: "Setup ng Cloudflare AI Gateway (auth + pagpili ng model)"
read_when:
  - Gusto mong gamitin ang Cloudflare AI Gateway sa OpenClaw
  - Kailangan mo ang account ID, gateway ID, o API key env var
x-i18n:
  source_path: providers/cloudflare-ai-gateway.md
  source_hash: db77652c37652ca2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:45Z
---

# Cloudflare AI Gateway

Ang Cloudflare AI Gateway ay nasa harap ng mga provider API at nagbibigay-daan sa pagdagdag ng analytics, caching, at mga kontrol. Para sa Anthropic, ginagamit ng OpenClaw ang Anthropic Messages API sa pamamagitan ng iyong Gateway endpoint.

- Provider: `cloudflare-ai-gateway`
- Base URL: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- Default model: `cloudflare-ai-gateway/claude-sonnet-4-5`
- API key: `CLOUDFLARE_AI_GATEWAY_API_KEY` (ang provider API key mo para sa mga request na dumadaan sa Gateway)

Para sa mga Anthropic model, gamitin ang iyong Anthropic API key.

## Mabilis na pagsisimula

1. Itakda ang provider API key at mga detalye ng Gateway:

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. Magtakda ng default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },
    },
  },
}
```

## Halimbawa (non-interactive)

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## Mga Gateway na may authentication

Kung pinagana mo ang Gateway authentication sa Cloudflare, idagdag ang `cf-aig-authorization` header (dagdag ito sa iyong provider API key).

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

## Tala sa environment

Kung tumatakbo ang Gateway bilang daemon (launchd/systemd), tiyaking available ang `CLOUDFLARE_AI_GATEWAY_API_KEY` sa prosesong iyon (halimbawa, sa `~/.openclaw/.env` o sa pamamagitan ng `env.shellEnv`).
