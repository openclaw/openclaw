---
title: "DInference"
summary: "DInference setup (auth + model selection)"
read_when:
  - You want to use DInference with OpenClaw
  - You need the API key env var or CLI auth choice
---

# DInference

[DInference](https://dinference.com) provides access to open source models including GLM-5, GLM-4.7, and GPT-OSS-120B through an OpenAI-compatible API.

- Provider: `dinference`
- Auth: `DINFERENCE_API_KEY`
- API: OpenAI-compatible

## Quick start

1. Get your API key from [DInference](https://dinference.com)
2. Set the API key (recommended: store it for the Gateway):

```bash
openclaw onboard --auth-choice dinference-api-key
```

3. Set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "dinference/glm-5" },
    },
  },
}
```

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice dinference-api-key \
  --dinference-api-key "$DINFERENCE_API_KEY"
```

This will set `dinference/glm-5` as the default model.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `DINFERENCE_API_KEY`
is available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).

## Available models

DInference provides access to the following open source models:

- **GLM 5** - Default model with 198K context window, supports reasoning
- **GLM 4.7** - 198K context window, supports reasoning
- **GPT-OSS 120B** - 128K context window

All models support standard chat completions and are OpenAI API compatible.
