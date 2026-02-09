---
title: "Cloudflare AI Gateway"
summary: "Opsætning af Cloudflare AI Gateway (autentificering + modelvalg)"
read_when:
  - Du vil bruge Cloudflare AI Gateway med OpenClaw
  - Du har brug for konto-id, gateway-id eller API-nøgle-miljøvariabel
---

# Cloudflare AI Gateway

Cloudflare AI Gateway sidder foran udbyder API'er og lader dig tilføje analytics, caching, og kontrolelementer. For antropisk bruger OpenClaw antropiske beskeder API gennem din Gateway slutpunkt.

- Udbyder: `cloudflare-ai-gateway`
- Basis-URL: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- Standardmodel: `cloudflare-ai-gateway/claude-sonnet-4-5`
- API-nøgle: `CLOUDFLARE_AI_GATEWAY_API_KEY` (din udbyder-API-nøgle til forespørgsler gennem Gateway)

For Anthropic-modeller skal du bruge din Anthropic API-nøgle.

## Hurtig start

1. Angiv udbyderens API-nøgle og Gateway-detaljer:

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. Angiv en standardmodel:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },
    },
  },
}
```

## Ikke-interaktivt eksempel

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## Autentificerede gateways

Hvis du har aktiveret Gateway-autentificering i Cloudflare, skal du tilføje `cf-aig-authorization`-headeren (dette er ud over din udbyder-API-nøgle).

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

## Miljønote

Hvis Gateway kører som en daemon (launchd/systemd), skal du sikre, at `CLOUDFLARE_AI_GATEWAY_API_KEY` er tilgængelig for den proces (for eksempel i `~/.openclaw/.env` eller via `env.shellEnv`).
