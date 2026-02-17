---
summary: "MegaNova AI setup (auth + model selection)"
read_when:
  - You want to use MegaNova AI with OpenClaw
  - You need the API key env var or CLI auth choice
---

# MegaNova AI

[MegaNova AI](https://meganova.ai) provides access to 30+ leading models through
an OpenAI-compatible API, including frontier models (Claude, GPT-5, Gemini),
open-source models (DeepSeek, Llama, Qwen), and reasoning models (GLM-5, DeepSeek-R1).

- Provider: `meganova`
- Auth: `MEGANOVA_API_KEY`
- API: OpenAI-compatible

## Quick start

1. Set the API key (recommended: store it for the Gateway):

```bash
openclaw onboard --auth-choice meganova-api-key
```

2. Set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "meganova/zai-org/GLM-5" },
    },
  },
}
```

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice meganova-api-key \
  --meganova-api-key "$MEGANOVA_API_KEY"
```

This will set `meganova/zai-org/GLM-5` as the default model.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `MEGANOVA_API_KEY`
is available to that process (for example, in `~/.clawdbot/.env` or via
`env.shellEnv`).

## Available models

MegaNova provides access to a wide range of models:

- **GLM 5** (default) - reasoning model, 202K context
- **Claude Opus 4.6 / Sonnet 4.5 / Haiku 4.5** - Anthropic frontier models
- **GPT-5.2 / 5.1 / 5 / 5-mini / 5-nano** - OpenAI frontier models
- **Gemini 3 Pro / Flash, 2.5 Pro / Flash** - Google models with 1M context
- **Grok 4 Fast** - xAI model with 2M context
- **DeepSeek V3.2 / V3.1 / V3-0324 / R1-0528** - Open-weight reasoning and coding models
- **Kimi K2 Thinking / K2.5** - Moonshot reasoning models
- **Qwen3 235B** - Alibaba multilingual model
- **Llama 3.3 70B Instruct** - Meta open-source model
- **MiniMax M2.1 / M2.5** - MiniMax models
- **MiMo V2 Flash** - Xiaomi model
- **Mistral Nemo Instruct** - Mistral open-source model

All models support standard chat completions and are OpenAI API compatible.
