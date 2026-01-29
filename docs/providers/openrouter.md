---
summary: "Use OpenRouter's unified API to access many models in Moltbot"
read_when:
  - You want a single API key for many LLMs
  - You want to run models via OpenRouter in Moltbot
---
# OpenRouter

OpenRouter provides a **unified API** that routes requests to many models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

## CLI setup

```bash
moltbot onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## Config snippet

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" }
    }
  }
}
```

## Notes

- Model refs are `openrouter/<provider>/<model>`.
- For more model/provider options, see [/concepts/model-providers](/concepts/model-providers).
- OpenRouter uses a Bearer token with your API key under the hood.

## Provider routing

OpenRouter supports provider routing via the `compat.openRouterRouting` field, which controls which upstream providers handle your requests. Configure this in `agents.defaults.models` for individual models.

### Configuration options

- `compat.openRouterRouting.only`: List of provider slugs to exclusively use for this request (e.g., `["anthropic", "openai"]`).
- `compat.openRouterRouting.order`: List of provider slugs to try in sequence (e.g., `["anthropic", "openai"]`).

### Example

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
      models: {
        "openrouter/anthropic/claude-sonnet-4-5": {
          alias: "Claude Sonnet",
          compat: {
            openRouterRouting: {
              only: ["anthropic"]
            }
          }
        },
        "openrouter/openai/gpt-5.2": {
          alias: "GPT-5.2",
          compat: {
            openRouterRouting: {
              order: ["anthropic", "openai"]
            }
          }
        }
      }
    }
  }
}
```
