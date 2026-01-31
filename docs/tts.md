---
summary: "Text-to-speech (TTS) for outbound replies"
read_when:
  - Enabling text-to-speech for replies
  - Configuring TTS providers or limits
  - Using /tts commands
title: "Text-to-Speech"
---

# Text-to-speech (TTS)

OpenClaw can convert outbound replies into audio using ElevenLabs, OpenAI, Deepdub or Edge TTS.
It works anywhere OpenClaw can send audio; Telegram gets a round voice-note bubble.

## Supported services

- **Deepdub** (primary or fallback provider; Low-latency HQ WebSocket streaming TTS)
- **ElevenLabs** (primary or fallback provider)
- **OpenAI** (primary or fallback provider; also used for summaries)
- **Edge TTS** (primary or fallback provider; uses `node-edge-tts`, default when no API keys)

### Deepdub notes

Deepdub uses a WebSocket streaming API for real-time TTS. It supports multiple voices,
locales, and expressive synthesis. Deepdub is particularly well-suited for telephony
applications as it supports mulaw encoding at 8kHz (Twilio-compatible).

Features:

- You can generate different emotions by changing voice prompt ids of the same speaker.
- Real-time streaming audio generation
- 40+ locales including multilingual support
- Multiple voice prompts and emotion styles
- Configurable temperature for voice variation
- Native telephony support (mulaw/8kHz)

Here's a good voice to use, and when:

```yaml
# Each emotion maps to a voicePromptId and includes a description for the AI

# Default voice prompt used when no emotion is specified
default: "59da0f21-63de-4aef-9ade-e5cabfe639ab"

# Available emotions with their voice prompt IDs and usage descriptions
emotions:
  slower:
    voicePromptId: "169a245f-6dc9-48fb-8f5e-2c53c5942450"
    description: "Use for calming situations, explaining complex information, or when clarity is important"

  fast:
    voicePromptId: "8988bba8-bada-40ba-990f-8c43bc851a18"
    description: "Use for energetic conversations, time-sensitive information, or enthusiastic responses"

  reading:
    voicePromptId: "2c7d9b19-f0c8-49fa-81ac-ec59fdb8e23f"
    description: "Use for neutral, informative content like reading facts, policies, or instructions"

  apologetic:
    voicePromptId: "6bfe6fa2-a013-4aa9-b8e0-c391e01611c6"
    description: "Use when expressing sympathy, apologizing for issues, or acknowledging customer frustration"

  formal:
    voicePromptId: "215d9ce7-244e-4fbb-ac85-02f0a3104b3f"
    description: "Use for professional contexts, important announcements, or corporate communications"

  informal:
    voicePromptId: "0c597f55-5bec-4873-ad12-2b115cb80281"
    description: "Use for friendly, casual conversations and building rapport"

  questions:
    voicePromptId: "f9cdb58c-d50b-4810-acfa-923e58c37007"
    description: "Use when asking questions or seeking information from the caller"

  reassuring:
    voicePromptId: "7578fca3-1f46-41bc-8da0-71daa92e93e3"
    description: "Use for calming anxious callers, providing comfort, or confirming successful resolutions"

  upsell:
    voicePromptId: "6a7ca34c-db7c-4eb2-871a-0427bb5ab689"
    description: "Use for promotional offers, suggesting upgrades, or highlighting additional services"

  conversational:
    voicePromptId: "dab93e7c-09a7-4ca4-b192-73fa219d11e9"
    description: "Use for natural, flowing dialogue and general conversation"
```

To get started with Deepdub:

1. Sign up at [app.deepdub.ai](https://app.deepdub.ai) to get a trial API key
2. Purchase additional credits directly via Stripe in the Deepdub dashboard

### Edge TTS notes

Edge TTS uses Microsoft Edge's online neural TTS service via the `node-edge-tts`
library. It's a hosted service (not local), uses Microsoft’s endpoints, and does
not require an API key. `node-edge-tts` exposes speech configuration options and
output formats, but not all options are supported by the Edge service. citeturn2search0

Because Edge TTS is a public web service without a published SLA or quota, treat it
as best-effort. If you need guaranteed limits and support, use OpenAI or ElevenLabs.
Microsoft's Speech REST API documents a 10‑minute audio limit per request; Edge TTS
does not publish limits, so assume similar or lower limits. citeturn0search3

## Optional keys

If you want OpenAI, Deepdub or ElevenLabs:

- `ELEVENLABS_API_KEY` (or `XI_API_KEY`)
- `OPENAI_API_KEY`
- `DEEPDUB_API_KEY`

Edge TTS does **not** require an API key. If no API keys are found, OpenClaw defaults
to Edge TTS (unless disabled via `messages.tts.edge.enabled=false`).

If multiple providers are configured, the selected provider is used first and the others are fallback options.
Auto-summary uses the configured `summaryModel` (or `agents.defaults.model.primary`),
so that provider must also be authenticated if you enable summaries.

## Service links

- [OpenAI Text-to-Speech guide](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API reference](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs Authentication](https://elevenlabs.io/docs/api-reference/authentication)
- [Deepdub](https://deepdub.ai/)
- [Deepdub Dashboard](https://app.deepdub.ai) (API keys and credits)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech output formats](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## Is it enabled by default?

No. Auto‑TTS is **off** by default. Enable it in config with
`messages.tts.auto` or per session with `/tts always` (alias: `/tts on`).

Edge TTS **is** enabled by default once TTS is on, and is used automatically
when no OpenAI or ElevenLabs API keys are available.

## Config

TTS config lives under `messages.tts` in `openclaw.json`.
Full schema is in [Gateway configuration](/gateway/configuration).

### Minimal config (enable + provider)

### Deepdub primary

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "deepdub",
      deepdub: {
        apiKey: "deepdub_api_key",
        wsUrl: "wss://wsapi.deepdub.ai/open",
        model: "dd-etts-3.0",
        voicePromptId: "59da0f21-63de-4aef-9ade-e5cabfe639ab",
        locale: "en-US",
        temperature: 1.0,
        format: "mp3",
        sampleRate: 24000,
      },
    },
  },
}
```

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "elevenlabs",
    },
  },
}
```

### OpenAI primary with ElevenLabs fallback

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "openai",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: {
        enabled: true,
      },
      openai: {
        apiKey: "openai_api_key",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
      elevenlabs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "voice_id",
        modelId: "eleven_multilingual_v2",
        seed: 42,
        applyTextNormalization: "auto",
        languageCode: "en",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0.0,
          useSpeakerBoost: true,
          speed: 1.0,
        },
      },
    },
  },
}
```

### Edge TTS primary (no API key)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "edge",
      edge: {
        enabled: true,
        voice: "en-US-MichelleNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        rate: "+10%",
        pitch: "-5%",
      },
    },
  },
}
```

### Disable Edge TTS

```json5
{
  messages: {
    tts: {
      edge: {
        enabled: false,
      },
    },
  },
}
```

### Custom limits + prefs path

```json5
{
  messages: {
    tts: {
      auto: "always",
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
    },
  },
}
```

### Only reply with audio after an inbound voice note

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### Disable auto-summary for long replies

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

Then run:

```
/tts summary off
```

### Notes on fields

- `auto`: auto‑TTS mode (`off`, `always`, `inbound`, `tagged`).
  - `inbound` only sends audio after an inbound voice note.
  - `tagged` only sends audio when the reply includes `[[tts]]` tags.
- `enabled`: legacy toggle (doctor migrates this to `auto`).
- `mode`: `"final"` (default) or `"all"` (includes tool/block replies).
- `provider`: `"deepdub"`, `"elevenlabs"`, `"openai"`, or `"edge"` (fallback is automatic).
- If `provider` is **unset**, OpenClaw prefers `openai` (if key), then `elevenlabs` (if key),
  then `deepdub` (if key), otherwise `edge`.
- `summaryModel`: optional cheap model for auto-summary; defaults to `agents.defaults.model.primary`.
  - Accepts `provider/model` or a configured model alias.
- `modelOverrides`: allow the model to emit TTS directives (on by default).
- `maxTextLength`: hard cap for TTS input (chars). `/tts audio` fails if exceeded.
- `timeoutMs`: request timeout (ms).
- `prefsPath`: override the local prefs JSON path (provider/limit/summary).
- `apiKey` values fall back to env vars (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`, `DEEPDUB_API_KEY`).
- `elevenlabs.baseUrl`: override ElevenLabs API base URL.
- `elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = normal)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: 2-letter ISO 639-1 (e.g. `en`, `de`)
- `elevenlabs.seed`: integer `0..4294967295` (best-effort determinism)
- `deepdub.wsUrl`: WebSocket URL (default: `wss://wsapi.deepdub.ai/open`).
- `deepdub.model`: TTS model (default: `dd-etts-3.0`).
- `deepdub.voicePromptId`: voice prompt ID for voice selection.
- `deepdub.locale`: locale for TTS (default: `en-US`). Supports 40+ locales.
- `deepdub.temperature`: voice variation.
- `deepdub.format`: audio format: `wav`, `mp3`, `opus`, `mulaw` (default: `mp3`).
- `deepdub.sampleRate`: 8000, 16000, 22050, 24000, 44100, 48000 (default: 24000).
- `edge.enabled`: allow Edge TTS usage (default `true`; no API key).
- `edge.voice`: Edge neural voice name (e.g. `en-US-MichelleNeural`).
- `edge.lang`: language code (e.g. `en-US`).
- `edge.outputFormat`: Edge output format (e.g. `audio-24khz-48kbitrate-mono-mp3`).
  - See Microsoft Speech output formats for valid values; not all formats are supported by Edge.
