---
summary: "Use Fal OpenRouter to access many models in OpenClaw via a single fal API key"
read_when:
  - You want a single API key for many LLMs
  - You want to run models via Fal OpenRouter in OpenClaw
title: "Fal OpenRouter"
---

# Fal OpenRouter

Fal OpenRouter provides access to LLMs through a single API key via [fal.ai/openrouter](https://fal.ai/models/openrouter/router). It proxies requests to many providers behind one endpoint, using OpenAI-compatible completions.

## Getting an API key

1. Go to [fal.ai](https://fal.ai)
2. Sign in or create an account
3. Navigate to your dashboard and generate an API key

## CLI setup

```bash
openclaw onboard --fal-openrouter-api-key <key>
```

Or set the environment variable:

```bash
export FAL_API_KEY="your-api-key"
```

## Config snippet

```json5
{
  env: { FAL_API_KEY: "fal-..." },
  agents: {
    defaults: {
      model: { primary: "fal-openrouter/google/gemini-2.5-flash" },
    },
  },
}
```

## Available models

| Model             | ID                                           | Context | Reasoning |
| ----------------- | -------------------------------------------- | ------- | --------- |
| Gemini 2.5 Flash  | `fal-openrouter/google/gemini-2.5-flash`     | 1M      | Yes       |
| Claude Sonnet 4.6 | `fal-openrouter/anthropic/claude-sonnet-4.6` | 200K    | Yes       |
| Claude Opus 4.6   | `fal-openrouter/anthropic/claude-opus-4.6`   | 200K    | Yes       |
| Claude Sonnet 4.5 | `fal-openrouter/anthropic/claude-sonnet-4.5` | 200K    | Yes       |
| GPT-4.1           | `fal-openrouter/openai/gpt-4.1`              | 1M      | No        |
| GPT OSS 120B      | `fal-openrouter/openai/gpt-oss-120b`         | 128K    | No        |
| Llama 4 Maverick  | `fal-openrouter/meta-llama/llama-4-maverick` | 1M      | No        |

## Notes

- Model refs are `fal-openrouter/<provider>/<model>` (e.g., `fal-openrouter/google/gemini-2.5-flash`).
- Default model: `fal-openrouter/google/gemini-2.5-flash`
- Base URL: `https://fal.run/openrouter/router/openai/v1`
- Fal uses `Authorization: Key <key>` instead of Bearer tokens; OpenClaw handles this automatically.
- For more model/provider options, see [/concepts/model-providers](/concepts/model-providers).
