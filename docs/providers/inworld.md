---
summary: "Use Inworld's LLM router and streaming text-to-speech in OpenClaw"
read_when:
  - You want Inworld as an OpenAI-compatible LLM router
  - You want Inworld speech synthesis for outbound replies
  - You need PCM telephony or OGG_OPUS voice-note output from Inworld
title: "Inworld"
---

Inworld provides two capabilities in OpenClaw: an OpenAI-compatible **LLM
router** (`/v1/chat/completions`) and a streaming **text-to-speech**
endpoint. Both are served from `api.inworld.ai` and share a single
`INWORLD_API_KEY` for HTTP Basic auth.

| Property      | Value                                                           |
| ------------- | --------------------------------------------------------------- |
| Provider id   | `inworld`                                                       |
| Plugin        | official external package                                       |
| Contracts     | `providers` (LLM), `speechProviders` (TTS)                      |
| Auth env var  | `INWORLD_API_KEY` (HTTP Basic, Base64 dashboard credential)     |
| Base URL      | `https://api.inworld.ai`                                        |
| LLM API       | OpenAI-compatible chat completions (`/v1/chat/completions`)     |
| Default model | `inworld/auto` (Inworld picks the upstream model)               |
| TTS default   | voice `Sarah`, model `inworld-tts-1.5-max`                      |
| Output (TTS)  | MP3 (default), OGG_OPUS (voice notes), PCM 22050 Hz (telephony) |
| Website       | [inworld.ai](https://inworld.ai)                                |
| Docs          | [docs.inworld.ai](https://docs.inworld.ai)                      |

## Install plugin

Install the official plugin, then restart Gateway:

```bash
openclaw plugins install @openclaw/inworld-speech
openclaw gateway restart
```

## Getting started

<Steps>
  <Step title="Get your API key">
    Copy the credential from your Inworld dashboard (Workspace > API Keys).
    The value is sent verbatim as the HTTP Basic credential, so do not
    Base64-encode it again or convert it to a bearer token.

    ```
    INWORLD_API_KEY=<base64-credential-from-dashboard>
    ```

  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice inworld-api-key
    ```
  </Step>
  <Step title="(Optional) Switch to a specific model">
    Onboarding defaults to `inworld/auto`. Pick a concrete model later:

    ```bash
    openclaw models set inworld/<upstream-provider>/<model>
    ```

  </Step>
</Steps>

## Config example

```json5
{
  env: { INWORLD_API_KEY: "<base64-credential>" },
  agents: {
    defaults: {
      model: { primary: "inworld/auto" },
    },
  },
}
```

## Model references

<Note>
Model refs follow the pattern `inworld/<upstream-provider>/<model>`. The
full live catalog is discovered from `/llm/v1alpha/models` after the API
key is configured.
</Note>

Bundled fallback examples:

| Model ref                                   | Notes                         |
| ------------------------------------------- | ----------------------------- |
| `inworld/auto`                              | Inworld automatic routing     |
| `inworld/models/GLM-5.1`                    | GLM-5.1 via Z AI              |
| `inworld/models/gemma-4-31b-it`             | Gemma 4 31B via Google        |
| `inworld/models/gemma-4-26b-a4b-it`         | Gemma 4 26B via Google        |
| `inworld/models/deepseek-v4-pro`            | DeepSeek V4 Pro               |
| `inworld/models/deepseek-v4-flash`          | DeepSeek V4 Flash             |
| `inworld/anthropic/claude-opus-4-8`         | Claude Opus 4.8 via Anthropic |
| `inworld/google-ai-studio/gemini-3.5-flash` | Gemini 3.5 Flash via Google   |

## Text-to-speech

Inworld is a streaming TTS provider. Select it in `messages.tts`:

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "inworld",
      providers: {
        inworld: {
          speakerVoiceId: "Sarah",
          modelId: "inworld-tts-1.5-max",
        },
      },
    },
  },
}
```

Replies use MP3 by default. When the channel target is `voice-note` OpenClaw
asks Inworld for `OGG_OPUS` so the audio plays as a native voice bubble.
Telephony synthesis uses raw `PCM` at 22050 Hz to feed the telephony bridge.

| Option           | Path                                            | Description                                                       |
| ---------------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| `apiKey`         | `messages.tts.providers.inworld.apiKey`         | Base64 dashboard credential. Falls back to `INWORLD_API_KEY`.     |
| `baseUrl`        | `messages.tts.providers.inworld.baseUrl`        | Override Inworld API base URL (default `https://api.inworld.ai`). |
| `speakerVoiceId` | `messages.tts.providers.inworld.speakerVoiceId` | Voice identifier (default `Sarah`).                               |
| `modelId`        | `messages.tts.providers.inworld.modelId`        | TTS model id (default `inworld-tts-1.5-max`).                     |
| `temperature`    | `messages.tts.providers.inworld.temperature`    | Sampling temperature `0..2` (optional).                           |

Supported voice models: `inworld-tts-1.5-max` (default), `inworld-tts-1.5-mini`,
`inworld-tts-1-max`, `inworld-tts-1`.

## Authentication

Inworld uses HTTP Basic auth with a single Base64-encoded credential string.
Copy it verbatim from the Inworld dashboard. The provider sends it as
`Authorization: Basic <apiKey>` without any further encoding, so do not
Base64-encode it yourself and do not pass a bearer-style token. The same key
covers both the LLM and TTS surfaces.

## Related

<CardGroup cols={2}>
  <Card title="Text-to-speech" href="/tools/tts" icon="waveform-lines">
    TTS overview, providers, and `messages.tts` config.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="gear">
    Full config reference including `messages.tts` settings.
  </Card>
  <Card title="Providers" href="/providers" icon="grid">
    All supported OpenClaw providers.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    Common issues and debugging steps.
  </Card>
</CardGroup>
