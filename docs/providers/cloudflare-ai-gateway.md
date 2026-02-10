---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Cloudflare AI Gateway"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Cloudflare AI Gateway setup (auth + model selection)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to use Cloudflare AI Gateway with OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need the account ID, gateway ID, or API key env var（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Cloudflare AI Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Cloudflare AI Gateway sits in front of provider APIs and lets you add analytics, caching, and controls. For Anthropic, OpenClaw uses the Anthropic Messages API through your Gateway endpoint.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider: `cloudflare-ai-gateway`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Base URL: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default model: `cloudflare-ai-gateway/claude-sonnet-4-5`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- API key: `CLOUDFLARE_AI_GATEWAY_API_KEY` (your provider API key for requests through the Gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For Anthropic models, use your Anthropic API key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Set the provider API key and Gateway details:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Set a default model:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Non-interactive example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --mode local \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --auth-choice cloudflare-ai-gateway-api-key \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --cloudflare-ai-gateway-account-id "your-account-id" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Authenticated gateways（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you enabled Gateway authentication in Cloudflare, add the `cf-aig-authorization` header (this is in addition to your provider API key).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    providers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "cloudflare-ai-gateway": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        headers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "cf-aig-authorization": "Bearer <cloudflare-ai-gateway-token>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Environment note（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the Gateway runs as a daemon (launchd/systemd), make sure `CLOUDFLARE_AI_GATEWAY_API_KEY` is available to that process (for example, in `~/.openclaw/.env` or via `env.shellEnv`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
