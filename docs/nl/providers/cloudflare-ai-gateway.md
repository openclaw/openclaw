---
title: "Cloudflare AI Gateway"
summary: "Cloudflare AI Gateway-installatie (authenticatie + modelselectie)"
read_when:
  - Je wilt Cloudflare AI Gateway gebruiken met OpenClaw
  - Je hebt de account-ID, gateway-ID of API-sleutel-omgevingsvariabele nodig
---

# Cloudflare AI Gateway

Cloudflare AI Gateway staat vóór provider-API’s en stelt je in staat analytics, caching en controles toe te voegen. Voor Anthropic gebruikt OpenClaw de Anthropic Messages API via je Gateway-eindpunt.

- Provider: `cloudflare-ai-gateway`
- Basis-URL: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- Standaardmodel: `cloudflare-ai-gateway/claude-sonnet-4-5`
- API-sleutel: `CLOUDFLARE_AI_GATEWAY_API_KEY` (je provider-API-sleutel voor verzoeken via de Gateway)

Voor Anthropic-modellen gebruik je je Anthropic API-sleutel.

## Snelle start

1. Stel de provider-API-sleutel en Gateway-gegevens in:

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. Stel een standaardmodel in:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },
    },
  },
}
```

## Niet-interactief voorbeeld

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## Geauthenticeerde gateways

Als je Gateway-authenticatie in Cloudflare hebt ingeschakeld, voeg dan de header `cf-aig-authorization` toe (dit komt bovenop je provider-API-sleutel).

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

## Omgevingsnotitie

Als de Gateway als daemon draait (launchd/systemd), zorg er dan voor dat `CLOUDFLARE_AI_GATEWAY_API_KEY` beschikbaar is voor dat proces (bijvoorbeeld in `~/.openclaw/.env` of via `env.shellEnv`).
