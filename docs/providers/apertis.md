---
summary: "Use Apertis AI (multi-model proxy) with OpenClaw"
read_when:
  - You want Apertis AI models in OpenClaw
  - You need APERTIS_API_KEY setup
title: "Apertis AI"
---

# Apertis AI

Apertis AI is a multi-model proxy that provides access to a wide range of models through a
single API. It supports OpenAI Completions, Anthropic Messages, and OpenAI Responses formats
and uses API keys for authentication. Create your API key in the
[Apertis AI dashboard](https://api.apertis.ai). OpenClaw uses the `apertis` provider with an
Apertis API key.

## Model overview

- **Dynamic model discovery**: models are fetched automatically from `https://api.apertis.ai/api/models` at runtime.
- Base URL: `https://api.apertis.ai/v1`
- API formats: `openai-completions` (default), `anthropic-messages`, `openai-responses`
- Authorization: `Bearer $APERTIS_API_KEY`

No static model catalog is needed — OpenClaw discovers available models from the Apertis API.

## CLI setup

```bash
openclaw onboard --auth-choice apertis-api-key
# or non-interactive
openclaw onboard --auth-choice apertis-api-key --apertis-api-key "$APERTIS_API_KEY"
```

## Config snippet

```json5
{
  env: { APERTIS_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "apertis/your-preferred-model" } } },
  models: {
    mode: "merge",
    providers: {
      apertis: {
        baseUrl: "https://api.apertis.ai/v1",
        api: "openai-completions",
        apiKey: "APERTIS_API_KEY",
        // Models are discovered automatically — no models array needed.
      },
    },
  },
}
```

## Notes

- Model ref: `apertis/<model-id>` (use the model ID returned by the discovery endpoint).
- The provider is injected automatically when `APERTIS_API_KEY` is set (or an auth profile exists).
- Models are discovered at runtime from the public endpoint; no manual model list is required.
- To use Anthropic Messages format instead, set `api: "anthropic-messages"` in the provider config.
- See [/concepts/model-providers](/concepts/model-providers) for provider rules.
