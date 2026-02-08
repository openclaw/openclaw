---
summary: "Use LiteLLM to access 100+ LLM providers through one API"
read_when:
  - You want to use multiple LLM providers with one config
  - You want automatic failover between models
  - You need cost tracking across providers
title: "LiteLLM"
---

# LiteLLM

LiteLLM provides a **unified API** to access 100+ LLM providers (OpenAI, Anthropic, Google, Mistral, Cohere, etc.) through a single endpoint. Use it when you want to switch between models without changing code, or need fallback/load balancing across providers.

- Provider: `litellm`
- API: OpenAI-compatible (`/v1/chat/completions`)
- Auth: `LITELLM_API_KEY` (for hosted) or self-hosted proxy

## Why LiteLLM?

| Feature | Benefit |
|---------|---------|
| **100+ providers** | One config for OpenAI, Anthropic, Google, Mistral, Bedrock, etc. |
| **Automatic fallbacks** | If Claude fails, auto-retry with GPT-4 |
| **Cost tracking** | Built-in spend monitoring per model/user |
| **Load balancing** | Distribute requests across multiple API keys |

## Quick start (hosted)

Use the LiteLLM hosted proxy at `api.litellm.ai`:

```bash
openclaw onboard --auth-choice litellm-api-key
```

## Quick start (self-hosted)

Run your own LiteLLM proxy:

```bash
# Install
pip install litellm[proxy]

# Create config
cat > litellm_config.yaml << 'EOF'
model_list:
  - model_name: gpt-4
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY
  - model_name: claude
    litellm_params:
      model: anthropic/claude-sonnet-4-20250514
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: gemini
    litellm_params:
      model: gemini/gemini-1.5-pro
      api_key: os.environ/GOOGLE_API_KEY
EOF

# Run proxy
litellm --config litellm_config.yaml --port 4000
```

Then configure OpenClaw:

```json5
{
  env: { LITELLM_API_KEY: "sk-..." },
  models: {
    providers: {
      litellm: {
        baseUrl: "http://localhost:4000",
        apiKey: "${LITELLM_API_KEY}",
        api: "openai-chat",
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "litellm/gpt-4" },
    },
  },
}
```

## Config snippet (hosted)

```json5
{
  env: { LITELLM_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "litellm/gpt-4o" },
    },
  },
}
```

## Fallbacks

Configure automatic failover:

```yaml
# litellm_config.yaml
model_list:
  - model_name: default
    litellm_params:
      model: anthropic/claude-sonnet-4-20250514
  - model_name: default
    litellm_params:
      model: openai/gpt-4o

router_settings:
  allowed_fails: 2
  fallbacks: [{"default": ["default"]}]
```

## Cost tracking

LiteLLM tracks costs automatically. View spend in the proxy dashboard or via API:

```bash
curl http://localhost:4000/spend/logs
```

## Notes

- Model refs are `litellm/<model_name>` where `model_name` matches your config.
- For the full model list, see [LiteLLM docs](https://docs.litellm.ai/docs/providers).
- GitHub: [github.com/BerriAI/litellm](https://github.com/BerriAI/litellm)