- `edge.rate` / `edge.pitch` / `edge.volume`: percent strings (e.g. `+10%`, `-5%`).
- `edge.saveSubtitles`: write JSON subtitles alongside the audio file.
- `edge.proxy`: proxy URL for Edge TTS requests.
- `edge.timeoutMs`: request timeout override (ms).

## Model-driven overrides (default on)

By default, the model **can** emit TTS directives for a single reply.
When `messages.tts.auto` is `tagged`, these directives are required to trigger audio.

When enabled, the model can emit `[[tts:...]]` directives to override the voice
for a single reply, plus an optional `[[tts:text]]...[[/tts:text]]` block to
provide expressive tags (laughter, singing cues, etc) that should only appear in
the audio.

Example reply payload:

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

Available directive keys (when enabled):

- `provider` (`openai` | `elevenlabs` | `deepdub` | `edge`)
- `voice` (OpenAI voice) or `voiceId` (ElevenLabs)
- `model` (OpenAI TTS model or ElevenLabs model id)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

Disable all model overrides:

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: false,
      },
    },
  },
}
```

Optional allowlist (disable specific overrides while keeping tags enabled):

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: true,
        allowProvider: false,
        allowSeed: false,
      },
    },
  },
}
```

## Per-user preferences

Slash commands write local overrides to `prefsPath` (default:
`~/.openclaw/settings/tts.json`, override with `OPENCLAW_TTS_PREFS` or
`messages.tts.prefsPath`).

Stored fields:

- `enabled`
- `provider`
- `maxLength` (summary threshold; default 1500 chars)
- `summarize` (default `true`)

These override `messages.tts.*` for that host.

## Output formats (fixed)

- **Telegram**: Opus voice note (`opus_48000_64` from ElevenLabs, `opus` from OpenAI).
  - 48kHz / 64kbps is a good voice-note tradeoff and required for the round bubble.
- **Other channels**: MP3 (`mp3_44100_128` from ElevenLabs, `mp3` from OpenAI).
  - 44.1kHz / 128kbps is the default balance for speech clarity.
- **Deepdub**: uses `deepdub.format` (default `mp3`).
  - Supports `wav`, `mp3`, `opus`, `mulaw` formats.
  - For Telegram, automatically uses `opus` for voice-note compatibility.
  - For telephony (Twilio), uses `mulaw` at 8kHz.
- **Edge TTS**: uses `edge.outputFormat` (default `audio-24khz-48kbitrate-mono-mp3`).
  - `node-edge-tts` accepts an `outputFormat`, but not all formats are available
    from the Edge service. citeturn2search0
  - Output format values follow Microsoft Speech output formats (including Ogg/WebM Opus). citeturn1search0
  - Telegram `sendVoice` accepts OGG/MP3/M4A; use OpenAI/ElevenLabs if you need
    guaranteed Opus voice notes. citeturn1search1
  - If the configured Edge output format fails, OpenClaw retries with MP3.

OpenAI/ElevenLabs/Deepdub formats are fixed; Telegram expects Opus for voice-note UX.

## Auto-TTS behavior

When enabled, OpenClaw:

- skips TTS if the reply already contains media or a `MEDIA:` directive.
- skips very short replies (< 10 chars).
- summarizes long replies when enabled using `agents.defaults.model.primary` (or `summaryModel`).
- attaches the generated audio to the reply.

If the reply exceeds `maxLength` and summary is off (or no API key for the
summary model), audio
is skipped and the normal text reply is sent.

## Flow diagram

```
Reply -> TTS enabled?
  no  -> send text
  yes -> has media / MEDIA: / short?
          yes -> send text
          no  -> length > limit?
                   no  -> TTS -> attach audio
                   yes -> summary enabled?
                            no  -> send text
                            yes -> summarize (summaryModel or agents.defaults.model.primary)
                                      -> TTS -> attach audio
```

## Slash command usage

There is a single command: `/tts`.
See [Slash commands](/tools/slash-commands) for enablement details.

Discord note: `/tts` is a built-in Discord command, so OpenClaw registers
`/voice` as the native command there. Text `/tts ...` still works.

```
/tts off
/tts always
/tts inbound
/tts tagged
/tts status
/tts provider openai
/tts limit 2000
/tts summary off
/tts audio Hello from OpenClaw
```

Notes:

- Commands require an authorized sender (allowlist/owner rules still apply).
- `commands.text` or native command registration must be enabled.
- `off|always|inbound|tagged` are per‑session toggles (`/tts on` is an alias for `/tts always`).
- `limit` and `summary` are stored in local prefs, not the main config.
- `/tts audio` generates a one-off audio reply (does not toggle TTS on).

## Agent tool

The `tts` tool converts text to speech and returns a `MEDIA:` path. When the
result is Telegram-compatible, the tool includes `[[audio_as_voice]]` so
Telegram sends a voice bubble.

## Gateway RPC

Gateway methods:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
