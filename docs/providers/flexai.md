---
summary: "Use FlexAI open-weight models with OpenClaw through the FlexAI provider plugin"
title: "FlexAI"
read_when:
  - You want to use FlexAI models with OpenClaw
  - You want FlexAI image, speech, transcription, embedding or video models in OpenClaw
---

[FlexAI](https://flex.ai) serves open-weight models through an OpenAI-compatible
API. FlexAI maintains an external provider plugin for OpenClaw.

| Property                     | Value                            |
| ---------------------------- | -------------------------------- |
| Provider                     | `flexai`                         |
| Plugin                       | `@flexai/openclaw-provider`      |
| API key environment variable | `FLEXAI_API_KEY`                 |
| Base URL                     | `https://api.flex.ai/v1`         |
| API                          | `openai-completions`             |

## Setup

1. Create an API key from the [FlexAI docs](https://docs.flex.ai).
2. Install the
   [`@flexai/openclaw-provider` plugin](https://hub.openclaw.ai/flexai/plugins/openclaw-provider)
   (OpenClaw 2026.11.6 or newer):

   ```bash
   openclaw plugins install @flexai/openclaw-provider
   ```

3. Run onboarding:

   ```bash
   openclaw onboard --auth-choice flexai-api-key
   ```

For non-interactive setup with a key already in the environment:

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --auth-choice flexai-api-key \
  --flexai-api-key "$FLEXAI_API_KEY"
```

Make the environment variable available to the Gateway process, not just your
interactive shell. See [Environment variables](/help/environment).

Verify configuration and select a model:

```bash
openclaw models list --provider flexai
openclaw models set flexai/DeepSeek-V4.1-Flash-1017
openclaw models fallbacks add flexai/GLM-5.3-Flash
```

## What the plugin registers

- **Chat:** the live chat catalog from `GET /v1/models`, with context windows,
  prices and image-input support, plus a bundled catalog for offline fallback.
  Streaming and function tool calling.
- **Vision:** image input on the models FlexAI lists with it, and
  `openclaw infer image describe` through the image-understanding capability.
- **Image generation, speech, transcription, embeddings and video generation:**
  each through its own OpenClaw capability. Embeddings can back `memory.search`.

Reranking and moderation models that FlexAI lists are not exposed.

The plugin owns FlexAI's model catalog and request compatibility. See
[FlexAI's OpenClaw guide](https://github.com/flexaihq/openclaw-flexai/blob/main/docs/flexai.md)
for model ids, discovery and pricing, per-capability settings and manual config.
