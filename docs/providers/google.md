---
summary: "Google Gemini setup (API key + OAuth, image generation, media understanding, TTS, web search)"
title: "Google (Gemini)"
read_when:
  - You want to use Google Gemini models with OpenClaw
  - You need the API key or OAuth auth flow
---

The Google plugin provides access to Gemini models through Google AI Studio, plus image generation, media understanding (image/audio/video), text-to-speech, and web search via Gemini Grounding.

- Provider: `google`
- Auth: `GEMINI_API_KEY` or `GOOGLE_API_KEY`
- API: Google Gemini API
- Runtime option: `agentRuntime.id: "google-gemini-cli"` reuses the official Gemini CLI OAuth cache while keeping model refs canonical as `google/*`.

## Getting started

Choose your preferred auth method and follow the setup steps.

<Tabs>
  <Tab title="API key">
    **Best for:** standard Gemini API access through Google AI Studio.

    <Steps>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice gemini-api-key
        ```

        Or pass the key directly:

        ```bash
        openclaw onboard --non-interactive \
          --mode local \
          --auth-choice gemini-api-key \
          --gemini-api-key "$GEMINI_API_KEY"
        ```
      </Step>
      <Step title="Set a default model">
        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "google/gemini-3.1-pro-preview" },
            },
          },
        }
        ```
      </Step>
      <Step title="Verify the model is available">
        ```bash
        openclaw models list --provider google
        ```
      </Step>
    </Steps>

    <Tip>
    `GEMINI_API_KEY` and `GOOGLE_API_KEY` are both accepted. Use whichever you already have configured.
    </Tip>

  </Tab>

  <Tab title="Gemini CLI (OAuth)">
    **Best for:** reusing credentials created by the official Gemini CLI without configuring a separate API key or an OpenClaw-owned OAuth client.

    <Steps>
      <Step title="Install the Gemini CLI">
        The local `gemini` command must be available on `PATH`.

        ```bash
        # Homebrew
        brew install gemini-cli

        # or npm
        npm install -g @google/gemini-cli
        ```

        OpenClaw supports both Homebrew installs and global npm installs, including
        common Windows/npm layouts.
      </Step>
      <Step title="Sign in with the official CLI">
        Run:

        ```bash
        gemini
        ```

        Choose **Sign in with Google** and complete the official Gemini CLI login.
      </Step>
      <Step title="Import the cache into OpenClaw">
        ```bash
        openclaw models auth login --provider google-gemini-cli --set-default
        ```

        OpenClaw imports `oauth_creds.json` from
        `GEMINI_CLI_HOME/.gemini/oauth_creds.json` when `GEMINI_CLI_HOME` is set,
        otherwise from `~/.gemini/oauth_creds.json`. It also validates the active
        account recorded in `google_accounts.json` before saving the profile.
      </Step>
      <Step title="Verify the model is available">
        ```bash
        openclaw models list --provider google
        ```
      </Step>
    </Steps>

    - Default model: `google/gemini-3.1-pro-preview`
    - Runtime: `google-gemini-cli`
    - Alias: `gemini-cli`

    Gemini 3.1 Pro's Gemini API model id is `gemini-3.1-pro-preview`. OpenClaw accepts the shorter `google/gemini-3.1-pro` as a convenience alias and normalizes it before provider calls.

    **Environment variables:**

    - `GEMINI_CLI_HOME` for a non-default Gemini CLI home
    - `GOOGLE_CLOUD_PROJECT` or `GOOGLE_CLOUD_PROJECT_ID` when a project must be pinned

    <Warning>
    OpenClaw does not launch or own a Google OAuth client for this runtime. If the
    imported cache expires, run `gemini` again and repeat the import. For API-key
    use, configure `GEMINI_API_KEY` with the `google` provider instead.
    </Warning>

    `google-gemini-cli/*` model refs are legacy compatibility aliases. New
    configs should use `google/*` model refs plus the `google-gemini-cli`
    runtime when they want local Gemini CLI execution.

  </Tab>
</Tabs>

<Note>
`google/gemini-3-pro-preview` was retired on 2026-03-09; use `google/gemini-3.1-pro-preview` instead. Re-running Gemini API key setup (`openclaw onboard --auth-choice gemini-api-key` or `openclaw models auth login --provider google`) rewrites a stale configured default to the current model.
</Note>

