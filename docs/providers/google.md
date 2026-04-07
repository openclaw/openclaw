---
title: "Google (Gemini)"
summary: "Google Gemini setup (API key + OAuth, image generation, media understanding, web search)"
read_when:
  - You want to use Google Gemini models with OpenClaw
  - You need the API key or OAuth auth flow
---

# Google (Gemini)

The Google plugin provides access to Gemini models through Google AI Studio, plus
image generation, media understanding (image/audio/video), and web search via
Gemini Grounding.

- Provider: `google`
- Auth: `GEMINI_API_KEY` or `GOOGLE_API_KEY`
- API: Google Gemini API
- Alternative provider: `google-gemini-cli` (OAuth)

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

## OAuth (Gemini CLI)

An alternative provider `google-gemini-cli` uses PKCE OAuth instead of an API
key. This is an unofficial integration; some users report account
restrictions. Use at your own risk.

- Default model: `google-gemini-cli/gemini-3-flash-preview`
- Alias: `gemini-cli`
- Install prerequisite: local Gemini CLI available as `gemini`
  - Homebrew: `brew install gemini-cli`
  - npm: `npm install -g @google/gemini-cli`
- Login:

```bash
openclaw models auth login --provider google-gemini-cli --set-default
```

Environment variables:

- `OPENCLAW_GEMINI_OAUTH_CLIENT_ID`
- `OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET`

(Or the `GEMINI_CLI_*` variants.)

If Gemini CLI OAuth requests fail after login, set
`GOOGLE_CLOUD_PROJECT` or `GOOGLE_CLOUD_PROJECT_ID` on the gateway host and
retry.

If login fails before the browser flow starts, make sure the local `gemini`
command is installed and on `PATH`. OpenClaw supports both Homebrew installs
and global npm installs, including common Windows/npm layouts.

Gemini CLI JSON usage notes:

- Reply text comes from the CLI JSON `response` field.
- Usage falls back to `stats` when the CLI leaves `usage` empty.
- `stats.cached` is normalized into OpenClaw `cacheRead`.
- If `stats.input` is missing, OpenClaw derives input tokens from
  `stats.input_tokens - stats.cached`.

## Capabilities

| Capability             | Supported         |
| ---------------------- | ----------------- |
| Chat completions       | Yes               |
| Image generation       | Yes               |
| Music generation       | Yes               |
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

The OAuth-only `google-gemini-cli` provider is a separate text-inference
surface. Image generation, media understanding, and Gemini Grounding stay on
the `google` provider id.

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

## Music generation

The bundled `google` plugin also registers music generation through the shared
`music_generate` tool.

- Default music model: `google/lyria-3-clip-preview`
- Also supports `google/lyria-3-pro-preview`
- Prompt controls: `lyrics` and `instrumental`
- Output format: `mp3` by default, plus `wav` on `google/lyria-3-pro-preview`
- Reference inputs: up to 10 images
- Session-backed runs detach through the shared task/status flow, including `action: "status"`

To use Google as the default music provider:

```json5
{
  agents: {
    defaults: {
      musicGenerationModel: {
        primary: "google/lyria-3-clip-preview",
      },
    },
  },
}
```

See [Music Generation](/tools/music-generation) for the shared tool
parameters, provider selection, and failover behavior.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `GEMINI_API_KEY`
is available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).
