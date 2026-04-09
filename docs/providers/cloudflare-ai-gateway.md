---
title: "Cloudflare AI Gateway"
summary: "Cloudflare AI Gateway setup (auth + model selection)"
read_when:
  - You want to use Cloudflare AI Gateway with OpenClaw
  - You need the account ID, gateway ID, or API key env var
---

# Cloudflare AI Gateway

Cloudflare AI Gateway sits in front of provider APIs and lets you add analytics, caching, and controls. For Anthropic, OpenClaw uses the Anthropic Messages API through your Gateway endpoint.

- Provider: `cloudflare-ai-gateway`
- Base URL: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- Default model: `cloudflare-ai-gateway/claude-sonnet-4-5`
- API key: `CLOUDFLARE_AI_GATEWAY_API_KEY` (your provider API key for requests through the Gateway)

For Anthropic models, use your Anthropic API key.

## Quick start

1. Set the provider API key and Gateway details:

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. Set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },
    },
  },
}
```

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## Authenticated gateways

If you enabled Gateway authentication in Cloudflare, add the `cf-aig-authorization` header (this is in addition to your provider API key).

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

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `CLOUDFLARE_AI_GATEWAY_API_KEY` is available to that process (for example, in `~/.openclaw/.env` or via `env.shellEnv`).
