---
summary: "Text-to-speech (TTS) for outbound replies"
read_when:
  - Enabling text-to-speech for replies
  - Configuring TTS providers or limits
  - Using /tts commands
title: "Text-to-Speech (legacy path)"
---

# Text-to-speech (TTS)

OpenClaw can convert outbound replies into audio using ElevenLabs, Fish Audio, Microsoft, or OpenAI.
It works anywhere OpenClaw can send audio.

## Supported services

- **ElevenLabs** (primary or fallback provider)
- **Fish Audio** (primary or fallback provider; supports voice cloning)
- **Microsoft** (primary or fallback provider; current bundled implementation uses `node-edge-tts`)
- **OpenAI** (primary or fallback provider; also used for summaries)

### Microsoft speech notes

The bundled Microsoft speech provider currently uses Microsoft Edge's online
neural TTS service via the `node-edge-tts` library. It's a hosted service (not
local), uses Microsoft endpoints, and does not require an API key.
`node-edge-tts` exposes speech configuration options and output formats, but
not all options are supported by the service. Legacy config and directive input
using `edge` still works and is normalized to `microsoft`.

Because this path is a public web service without a published SLA or quota,
treat it as best-effort. If you need guaranteed limits and support, use OpenAI
or ElevenLabs.

## Optional keys

If you want OpenAI, ElevenLabs, or Fish Audio:

- `ELEVENLABS_API_KEY` (or `XI_API_KEY`)
- `FISH_AUDIO_API_KEY`
- `OPENAI_API_KEY`

Microsoft speech does **not** require an API key.

If multiple providers are configured, the selected provider is used first and the others are fallback options.
Auto-summary uses the configured `summaryModel` (or `agents.defaults.model.primary`),
so that provider must also be authenticated if you enable summaries.

## Service links

