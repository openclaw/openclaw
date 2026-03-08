---
title: Deploy on Coolify
description: Deploy OpenClaw on Coolify with their native one-click service
---

# Coolify

Deploy OpenClaw on [Coolify](https://coolify.io) using their native one-click service. HTTPS, persistent storage, and authentication are handled automatically.

## Quick checklist

1. Select OpenClaw from Coolify's one-click services
2. Set your domain
3. Add at least one AI provider API key
4. Deploy

## What you need

- A Coolify instance (v4+) with a connected server
- A domain pointed at your Coolify server
- An API key from a [model provider](/providers)

## Deploy

1. In your Coolify dashboard, click **Add New Resource**
2. Select **OpenClaw** from the one-click services list
3. Set your **Domain** (e.g. `https://openclaw.example.com`)
4. Click **Deploy**

HTTPS certificates and persistent storage are configured automatically.

## Authentication

Coolify auto-generates three credentials on first deploy:

| Variable                 | Purpose                  |
| ------------------------ | ------------------------ |
| `AUTH_USERNAME`          | HTTP Basic Auth username |
| `AUTH_PASSWORD`          | HTTP Basic Auth password |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway API access token |

You'll be prompted for Basic Auth credentials when accessing the Control UI in your browser. Find the generated values in the **Environment Variables** tab.

## AI provider configuration

Add at least one provider API key in the **Environment Variables** tab:

| Variable             | Provider       |
| -------------------- | -------------- |
| `ANTHROPIC_API_KEY`  | Anthropic      |
| `OPENAI_API_KEY`     | OpenAI         |
| `GEMINI_API_KEY`     | Google Gemini  |
| `OPENROUTER_API_KEY` | OpenRouter     |
| `GROQ_API_KEY`       | Groq           |
| `MISTRAL_API_KEY`    | Mistral        |
| `XAI_API_KEY`        | xAI            |
| `CEREBRAS_API_KEY`   | Cerebras       |
| `OLLAMA_BASE_URL`    | Ollama (local) |

For Amazon Bedrock, set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION`.

Set a default model with `OPENCLAW_PRIMARY_MODEL` (e.g. `anthropic/claude-sonnet-4-5`).

**Proxy providers:** When using proxy services like OpenRouter, prefix model names with the provider path: `openrouter/google/gemini-2.5-flash`.

## Subscription-based auth

If you have an Anthropic or OpenAI subscription, you can authenticate via CLI instead of API keys. Open a terminal in Coolify and run:

```bash
openclaw models auth login --provider anthropic
# or
openclaw models auth login --provider openai
```

Verify with `openclaw models status`. You can also run `openclaw onboard` for a guided setup.

## Browser configuration

The `/browser` endpoint provides remote browser access via Chrome DevTools Protocol (CDP) — useful for OAuth flows, 2FA, captcha solving, and authenticated web scraping.

| Variable                   | Default     | Description               |
| -------------------------- | ----------- | ------------------------- |
| `BROWSER_DEFAULT_PROFILE`  | `openclaw`  | Browser profile name      |
| `BROWSER_SNAPSHOT_MODE`    | `efficient` | Snapshot persistence mode |
| `BROWSER_EVALUATE_ENABLED` | `true`      | JavaScript evaluation     |

Browser sessions persist across restarts.

## Set up channels

Connect messaging channels (Telegram, Discord, Slack, WhatsApp) through the Control UI or by editing the configuration file. See [Channels](/channels) for setup details.

## Troubleshooting

- **Can't find OpenClaw in one-click services**: Update your Coolify instance to the latest version. OpenClaw was added as a native service recently.

- **"Untrusted proxy" log warnings**: The gateway logs warnings when requests arrive through an unconfigured proxy. This does not affect functionality. To suppress, add `gateway.trustedProxies` to your [configuration](/gateway/security#reverse-proxy-configuration) with the proxy IP.

## Updates

Click **Redeploy** in the Coolify dashboard. Your data persists across redeployments.
