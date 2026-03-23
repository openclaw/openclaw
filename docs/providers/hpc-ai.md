---
title: "HPC-AI"
summary: "HPC-AI setup (auth + model selection)"
read_when:
  - You want to use HPC-AI with OpenClaw
  - You need the API key env var or CLI auth choice
---

# HPC-AI

[HPC-AI](https://www.hpc-ai.com/doc/docs/quickstart/) exposes an OpenAI-compatible inference API for hosted models.

- Provider: `hpc-ai`
- Auth: `HPC_AI_API_KEY`
- API: OpenAI-compatible (`openai-completions`)

Model ids can include `/` (for example `minimax/minimax-m2.5`). OpenClaw model refs use **only the first `/`** to split provider from model, so the full ref is `hpc-ai/minimax/minimax-m2.5` (not the built-in `minimax` plugin).

## Quick start

1. Set the API key (recommended: store it for the Gateway):

```bash
openclaw onboard --auth-choice hpc-ai-api-key
```

2. Default model after onboarding:

```json5
{
  agents: {
    defaults: {
      model: { primary: "hpc-ai/minimax/minimax-m2.5" },
    },
  },
}
```

## Switch to Kimi K2.5 (vision)

`moonshotai/kimi-k2.5` supports **text and images** when your upstream endpoint accepts OpenAI-style multimodal messages.

```json5
{
  agents: {
    defaults: {
      model: { primary: "hpc-ai/moonshotai/kimi-k2.5" },
    },
  },
}
```

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice hpc-ai-api-key \
  --hpc-ai-api-key "$HPC_AI_API_KEY"
```

This sets `hpc-ai/minimax/minimax-m2.5` as the default model.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `HPC_AI_API_KEY` is available to that process (for example, in `~/.openclaw/.env` or via `env.shellEnv`).

## Models

| Model ref                     | Context | Max tokens | Notes         |
| ----------------------------- | ------- | ---------- | ------------- |
| `hpc-ai/minimax/minimax-m2.5` | 196000  | 65536      | Default; text |
| `hpc-ai/moonshotai/kimi-k2.5` | 256000  | 64000      | Text + image  |

Catalog `cost` values are **USD per 1 million tokens** and are used for **OpenClaw-side usage estimates only**; they do not change HPC-AI billing.