## Capabilities

| Capability             | Supported                     |
| ---------------------- | ----------------------------- |
| Chat completions       | Yes                           |
| Image generation       | Yes                           |
| Music generation       | Yes                           |
| Text-to-speech         | Yes                           |
| Realtime voice         | Yes (Google Live API)         |
| Image understanding    | Yes                           |
| Audio transcription    | Yes                           |
| Video understanding    | Yes                           |
| Web search (Grounding) | Yes                           |
| Thinking/reasoning     | Yes (Gemini 2.5+ / Gemini 3+) |
| Gemma 4 models         | Yes                           |

## Web search

The bundled `gemini` web-search provider uses Gemini Google Search grounding.
Configure a dedicated search key under `plugins.entries.google.config.webSearch`,
or let it reuse `models.providers.google.apiKey` after `GEMINI_API_KEY`:

```json5
{
  plugins: {
    entries: {
      google: {
        config: {
          webSearch: {
            apiKey: "AIza...", // optional if GEMINI_API_KEY or models.providers.google.apiKey is set
            baseUrl: "https://generativelanguage.googleapis.com/v1beta", // falls back to models.providers.google.baseUrl
            model: "gemini-2.5-flash",
          },
        },
      },
    },
  },
}
```

Credential precedence is dedicated `webSearch.apiKey`, then `GEMINI_API_KEY`,
then `models.providers.google.apiKey`. `webSearch.baseUrl` is optional and
exists for operator proxies or compatible Gemini API endpoints; when omitted,
Gemini web search reuses `models.providers.google.baseUrl`. See
[Gemini search](/tools/gemini-search) for the provider-specific tool behavior.

<Tip>
Gemini 3 models use `thinkingLevel` rather than `thinkingBudget`. OpenClaw maps
Gemini 3, Gemini 3.1, and `gemini-*-latest` alias reasoning controls to
`thinkingLevel` so default/low-latency runs do not send disabled
`thinkingBudget` values.

`/think adaptive` keeps Google's dynamic thinking semantics instead of choosing
a fixed OpenClaw level. Gemini 3 and Gemini 3.1 omit a fixed `thinkingLevel` so
Google can choose the level; Gemini 2.5 sends Google's dynamic sentinel
`thinkingBudget: -1`.

Gemma 4 models (for example `gemma-4-26b-a4b-it`) support thinking mode. OpenClaw
rewrites `thinkingBudget` to a supported Google `thinkingLevel` for Gemma 4.
Setting thinking to `off` preserves thinking disabled instead of mapping to
`MINIMAL`.

Gemini 2.5 Pro only works in thinking mode and rejects an explicit
`thinkingBudget: 0`; OpenClaw strips that value for Gemini 2.5 Pro requests
instead of sending it.
</Tip>

## Image generation

The bundled `google` image-generation provider defaults to
`google/gemini-3.1-flash-image-preview`.

- Also supports `google/gemini-3-pro-image-preview`
- Generate: up to 4 images per request
- Edit mode: enabled, up to 5 input images
- Geometry controls: `size`, `aspectRatio`, and `resolution`

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

<Note>
See [Image Generation](/tools/image-generation) for shared tool parameters, provider selection, and failover behavior.
</Note>

## Video generation

The bundled `google` plugin also registers video generation through the shared
`video_generate` tool.

- Default video model: `google/veo-3.1-fast-generate-preview`
- Modes: text-to-video, image-to-video, and single-video reference flows
- Supports `aspectRatio` (`16:9`, `9:16`) and `resolution` (`720P`, `1080P`); audio output is not supported by Veo today
- Supported durations: **4, 6, or 8 seconds** (other values snap to the nearest allowed value)

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

<Note>
See [Video Generation](/tools/video-generation) for shared tool parameters, provider selection, and failover behavior.
</Note>

## Music generation

The bundled `google` plugin also registers music generation through the shared
`music_generate` tool.

- Default music model: `google/lyria-3-clip-preview`
- Also supports `google/lyria-3-pro-preview`
- Prompt controls: `lyrics` and `instrumental`
