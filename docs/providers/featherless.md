---
title: "Featherless AI"
summary: "Featherless AI setup (auth + model selection)"
read_when:
  - You want to use Featherless AI with OpenClaw
  - You need the API key env var or CLI auth choice
---

# Featherless AI

[Featherless AI](https://featherless.ai) provides serverless inference for 25,000+ open-source models with flat-rate pricing. All models are available through an OpenAI-compatible API.

- Provider: `featherless`
- Auth: `FEATHERLESS_API_KEY`
- API: OpenAI-compatible

## Quick start

1. Set the API key (recommended: store it for the Gateway):

```bash
openclaw onboard --auth-choice featherless-api-key
```

2. Set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "featherless/MiniMaxAI/MiniMax-M2.5" },
    },
  },
}
```

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice featherless-api-key \
  --featherless-api-key "$FEATHERLESS_API_KEY"
```

This will set `featherless/MiniMaxAI/MiniMax-M2.5` as the default model.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `FEATHERLESS_API_KEY`
is available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).

## Available models

Featherless AI provides access to 25,000+ open-source models. Curated defaults include:

- **MiniMax M2.5** - Default model with 1M context window and reasoning
- **Kimi K2.5** - High-performance reasoning model
- **GLM 4.7 9B** - Efficient chat model
- **DeepSeek V3** - Advanced coding and reasoning model

## Pricing

Featherless AI uses flat-rate subscription pricing. All model inference is included at no additional per-token cost.
