---
summary: "Featherless AI setup (auth + model selection)"
read_when:
  - You want to use Featherless AI with OpenClaw
  - You need the API key env var or CLI auth choice
title: "Featherless AI"
---

# Featherless AI

[Featherless AI](https://featherless.ai) provides serverless inference for 25,000+ open-source models with flat-rate pricing. It is OpenAI-compatible.

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

## Recommended models

- **MiniMax M2.5** (`MiniMaxAI/MiniMax-M2.5`) - Strong agentic tasks and tool use, 256K context
- **Kimi K2.5** (`moonshotai/Kimi-K2.5`) - General-purpose with reasoning, 256K context
- **GLM 4.7** (`zai-org/GLM-4.7`) - Fast coding tasks, 128K context
- **DeepSeek V3** (`deepseek-ai/DeepSeek-V3`) - Strong reasoning, 128K context

Browse all available models at [featherless.ai/models](https://featherless.ai/models).

## Pricing

Featherless uses flat-rate pricing (no per-token billing). Cost fields are set to 0 in the provider configuration.
