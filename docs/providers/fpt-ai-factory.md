---
summary: "FPT AI Factory setup (auth + model selection)"
read_when:
  - You want to use FPT AI Factory with OpenClaw
  - You need the API key env var or CLI auth choice
title: "FPT AI Factory"
---

# FPT AI Factory

[FPT AI Factory](https://fptcloud.com/) provides OpenAI-compatible model access through `https://mkp-api.fptcloud.com/v1`.

- Provider: `fpt-ai-factory`
- Auth: `FPT_AI_FACTORY_API_KEY`
- API: OpenAI-compatible chat completions

## Quick start

```bash
openclaw onboard --auth-choice fpt-ai-factory-api-key
```

This sets `fpt-ai-factory/Qwen3-32B` as the default model.

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice fpt-ai-factory-api-key \
  --fpt-ai-factory-api-key "$FPT_AI_FACTORY_API_KEY"
```

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `FPT_AI_FACTORY_API_KEY`
is available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).

## Phase 1 model support

OpenClaw phase 1 exposes only **chat** and **vision-capable** models discovered from:

```bash
GET https://mkp-api.fptcloud.com/v1/models
```

Embedding, reranker, OCR, speech, and TTS-oriented models are intentionally excluded from the text provider catalog.

## Default and fallback models

The bundled fallback catalog currently includes:

- `Qwen3-32B`
- `GLM-4.7`
- `Kimi-K2.5`
- `Qwen3-VL-8B-Instruct`
- `gpt-oss-120b`
- `SaoLa4-medium`
- `SaoLa4-small`

At runtime, OpenClaw refreshes this list from `GET /v1/models` when a valid API key is present.
