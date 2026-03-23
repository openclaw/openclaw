---
summary: "Use OpenRouter's unified API to access many models in OpenClaw"
read_when:
  - You want a single API key for many LLMs
  - You want to run models via OpenRouter in OpenClaw
title: "OpenRouter"
---

# OpenRouter

OpenRouter provides a **unified API** that routes requests to many models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

## CLI setup

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## Config snippet

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-6" },
    },
  },
}
```

## Auto-router

OpenRouter's [auto-router](https://openrouter.ai/docs/features/model-routing) selects the best
model for each prompt automatically. You can constrain it to a specific set of models using the
`autoRouter.allowedModels` param:

```json5
{
  agents: {
    defaults: {
      model: { primary: "openrouter/openrouter/auto" },
      models: {
        "openrouter/openrouter/auto": {
          params: {
            autoRouter: {
              allowedModels: [
                "anthropic/claude-haiku-4-5",
                "google/gemini-2.5-flash",
                "openai/gpt-5-nano",
              ],
            },
          },
        },
      },
    },
  },
}
```

When `allowedModels` is set, the auto-router picks only from that list — giving you intelligent
task-based routing within a cost-controlled pool. Omitting `allowedModels` lets the auto-router
choose from all OpenRouter models.

Wildcards are also supported: `"anthropic/*"` matches all Anthropic models.

## Provider routing

You can restrict which inference providers OpenRouter uses via `params.provider`:

```json5
{
  agents: {
    defaults: {
      models: {
        "openrouter/anthropic/claude-haiku-4-5": {
          params: {
            provider: { only: ["anthropic"], allow_fallbacks: false },
          },
        },
      },
    },
  },
}
```

## Notes

- Model refs are `openrouter/<provider>/<model>`.
- For more model/provider options, see [/concepts/model-providers](/concepts/model-providers).
- OpenRouter uses a Bearer token with your API key under the hood.
