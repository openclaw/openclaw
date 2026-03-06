---
summary: "DeepInfra setup (auth + model selection)"
read_when:
  - You want to use DeepInfra with OpenClaw
  - You need the API key env var or CLI auth choice
---

# DeepInfra

[DeepInfra](https://deepinfra.com) provides fast, low-cost inference for popular open-source models through an OpenAI-compatible API.

- Provider: `deepinfra`
- Auth: `DEEPINFRA_API_KEY`
- API: OpenAI-compatible

## Quick start

1. Get an API key from [deepinfra.com/dash/api_keys](https://deepinfra.com/dash/api_keys).

2. Set the API key (recommended: store it for the Gateway):

```bash
openclaw onboard --auth-choice deepinfra-api-key
```

3. Set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "deepinfra/meta-llama/Llama-3.3-70B-Instruct-Turbo" },
    },
  },
}
```

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice deepinfra-api-key \
  --deepinfra-api-key "$DEEPINFRA_API_KEY"
```

This will set `deepinfra/meta-llama/Llama-3.3-70B-Instruct-Turbo` as the default model.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `DEEPINFRA_API_KEY`
is available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).

## Available models

DeepInfra hosts a wide range of open-source models:

- **Llama 3.3 70B Instruct Turbo** - Fast, efficient instruction following (default)
- **Llama 4 Scout** - Vision model with image understanding
- **Llama 4 Maverick** - Advanced vision and reasoning
- **DeepSeek V3** - Powerful coding and reasoning model
- **DeepSeek R1** - Advanced reasoning model
- **Qwen 3 235B** - Large-scale reasoning model
- **Qwen 2.5 Coder 32B** - Specialized coding model
- **Gemma 3 27B** - Vision-capable model from Google

For the full model catalog, see [deepinfra.com/models](https://deepinfra.com/models).

All models support standard chat completions and are OpenAI API compatible.
