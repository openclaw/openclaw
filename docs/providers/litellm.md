---
summary: "Run OpenClaw through LiteLLM Proxy for unified model access and cost tracking"
read_when:
  - You want to route OpenClaw through a LiteLLM proxy
  - You need cost tracking, logging, or model routing through LiteLLM
---
# LiteLLM

[LiteLLM](https://litellm.ai) is an open-source LLM gateway that provides a unified API to 100+ model providers. Route OpenClaw through LiteLLM to get centralized cost tracking, logging, and the flexibility to switch backends without changing your OpenClaw config.

## Why use LiteLLM with OpenClaw?

- **Cost tracking** — See exactly what OpenClaw spends across all models
- **Model routing** — Switch between Claude, GPT-4, Gemini, Bedrock without config changes
- **Virtual keys** — Create keys with spend limits for OpenClaw
- **Logging** — Full request/response logs for debugging
- **Fallbacks** — Automatic failover if your primary provider is down

## Quick start

LiteLLM's `/v1/messages` endpoint speaks Anthropic's protocol natively — perfect for OpenClaw.

### Via onboarding

```bash
openclaw onboard --auth-choice litellm-api-key
```

### Manual setup

1) Start LiteLLM Proxy:

```bash
pip install 'litellm[proxy]'
litellm --model anthropic/claude-sonnet-4-20250514
```

2) Point OpenClaw to LiteLLM:

```bash
export LITELLM_API_KEY="your-litellm-key"  # or any string if no auth
export ANTHROPIC_API_BASE="http://localhost:4000"

openclaw
```

That's it. OpenClaw now routes through LiteLLM.

## Configuration

### Environment variables

```bash
export LITELLM_API_KEY="sk-litellm-key"
export ANTHROPIC_API_BASE="http://localhost:4000"
```

### Config file

```json5
{
  env: {
    ANTHROPIC_API_BASE: "http://localhost:4000",
    LITELLM_API_KEY: "sk-litellm-key"
  },
  agents: {
    defaults: {
      model: { primary: "litellm/claude-sonnet-4-20250514" }
    }
  }
}
```

### With custom provider entry

For more control, define LiteLLM as an explicit provider:

```json5
{
  models: {
    providers: {
      litellm: {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "sk-litellm-key",
        api: "anthropic-messages",
        models: [
          { id: "claude-sonnet-4-20250514", name: "Claude Sonnet" },
          { id: "gpt-4o", name: "GPT-4o" }
        ]
      }
    }
  },
  agents: {
    defaults: {
      model: { primary: "litellm/claude-sonnet-4-20250514" }
    }
  }
}
```

## Virtual keys

Create a dedicated key for OpenClaw with spend limits:

```bash
curl -X POST "http://localhost:4000/key/generate" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key_alias": "openclaw",
    "max_budget": 50.00,
    "budget_duration": "monthly"
  }'
```

Use the generated key as `LITELLM_API_KEY`.

## Model routing

LiteLLM can route model requests to different backends. Configure in your LiteLLM `config.yaml`:

```yaml
model_list:
  - model_name: claude-sonnet-4-20250514
    litellm_params:
      model: azure/gpt-4o
      api_key: os.environ/AZURE_API_KEY
```

OpenClaw keeps requesting `claude-sonnet-4-20250514` — LiteLLM handles the routing.

## Viewing usage

Check LiteLLM's dashboard or API:

```bash
# Key info
curl "http://localhost:4000/key/info" \
  -H "Authorization: Bearer sk-litellm-key"

# Spend logs
curl "http://localhost:4000/spend/logs" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY"
```

## Notes

- LiteLLM runs on `http://localhost:4000` by default
- The `/v1/messages` endpoint supports streaming, tools, prompt caching, and extended thinking
- All OpenClaw features work through LiteLLM — no limitations

## See also

- [LiteLLM Docs](https://docs.litellm.ai)
- [LiteLLM /v1/messages](https://docs.litellm.ai/docs/anthropic_unified/)
- [Model Providers](/concepts/model-providers)
