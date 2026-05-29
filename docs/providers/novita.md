---
summary: "Use NovitaAI's OpenAI-compatible API with OpenClaw"
read_when:
  - You want to run OpenClaw with NovitaAI models
  - You need the Novita provider id, key, or endpoint
title: "NovitaAI"
---

NovitaAI is a bundled OpenAI-compatible provider. Use provider id `novita` and model refs like `novita/deepseek/deepseek-v3-0324`.

## Setup

Create an API key at [novita.ai/settings/key-management](https://novita.ai/settings/key-management), then run:

```bash
openclaw onboard --auth-choice novita-api-key
```

Or set:

```bash
export NOVITA_API_KEY="<your-novita-api-key>" # pragma: allowlist secret
```

## Defaults

- Provider: `novita`
- Aliases: `novita-ai`, `novitaai`
- Base URL: `https://api.novita.ai/openai/v1`
- Env var: `NOVITA_API_KEY`
- Default model: `novita/deepseek/deepseek-v3-0324`

## Models

The bundled catalog seeds commonly available NovitaAI route ids, including:

- `novita/moonshotai/kimi-k2.5`
- `novita/minimax/minimax-m2.7`
- `novita/zai-org/glm-5`
- `novita/deepseek/deepseek-v3-0324`
- `novita/deepseek/deepseek-r1-0528`
- `novita/qwen/qwen3-235b-a22b-fp8`

## Related

- [Model providers](/concepts/model-providers)
- [All providers](/providers/index)
