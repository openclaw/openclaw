---
title: "Google (Gemini)"
summary: "Google Gemini setup (API key, image generation, media understanding, web search)"
read_when:
  - You want to use Google Gemini models with OpenClaw
  - You need the API key auth flow
---

# Google (Gemini)

The Google plugin provides access to Gemini models through Google AI Studio, plus
image generation, media understanding (image/audio/video), and web search via
Gemini Grounding.

- Provider: `google`
- Auth: `GEMINI_API_KEY` or `GOOGLE_API_KEY`
- API: Google Gemini API

## Quick start

1. Set the API key:

```bash
openclaw onboard --auth-choice gemini-api-key
```

2. Set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "google/gemini-3.1-pro-preview" },
    },
  },
}
```

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice gemini-api-key \
  --gemini-api-key "$GEMINI_API_KEY"
```

## Capabilities

| Capability             | Supported         |
| ---------------------- | ----------------- |
| Chat completions       | Yes               |
| Image generation       | Yes               |
| Image understanding    | Yes               |
| Audio transcription    | Yes               |
| Video understanding    | Yes               |
| Web search (Grounding) | Yes               |
| Thinking/reasoning     | Yes (Gemini 3.1+) |

## Direct Gemini cache reuse

For direct Gemini API runs (`api: "google-generative-ai"`), OpenClaw now
passes a configured `cachedContent` handle through to Gemini requests.

- Configure per-model or global params with either
  `cachedContent` or legacy `cached_content`
- If both are present, `cachedContent` wins
- Example value: `cachedContents/prebuilt-context`
- Gemini cache-hit usage is normalized into OpenClaw `cacheRead` from
  upstream `cachedContentTokenCount`

Example:

```json5
{
  agents: {
    defaults: {
      models: {
        "google/gemini-2.5-pro": {
          params: {
            cachedContent: "cachedContents/prebuilt-context",
          },
        },
      },
    },
  },
}
```

## Image generation

The bundled `google` image-generation provider defaults to
`google/gemini-3.1-flash-image-preview`.

- Also supports `google/gemini-3-pro-image-preview`
- Generate: up to 4 images per request
- Edit mode: enabled, up to 5 input images
- Geometry controls: `size`, `aspectRatio`, and `resolution`

Image generation, media understanding, and Gemini Grounding all stay on the
`google` provider id.

To use Google as the default image provider:

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "google/gemini-3.1-flash-image-preview",
      },
    },
  },
}
```

See [Image Generation](/tools/image-generation) for the shared tool
parameters, provider selection, and failover behavior.

## Video generation

The bundled `google` plugin also registers video generation through the shared
`video_generate` tool.

- Default video model: `google/veo-3.1-fast-generate-preview`
- Modes: text-to-video, image-to-video, and single-video reference flows
- Supports `aspectRatio`, `resolution`, and `audio`
- Current duration clamp: **4 to 8 seconds**

To use Google as the default video provider:

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "google/veo-3.1-fast-generate-preview",
      },
    },
  },
}
```

See [Video Generation](/tools/video-generation) for the shared tool
parameters, provider selection, and failover behavior.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `GEMINI_API_KEY`
is available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).
