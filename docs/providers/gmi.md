---
summary: "Use GMI Cloud's OpenAI-compatible API with OpenClaw"
read_when:
  - You want to run OpenClaw with GMI Cloud models
  - You need the GMI provider id, key, or endpoint
title: "GMI Cloud"
---

GMI Cloud is a bundled OpenAI-compatible provider. Use provider id `gmi` and model refs like `gmi/google/gemini-3.1-flash-lite`.

## Setup

Create an API key in GMI Cloud, then run:

```bash
openclaw onboard --auth-choice gmi-api-key
```

Or set:

```bash
export GMI_API_KEY="<your-gmi-api-key>" # pragma: allowlist secret
```

## Defaults

- Provider: `gmi`
- Aliases: `gmi-cloud`, `gmicloud`
- Base URL: `https://api.gmi-serving.com/v1`
- Env var: `GMI_API_KEY`
- Default model: `gmi/google/gemini-3.1-flash-lite`

## Models

The bundled catalog seeds commonly available GMI Cloud route ids, including:

- `gmi/zai-org/GLM-5.1-FP8`
- `gmi/deepseek-ai/DeepSeek-V3.2`
- `gmi/moonshotai/Kimi-K2.5`
- `gmi/google/gemini-3.1-flash-lite`
- `gmi/anthropic/claude-sonnet-4.6`
- `gmi/openai/gpt-5.4`

## Related

- [Model providers](/concepts/model-providers)
- [All providers](/providers/index)
