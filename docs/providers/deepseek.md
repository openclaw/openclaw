---
summary: "DeepSeek setup (auth + model selection)"
read_when:
  - You want to use DeepSeek with OpenClaw
  - You need the API key env var or CLI auth choice
---

# DeepSeek

DeepSeek provides native chat and reasoning models via an OpenAI-compatible API.

- Provider: `deepseek`
- Auth: `DEEPSEEK_API_KEY`
- API: OpenAI-compatible

## Quick start

1. Set the API key:

```bash
openclaw onboard --auth-choice deepseek-api-key
```

2. Set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "deepseek/deepseek-chat" },
    },
  },
}
```

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice deepseek-api-key \
  --deepseek-api-key "$DEEPSEEK_API_KEY"
```

## Available models

- `deepseek-chat` - General-purpose chat model
- `deepseek-reasoner` - Reasoning-focused model

## Notes

- Base URL defaults to `https://api.deepseek.com/v1`.
- You can override provider settings in `models.providers.deepseek` if needed.
