---
summary: "Use OpenRouter's unified API to access many models in OpenClaw"
read_when:
  - You want a single API key for many LLMs
  - You want to run models via OpenRouter in OpenClaw
title: "OpenRouter"
---

# OpenRouter

OpenRouter provides a **unified API** that routes requests to many models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

## CLI setup

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## Free models quickstart

OpenClaw can automatically discover and configure **free** OpenRouter models via the
built-in scan command:

```bash
# 1) Ensure your OpenRouter key is available
export OPENROUTER_API_KEY="sk-or-..."

# 2) Scan only free models, probe tools/images, and write them into openclaw.json
openclaw models scan --yes --set-default --set-image
```

This will:

- Call OpenRouter's `/models` endpoint and filter to free models (by `:free` suffix or zero pricing).
- Probe candidate models for **tool** and **image** support (unless you add `--no-probe`).
- Update your `openclaw.json` so that:
  - `agents.defaults.model` points at a good free text model.
  - `agents.defaults.imageModel` points at a free vision model (when available).
  - `agents.defaults.models` contains an allowlist of the selected OpenRouter models.

After that, `/model` in chat and the various UIs will list those free OpenRouter models
like any other provider.

## Manual config snippet

If you prefer to configure a specific OpenRouter model by hand:

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
    },
  },
}
```

## Notes

- Model refs are `openrouter/<provider>/<model>`.
- For more model/provider options, see [/concepts/model-providers](/concepts/model-providers).
- OpenRouter uses a Bearer token with your API key under the hood.
