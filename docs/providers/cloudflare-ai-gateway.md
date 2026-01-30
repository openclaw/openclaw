---
title: "Cloudflare AI Gateway"
summary: "Cloudflare AI Gateway setup (analytics, caching, rate limiting)"
read_when:
  - You want to use Cloudflare AI Gateway with OpenClaw
  - You need analytics, caching, or rate limiting for AI requests
---
# Cloudflare AI Gateway

The [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) provides visibility and control over your AI applications with features like analytics, logging, caching, rate limiting, request retries, and model fallback.

- Provider: `cloudflare-ai-gateway`
- Auth: Account ID + Gateway ID + API Key (optional for unauthenticated gateway)
- API: Anthropic Messages compatible (via provider-specific endpoints)

## Quick start

1) Set up your Cloudflare AI Gateway credentials:

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

You'll be prompted to enter:
- Cloudflare Account ID (found in your Cloudflare dashboard)
- Cloudflare AI Gateway ID (the name you give your gateway)
- Cloudflare AI Gateway API key (optional, only needed for authenticated gateways)

2) Set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/anthropic/claude-sonnet-4-5" }
    }
  }
}
```

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "your-api-key"
```

## Setting up your Cloudflare AI Gateway

1. Log into the [Cloudflare dashboard](https://dash.cloudflare.com/)
2. Go to **AI** > **AI Gateway**
3. Select **Create Gateway**
4. Enter your **Gateway name** (this becomes your gateway ID)
5. (Optional) Enable authentication for added security

## Features

### Analytics
View metrics such as the number of requests, tokens, and cost of running your application.

### Caching
Serve requests directly from Cloudflare's cache for faster requests and cost savings.

### Rate Limiting
Control how your application scales by limiting the number of requests.

### Request Retry and Fallback
Improve resilience by defining request retry and model fallbacks in case of an error.

## Supported Providers

Cloudflare AI Gateway works with:
- OpenAI
- Anthropic (Claude)
- Google AI Studio (Gemini)
- Azure OpenAI
- AWS Bedrock
- Workers AI
- And many more

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure credentials are available to that process (for example, in `~/.openclaw/.env` or via `env.shellEnv`).

You can also set environment variables:
- `CLOUDFLARE_AI_GATEWAY_API_KEY` - Your Cloudflare AI Gateway API key
- Account ID and Gateway ID are stored in the auth profile metadata

## Learn more

- [Cloudflare AI Gateway Documentation](https://developers.cloudflare.com/ai-gateway/)
- [Getting Started Guide](https://developers.cloudflare.com/ai-gateway/get-started/)
- [Authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
