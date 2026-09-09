---
summary: "Turn on text-to-speech, pick a provider, and send a first audio reply"
title: "Text-to-speech quickstart"
read_when:
  - You are enabling text-to-speech for the first time
  - You need the list of supported speech providers and their auth env vars
  - You want to confirm TTS works from chat
---

## Quick start

<Steps>
  <Step title="Pick a provider">
    OpenAI and ElevenLabs are the most reliable hosted options. Microsoft and
    Local CLI work without an API key. See the [provider matrix](#supported-providers)
    for the full list.
  </Step>
  <Step title="Set the API key">
    Export the env var for your provider (for example `OPENAI_API_KEY`,
    `ELEVENLABS_API_KEY`). Microsoft and Local CLI need no key.
  </Step>
  <Step title="Enable in config">
    Set `tts.auto: "always"` and `tts.provider`:

    ```json5
    {
      tts: {
        auto: "always",
        provider: "elevenlabs",
      },
    }
    ```

  </Step>
  <Step title="Try it in chat">
    `/tts status` shows the current state. `/tts audio Hello from OpenClaw`
    sends a one-off audio reply.
  </Step>
</Steps>

<Note>
Auto-TTS is **off** by default. When `tts.provider` is unset,
OpenClaw picks the first configured provider in registry auto-select order.
The built-in `tts` agent tool is explicit-intent only: ordinary chat stays
text unless the user asks for audio, uses `/tts`, or enables Auto-TTS/directive
speech.
</Note>

## Supported providers

| Provider          | Auth                                                                                                             | Notes                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Azure Speech**  | `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` (also `AZURE_SPEECH_API_KEY`, `SPEECH_KEY`, `SPEECH_REGION`)          | Native Ogg/Opus voice-note output and telephony.                                            |
| **DeepInfra**     | `DEEPINFRA_API_KEY`                                                                                              | OpenAI-compatible TTS. Defaults to `hexgrad/Kokoro-82M`.                                    |
| **ElevenLabs**    | `ELEVENLABS_API_KEY` or `XI_API_KEY`                                                                             | Voice cloning, multilingual, deterministic via `seed`; streamed for Discord voice playback. |
| **Fish Audio**    | `FISH_API_KEY` or `FISH_AUDIO_API_KEY`                                                                           | S2.1 hosted TTS, expressive tags, voice discovery, streaming, and telephony.                |
| **Google Gemini** | `GEMINI_API_KEY` or `GOOGLE_API_KEY`                                                                             | Gemini API batch TTS; persona-aware via `promptTemplate: "audio-profile-v1"`.               |
| **Gradium**       | `GRADIUM_API_KEY`                                                                                                | Voice-note and telephony output.                                                            |
| **Inworld**       | `INWORLD_API_KEY`                                                                                                | Streaming TTS API. Native Opus voice-note and PCM telephony.                                |
| **Local CLI**     | none                                                                                                             | Runs a configured local TTS command.                                                        |
| **Microsoft**     | none                                                                                                             | Public Edge neural TTS via `node-edge-tts`. Best-effort, no SLA.                            |
| **MiniMax**       | `MINIMAX_API_KEY` (or Token Plan: `MINIMAX_OAUTH_TOKEN`, `MINIMAX_CODE_PLAN_KEY`, `MINIMAX_CODING_API_KEY`)      | T2A v2 API. Defaults to `speech-2.8-hd`.                                                    |
| **OpenAI**        | `OPENAI_API_KEY`                                                                                                 | Also used for auto-summary; supports persona `instructions`.                                |
| **OpenRouter**    | `OPENROUTER_API_KEY` (can reuse `models.providers.openrouter.apiKey`)                                            | Default model `hexgrad/kokoro-82m`.                                                         |
| **Volcengine**    | `VOLCENGINE_TTS_API_KEY` or `BYTEPLUS_SEED_SPEECH_API_KEY` (legacy AppID/token: `VOLCENGINE_TTS_APPID`/`_TOKEN`) | BytePlus Seed Speech HTTP API.                                                              |
| **Vydra**         | `VYDRA_API_KEY`                                                                                                  | Shared image, video, and speech provider.                                                   |
| **xAI**           | `XAI_API_KEY`                                                                                                    | xAI batch TTS. Native Opus voice-note is **not** supported.                                 |
| **Xiaomi MiMo**   | `XIAOMI_API_KEY`                                                                                                 | MiMo TTS through Xiaomi chat completions.                                                   |

If multiple providers are configured, the selected one is used first and the
others are fallback options. Auto-summary uses `summaryModel` (or
`agents.defaults.model.primary`), so that provider must also be authenticated
if you keep summaries enabled.

<Warning>
The bundled **Microsoft** provider uses Microsoft Edge's online neural TTS
service via `node-edge-tts`. It is a public web service without a published
SLA or quota — treat it as best-effort. The legacy provider id `edge` is
normalized to `microsoft` and `openclaw doctor --fix` rewrites persisted
config; new configs should always use `microsoft`.
</Warning>
