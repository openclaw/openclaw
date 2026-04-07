---
title: "CheapestInference"
summary: "Use CheapestInference's unified AI proxy for affordable inference in OpenClaw"
read_when:
  - You want the cheapest model pricing for OpenClaw
  - You want a single API key for many LLMs via CheapestInference
---

# CheapestInference

[CheapestInference](https://cheapestinference.com) is a unified AI inference proxy that provides access to many models behind a single OpenAI-compatible endpoint. It offers competitive pricing with optional pay-per-request via USDC on Base L2.

## Quick start

```bash
openclaw onboard --auth-choice cheapestinference-api-key
```

## Config snippet

```json5
{
  env: { CHEAPESTINFERENCE_API_KEY: "sk-..." },
  models: {
    providers: {
      cheapestinference: {
        baseUrl: "https://api.cheapestinference.com/v1",
        apiKey: "${CHEAPESTINFERENCE_API_KEY}",
        api: "openai-completions",
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "cheapestinference/claude-opus-4-6" },
    },
  },
}
```

## Manual setup

Set the env var directly:

```bash
export CHEAPESTINFERENCE_API_KEY="sk-..."
```

## Notes

- Base URL: `https://api.cheapestinference.com/v1`
- OpenAI-compatible API — works with any OpenAI SDK by switching the base URL
- Model refs follow the pattern `cheapestinference/<model>` (e.g. `cheapestinference/claude-opus-4-6`, `cheapestinference/gpt-4o`)
- Supports models from Anthropic, OpenAI, Google, Meta, Mistral, DeepSeek, and others
- Bearer token authentication with your subscriber API key
- Browse available models and pricing at [cheapestinference.com](https://cheapestinference.com)

## See also

- [Provider Directory](/providers/index)
- [Model Providers](/concepts/model-providers)
