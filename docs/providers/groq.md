---
summary: "Groq setup (auth + model selection)"
read_when:
  - You want to use Groq with OpenClaw
  - You need the API key env var or CLI auth choice
---

# Groq

[Groq](https://groq.com) provides fast inference with competitive pricing for leading open-source models through an OpenAI-compatible API.

- Provider: `groq`
- Auth: `GROQ_API_KEY`
- API: OpenAI-compatible

## Quick start

1. Set the API key (recommended: store it for the Gateway):

```bash
openclaw onboard --auth-choice groq-api-key
```

2. Set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "groq/llama-3.3-70b-versatile" },
    },
  },
}
```

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice groq-api-key \
  --groq-api-key "$GROQ_API_KEY"
```

This will set `groq/llama-3.3-70b-versatile` as the default model.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `GROQ_API_KEY`
is available to that process (for example, in `~/.clawdbot/.env` or via
`env.shellEnv`).

## Available models

Groq provides fast inference for popular open-source models:

- **Llama 3.3 70B** - Versatile model with 128K context window
- **Mixtral 8x7B** - Efficient mixture-of-experts with 32K context window
- **DeepSeek R1 Distill Llama 70B** - Advanced reasoning model with 128K context window

All models support standard chat completions and are OpenAI API compatible.