- [OpenAI Text-to-Speech guide](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API reference](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs Authentication](https://elevenlabs.io/docs/api-reference/authentication)
- [Fish Audio TTS API](https://docs.fish.audio/api-reference/tts)
- [Fish Audio Voice Cloning](https://fish.audio)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech output formats](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## Is it enabled by default?

No. Auto‑TTS is **off** by default. Enable it in config with
`messages.tts.auto` or per session with `/tts always` (alias: `/tts on`).

When `messages.tts.provider` is unset, OpenClaw picks the first configured
speech provider in registry auto-select order.

## Config

TTS config lives under `messages.tts` in `openclaw.json`.
Full schema is in [Gateway configuration](/gateway/configuration).

### Minimal config (enable + provider)

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
      providers: {
        openai: {
          apiKey: "openai_api_key",
          baseUrl: "https://api.openai.com/v1",
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
  },
}
```

### Microsoft primary (no API key)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "microsoft",
      providers: {
        microsoft: {
          enabled: true,
          voice: "en-US-MichelleNeural",
          lang: "en-US",
          outputFormat: "audio-24khz-48kbitrate-mono-mp3",
          rate: "+10%",
          pitch: "-5%",
        },
      },
    },
  },
}
```

### Fish Audio with voice cloning

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "fish-audio",
      providers: {
        "fish-audio": {
          apiKey: "fish_audio_api_key",
          voiceId: "your-voice-reference-id", // from fish.audio
          model: "s2-pro",      // s2-pro | s1
          latency: "normal",    // normal | balanced | low
          // speed: 1.0,        // 0.5–2.0 (optional)
        },
      },
    },
  },
}
```

### Disable Microsoft speech

```json5
{
  messages: {
    tts: {
      providers: {
        microsoft: {
          enabled: false,
        },
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

### Only reply with audio after an inbound voice message

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
  - `inbound` only sends audio after an inbound voice message.
  - `tagged` only sends audio when the reply includes `[[tts]]` tags.
- `enabled`: legacy toggle (doctor migrates this to `auto`).
- `mode`: `"final"` (default) or `"all"` (includes tool/block replies).
- `provider`: speech provider id such as `"elevenlabs"`, `"fish-audio"`, `"microsoft"`, or `"openai"` (fallback is automatic).
- If `provider` is **unset**, OpenClaw uses the first configured speech provider in registry auto-select order.
- Legacy `provider: "edge"` still works and is normalized to `microsoft`.
- `summaryModel`: optional cheap model for auto-summary; defaults to `agents.defaults.model.primary`.
  - Accepts `provider/model` or a configured model alias.
- `modelOverrides`: allow the model to emit TTS directives (on by default).
  - `allowProvider` defaults to `false` (provider switching is opt-in).
- `providers.<id>`: provider-owned settings keyed by speech provider id.
- Legacy direct provider blocks (`messages.tts.openai`, `messages.tts.elevenlabs`, `messages.tts.microsoft`, `messages.tts.edge`) are auto-migrated to `messages.tts.providers.<id>` on load.
- `maxTextLength`: hard cap for TTS input (chars). `/tts audio` fails if exceeded.
- `timeoutMs`: request timeout (ms).
- `prefsPath`: override the local prefs JSON path (provider/limit/summary).
- `apiKey` values fall back to env vars (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `FISH_AUDIO_API_KEY`, `OPENAI_API_KEY`).
- `providers.elevenlabs.baseUrl`: override ElevenLabs API base URL.
- `providers.openai.baseUrl`: override the OpenAI TTS endpoint.
  - Resolution order: `messages.tts.providers.openai.baseUrl` -> `OPENAI_TTS_BASE_URL` -> `https://api.openai.com/v1`
  - Non-default values are treated as OpenAI-compatible TTS endpoints, so custom model and voice names are accepted.
- `providers.elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = normal)
- `providers.elevenlabs.applyTextNormalization`: `auto|on|off`
- `providers.elevenlabs.languageCode`: 2-letter ISO 639-1 (e.g. `en`, `de`)
- `providers.elevenlabs.seed`: integer `0..4294967295` (best-effort determinism)
- `providers.fish-audio.apiKey`: Fish Audio API key (or `FISH_AUDIO_API_KEY` env var).
- `providers.fish-audio.voiceId`: voice reference ID from [fish.audio](https://fish.audio) (**required**).
- `providers.fish-audio.model`: TTS model (`s2-pro` default, `s1`).
- `providers.fish-audio.latency`: latency mode (`normal` default, `balanced`, `low`).
- `providers.fish-audio.speed`: prosody speed `0.5..2.0` (1.0 = normal).
- `providers.fish-audio.temperature`: sampling temperature `0..1`.
- `providers.fish-audio.topP`: top-p sampling `0..1`.
- `providers.fish-audio.baseUrl`: override Fish Audio API base URL.
- `providers.microsoft.enabled`: allow Microsoft speech usage (default `true`; no API key).
- `providers.microsoft.voice`: Microsoft neural voice name (e.g. `en-US-MichelleNeural`).
- `providers.microsoft.lang`: language code (e.g. `en-US`).
- `providers.microsoft.outputFormat`: Microsoft output format (e.g. `audio-24khz-48kbitrate-mono-mp3`).
  - See Microsoft Speech output formats for valid values; not all formats are supported by the bundled Edge-backed transport.
- `providers.microsoft.rate` / `providers.microsoft.pitch` / `providers.microsoft.volume`: percent strings (e.g. `+10%`, `-5%`).
- `providers.microsoft.saveSubtitles`: write JSON subtitles alongside the audio file.
- `providers.microsoft.proxy`: proxy URL for Microsoft speech requests.
- `providers.microsoft.timeoutMs`: request timeout override (ms).
- `edge.*`: legacy alias for the same Microsoft settings.

## Model-driven overrides (default on)

By default, the model **can** emit TTS directives for a single reply.
When `messages.tts.auto` is `tagged`, these directives are required to trigger audio.

When enabled, the model can emit `[[tts:...]]` directives to override the voice
for a single reply, plus an optional `[[tts:text]]...[[/tts:text]]` block to
provide expressive tags (laughter, singing cues, etc) that should only appear in
the audio.

`provider=...` directives are ignored unless `modelOverrides.allowProvider: true`.

Example reply payload:

```
Here you go.

[[tts:voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

Available directive keys (when enabled):

- `provider` (registered speech provider id, for example `openai`, `elevenlabs`, `fish-audio`, or `microsoft`; requires `allowProvider: true`)
- `voice` (OpenAI voice), `voiceId` (ElevenLabs reference ID)
- `model` (OpenAI TTS model), `elevenlabs_model` (ElevenLabs model id)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost` (ElevenLabs)
- `fishaudio_voice` / `fish_voice` (Fish Audio voice reference ID)
- `fishaudio_model` / `fish_model` (Fish Audio model: `s2-pro`, `s1`)
- `fishaudio_speed` / `fish_speed` (Fish Audio prosody speed `0.5..2.0`)
- `fishaudio_latency` / `fish_latency` (Fish Audio: `normal`, `balanced`, `low`)
- `fishaudio_temperature` / `fish_temperature`, `fishaudio_top_p` / `fish_top_p` (Fish Audio sampling)
- `applyTextNormalization` (`auto|on|off`) (ElevenLabs)
- `languageCode` (ISO 639-1) (ElevenLabs)
- `seed` (ElevenLabs)

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

Optional allowlist (enable provider switching while keeping other knobs configurable):

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: true,
        allowProvider: true,
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

- **Feishu / Matrix / Telegram / WhatsApp**: Opus voice message (`opus_48000_64` from ElevenLabs, `opus` from Fish Audio/OpenAI).
  - 48kHz / 64kbps is a good voice message tradeoff.
- **Other channels**: MP3 (`mp3_44100_128` from ElevenLabs, `mp3` from Fish Audio/OpenAI).
  - 44.1kHz / 128kbps is the default balance for speech clarity.
- **Microsoft**: uses `microsoft.outputFormat` (default `audio-24khz-48kbitrate-mono-mp3`).
  - The bundled transport accepts an `outputFormat`, but not all formats are available from the service.
  - Output format values follow Microsoft Speech output formats (including Ogg/WebM Opus).
  - Telegram `sendVoice` accepts OGG/MP3/M4A; use OpenAI/ElevenLabs if you need
    guaranteed Opus voice messages.
  - If the configured Microsoft output format fails, OpenClaw retries with MP3.

OpenAI/ElevenLabs/Fish Audio output formats are fixed per channel (see above).
Fish Audio Opus output (voice-note channels) is `voiceCompatible`; MP3 output (other channels) is not.

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
- `/tts status` includes fallback visibility for the latest attempt:
  - success fallback: `Fallback: <primary> -> <used>` plus `Attempts: ...`
  - failure: `Error: ...` plus `Attempts: ...`
  - detailed diagnostics: `Attempt details: provider:outcome(reasonCode) latency`
- OpenAI and ElevenLabs API failures now include parsed provider error detail and request id (when returned by the provider), which is surfaced in TTS errors/logs.

## Agent tool

The `tts` tool converts text to speech and returns an audio attachment for
reply delivery. When the channel is Feishu, Matrix, Telegram, or WhatsApp,
the audio is delivered as a voice message rather than a file attachment.

## Gateway RPC

Gateway methods:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
