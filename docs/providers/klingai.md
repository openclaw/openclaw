---
title: "KlingAI"
summary: "KlingAI image and video generation setup in OpenClaw"
read_when:
  - You want to use KlingAI image generation in OpenClaw
  - You want to use KlingAI video generation in OpenClaw
  - You need KlingAI API key onboarding and model defaults
---

# KlingAI

OpenClaw ships a bundled `klingai` provider for hosted image and video generation.

- Provider: `klingai`
- Auth: `KLING_API_KEY`
- API: KlingAI async task endpoints

## Quick start

1. Authenticate with your API key:

```bash
openclaw onboard --auth-choice klingai-global-api
# or
openclaw onboard --auth-choice klingai-cn-api
```

2. Set defaults (optional, but recommended):

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "klingai/kling-v3",
      },
      videoGenerationModel: {
        primary: "klingai/kling-v3",
      },
    },
  },
}
```

Onboarding choices map to base URLs:

- `klingai-global-api`: `https://api-singapore.klingai.com`
- `klingai-cn-api`: `https://api-beijing.klingai.com`

## Image generation

The bundled `klingai` image-generation provider supports:

- Default model: `klingai/kling-v3`
- Also available: `klingai/kling-v3-omni`
- Generate: up to 4 images per request
- Edit mode: enabled, up to 1 reference image
- Supports `aspectRatio` and `resolution`
- Supported aspect ratios: `16:9`, `9:16`, `1:1`
- Supported resolutions: `1K`, `2K`, `4K`

Current model caveat:

- `kling-v3` does not support `4K` image generation. Use `kling-v3-omni` for `4K`.

To use KlingAI as the default image provider:

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "klingai/kling-v3",
      },
    },
  },
}
```

## Video generation

The bundled `klingai` video-generation provider supports:

- Default model: `klingai/kling-v3`
- Also available: `klingai/kling-v3-omni`
- Modes: text-to-video and single-image reference flows
- Duration: 3 to 15 seconds
- Supports `aspectRatio`, `resolution`, `audio`, and `watermark`
- Supported aspect ratios: `16:9`, `9:16`, `1:1`
- Supported resolutions: `720P`, `1080P`
- Video reference inputs are not supported

Current model caveat:

- `kling-v3` does not support `aspectRatio` override in image-to-video mode. Use `kling-v3-omni` when you need image-to-video with explicit aspect ratio.

To use KlingAI as the default video provider:

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "klingai/kling-v3",
      },
    },
  },
}
```

## Configuration notes

- Optional provider base URL: `models.providers.klingai.baseUrl`
- If unset, OpenClaw uses `https://api-singapore.klingai.com`
- Runtime uses async submit/poll/result flow for long-running jobs

## Related

- [Image Generation](/tools/image-generation)
- [Video Generation](/tools/video-generation)
- [Configuration Reference](/gateway/configuration-reference#agent-defaults)
