---
title: "Portkey"
summary: "Route OpenClaw through Portkey for observability, governance, cost tracking, and reliability"
read_when:
  - You want enterprise-grade observability for OpenClaw
  - You need cost tracking across teams or projects
  - You want provider fallbacks and load balancing
  - You need budget controls or rate limits
---
# Portkey

[Portkey](https://portkey.ai) is an AI gateway that provides observability, governance, and reliability features for LLM applications. Route OpenClaw requests through Portkey to get cost tracking, budget controls, fallbacks, caching, and full request/response logging.

## Documentation Index

Fetch the complete Portkey documentation index at: https://docs.portkey.ai/docs/llms.txt

Use this file to discover all available pages before exploring further.

## Why Use Portkey with OpenClaw

- **Cost Visibility**: Track spending per team, project, or agent. Set hard budget limits.
- **Observability**: Full request/response logs with token usage, latency metrics, and trace IDs.
- **Reliability**: Automatic fallbacks, load balancing, retries, and caching.
- **Governance**: No raw API keys to developers. Centralized access control and audit logs.
- **Provider Agnostic**: Route through Anthropic, OpenAI, Bedrock, Vertex AI, or any supported provider. Switch with a config change.

## Quick Start

### 1. Set up Portkey

1. Create a [Portkey account](https://app.portkey.ai)
2. Add your provider (Anthropic, OpenAI, etc.) in [AI Providers](https://app.portkey.ai/integrations)
3. Create a provider slug (e.g., `anthropic-prod`)
4. Generate a [Portkey API key](https://app.portkey.ai/api-keys)

### 2. Configure OpenClaw

Add Portkey as a custom provider in your config. Portkey provides a unified OpenAI-compatible API, so use `api: "openai-completions"` for all providers (including Anthropic):

```json5
{
  agents: {
    defaults: {
      model: { primary: "portkey/@anthropic/claude-sonnet-4-5" }
    }
  },
  models: {
    mode: "merge",
    providers: {
      portkey: {
        baseUrl: "https://api.portkey.ai/v1",
        apiKey: "${PORTKEY_API_KEY}",
        api: "openai-completions",
        models: [
          { id: "@anthropic/claude-opus-4-5", name: "Claude Opus 4.5" },
          { id: "@anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
          { id: "@openai/gpt-5.2", name: "GPT-5.2" }
        ]
      }
    }
  }
}
```

Note: Model IDs use Portkey's `@provider/model` format (e.g., `@anthropic/claude-sonnet-4-5`, `@openai/gpt-5.2`).

### 3. Set the API key

```bash
# Store the key for the Gateway
openclaw config set env.PORTKEY_API_KEY "YOUR_PORTKEY_API_KEY"
```

## Using Portkey Configs

Portkey Configs let you define routing strategies, fallbacks, caching, and more. Create a config in the [Portkey dashboard](https://app.portkey.ai/configs), and attach it to your generated Portkey API key. That's it, you're good to go! 

### Example Portkey Config: Fallbacks

Create this config in Portkey to automatically failover between providers:

```json
{
  "strategy": { "mode": "fallback" },
  "targets": [
    { "provider": "@anthropic-prod" },
    { "provider": "@openai-prod" },
    { "provider": "@bedrock-prod" }
  ]
}
```

### Example Portkey Config: Load Balancing

Distribute requests across multiple providers or regions:

```json
{
  "strategy": { "mode": "loadbalance" },
  "targets": [
    { "provider": "@anthropic-us", "weight": 0.5 },
    { "provider": "@anthropic-eu", "weight": 0.5 }
  ]
}
```

### Example Portkey Config: Caching + Retries

Reduce costs and improve reliability:

```json
{
  "provider": "@anthropic-prod",
  "cache": { "mode": "simple" },
  "retry": { "attempts": 3, "on_status_codes": [429, 500, 502, 503] }
}
```

## Tracing Requests

Add trace IDs to group requests in the Portkey dashboard:

```json5
{
  models: {
    mode: "merge",
    providers: {
      portkey: {
        baseUrl: "https://api.portkey.ai/v1",
        apiKey: "${PORTKEY_API_KEY}",
        api: "openai-completions",
        headers: {
          "x-portkey-trace-id": "openclaw-main-agent"
        },
        models: [
          { id: "@anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" }
        ]
      }
    }
  }
}
```

Use trace IDs to:
- Group all requests from an agent session
- Debug issues by filtering logs
- Track usage per project or task

## Budget Controls

Set spending controls at the provider level in Portkey:

1. Go to [Models](https://app.portkey.ai/model-catalog) → Select your provider
2. Click **Budget & Limits**
3. Configure:
   - **Cost limit**: Maximum spend (e.g., $500/month)
   - **Token limit**: Maximum tokens (e.g., 10M tokens/week)
   - **Rate limit**: Requests per minute/hour

Budget limits prevent runaway costs from long agent sessions.

## Multiple Providers via Single Config

Since Portkey provides a unified API, you can access multiple providers (OpenAI, Anthropic, etc.) through a single OpenClaw provider config:

```json5
{
  agents: {
    defaults: {
      model: { primary: "portkey/@openai/gpt-5.2" }
    }
  },
  models: {
    mode: "merge",
    providers: {
      portkey: {
        baseUrl: "https://api.portkey.ai/v1",
        apiKey: "${PORTKEY_API_KEY}",
        api: "openai-completions",
        models: [
          { id: "@openai/gpt-5.2", name: "GPT-5.2" },
          { id: "@openai/gpt-5", name: "GPT-5" },
          { id: "@anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
          { id: "@anthropic/claude-opus-4-5", name: "Claude Opus 4.5" }
        ]
      }
    }
  }
}
```

Switch models by changing the `primary` model ref (e.g., `portkey/@anthropic/claude-sonnet-4-5`).

## Advanced: Per-Agent Metadata

Track usage by agent with custom metadata headers:

```json5
{
  agents: {
    main: {
      model: { primary: "portkey/@anthropic/claude-opus-4-5" }
    }
  },
  models: {
    mode: "merge",
    providers: {
      portkey: {
        baseUrl: "https://api.portkey.ai/v1",
        apiKey: "${PORTKEY_API_KEY}",
        api: "openai-completions",
        headers: {
          "x-portkey-metadata": "{\"agent\":\"main\",\"environment\":\"production\"}"
        },
        models: [
          { id: "@anthropic/claude-opus-4-5", name: "Claude Opus 4.5" }
        ]
      }
    }
  }
}
```

Filter logs and analytics by these metadata fields in the Portkey dashboard.

## Portkey Features Summary

| Feature | Description |
|---------|-------------|
| **Observability** | 40+ metrics: cost, tokens, latency, performance |
| **Logs** | Full request/response tracking with metadata filters |
| **Fallbacks** | Automatic failover between providers |
| **Load Balancing** | Distribute requests across providers/regions |
| **Caching** | Simple and semantic caching to reduce costs |
| **Retries** | Automatic retry with exponential backoff |
| **Budget Limits** | Cost, token, and rate limits per provider |
| **Guardrails** | PII detection, content filtering, custom rules |
| **1600+ LLMs** | Unified access to providers via single endpoint |

## Troubleshooting

**Requests not appearing in Portkey dashboard**
- Verify `PORTKEY_API_KEY` is set correctly
- Confirm the base URL is `https://api.portkey.ai/v1`
- Check that the model ID uses the correct `@provider/model` format

**401 errors**
- Regenerate your Portkey API key
- Verify your provider credentials are configured in Portkey
- Check that the provider slug in the model ID (e.g., `@anthropic`, `@openai`) matches your Portkey configuration

**Provider errors**
- Check that your underlying provider (Anthropic, OpenAI, etc.) is configured in Portkey
- Verify the model ID format matches your Portkey setup (e.g., `@anthropic/claude-sonnet-4-5`)

**Rate limit errors (HTTP 429)**
- Check your Portkey virtual key's rate limits in the dashboard
- Consider upgrading your Portkey plan or adjusting rate limits

## Next Steps

- [Portkey Configs](https://docs.portkey.ai/product/ai-gateway/configs) - Fallbacks, load balancing, routing strategies
- [Budget & Limits](https://docs.portkey.ai/product/ai-gateway/virtual-keys/budget-limits) - Set up spending controls
- [Observability](https://docs.portkey.ai/product/observability) - Logs, traces, and analytics
- [Guardrails](https://docs.portkey.ai/product/guardrails) - PII detection and content filtering

For enterprise support and custom features, contact the [Portkey team](https://calendly.com/portkey-ai).
