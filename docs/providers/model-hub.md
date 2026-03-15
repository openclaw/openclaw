---
title: Model Hub
---

[Model Hub](https://model-hub.cn) is an aggregated AI model provider that offers access to multiple LLM models through a single OpenAI-compatible API endpoint.

## Setup

### 1. Get an API key

Sign up at [model-hub.cn](https://model-hub.cn) and obtain your API key.

### 2. Configure OpenClaw

```bash
openclaw onboard --model-hub-api-key YOUR_API_KEY
```

Or set the environment variable:

```bash
export MODEL_HUB_API_KEY=YOUR_API_KEY
```

### 3. Use a Model Hub model

```bash
openclaw agent --model model-hub/gemini-3-flash-preview
```

## Configuration

Add to your `openclaw.json`:

```json
{
  "models": {
    "providers": {
      "model-hub": {
        "baseUrl": "https://api.model-hub.cn/v1",
        "api": "openai-completions"
      }
    }
  }
}
```

## Available models

Model Hub supports dynamic model discovery. Run `openclaw models` after configuring your API key to see the full list of available models.

Common models include:

- `gemini-3-flash-preview`
- `gpt-4.1`
- `claude-sonnet-4-20250514`

## Notes

- Model Hub is an aggregated provider; per-model costs vary and are set to zero in OpenClaw's cost tracking.
- The provider uses the OpenAI-compatible protocol (`/v1/chat/completions`).
- Model discovery is automatic when an API key is configured.
