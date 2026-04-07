---
summary: "Use Vydra image, video, and speech in OpenClaw"
read_when:
  - You want Vydra media generation in OpenClaw
  - You need Vydra API key setup guidance
title: "Vydra"
---

# Vydra

The bundled Vydra plugin adds:

- image generation via `vydra/grok-imagine`
- video generation via `vydra/veo3` and `vydra/kling`
- speech synthesis via Vydra's ElevenLabs-backed TTS route

OpenClaw uses the same `VYDRA_API_KEY` for all three capabilities.

## Important base URL

Use `https://www.vydra.ai/api/v1`.

Vydra's apex host (`https://vydra.ai/api/v1`) currently redirects to `www`. Some HTTP clients drop `Authorization` on that cross-host redirect, which turns a valid API key into a misleading auth failure. The bundled plugin uses the `www` base URL directly to avoid that.

## Setup

Interactive onboarding:

```bash
openclaw onboard --auth-choice vydra-api-key
```

Or set the env var directly:

```bash
export VYDRA_API_KEY="vydra_live_..."
```

## Image generation

Default image model:

- `vydra/grok-imagine`

Set it as the default image provider:

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "vydra/grok-imagine",
      },
    },
  },
}
```

Current bundled support is text-to-image only. Vydra's hosted edit routes expect remote image URLs, and OpenClaw does not add a Vydra-specific upload bridge in the bundled plugin yet.

See [Image Generation](/tools/image-generation) for shared tool behavior.

## Video generation

Registered video models:

- `vydra/veo3` for text-to-video
- `vydra/kling` for image-to-video

Set Vydra as the default video provider:

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "vydra/veo3",
      },
    },
  },
}
```

Notes:

- `vydra/veo3` is bundled as text-to-video only.
- `vydra/kling` currently requires a remote image URL reference. Local file uploads are rejected up front.
- Vydra's current `kling` HTTP route has been inconsistent about whether it requires `image_url` or `video_url`; the bundled provider maps the same remote image URL into both fields.
- The bundled plugin stays conservative and does not forward undocumented style knobs such as aspect ratio, resolution, watermark, or generated audio.

Provider-specific live coverage:

```bash
OPENCLAW_LIVE_TEST=1 \
OPENCLAW_LIVE_VYDRA_VIDEO=1 \
pnpm test:live -- extensions/vydra/vydra.live.test.ts
```

The bundled Vydra live file now covers:

- `vydra/veo3` text-to-video
- `vydra/kling` image-to-video using a remote image URL

Override the remote image fixture when needed:

```bash
export OPENCLAW_LIVE_VYDRA_KLING_IMAGE_URL="https://example.com/reference.png"
```

See [Video Generation](/tools/video-generation) for shared tool behavior.

## Speech synthesis

Set Vydra as the speech provider:

```json5
{
  messages: {
    tts: {
      provider: "vydra",
      providers: {
        vydra: {
          apiKey: "${VYDRA_API_KEY}",
          voiceId: "21m00Tcm4TlvDq8ikWAM",
        },
      },
    },
  },
}
```

Defaults:

- model: `elevenlabs/tts`
- voice id: `21m00Tcm4TlvDq8ikWAM`

The bundled plugin currently exposes one known-good default voice and returns MP3 audio files.

## Related

- [Provider Directory](/providers/index)
- [Image Generation](/tools/image-generation)
- [Video Generation](/tools/video-generation)
