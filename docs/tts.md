---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Text-to-speech (TTS) for outbound replies"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Enabling text-to-speech for replies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Configuring TTS providers or limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Using /tts commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Text-to-Speech"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Text-to-speech (TTS)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can convert outbound replies into audio using ElevenLabs, OpenAI, or Edge TTS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It works anywhere OpenClaw can send audio; Telegram gets a round voice-note bubble.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Supported services（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **ElevenLabs** (primary or fallback provider)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **OpenAI** (primary or fallback provider; also used for summaries)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Edge TTS** (primary or fallback provider; uses `node-edge-tts`, default when no API keys)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Edge TTS notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Edge TTS uses Microsoft Edge's online neural TTS service via the `node-edge-tts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
library. It's a hosted service (not local), uses Microsoft’s endpoints, and does（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
not require an API key. `node-edge-tts` exposes speech configuration options and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
output formats, but not all options are supported by the Edge service. citeturn2search0（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Because Edge TTS is a public web service without a published SLA or quota, treat it（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
as best-effort. If you need guaranteed limits and support, use OpenAI or ElevenLabs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Microsoft's Speech REST API documents a 10‑minute audio limit per request; Edge TTS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
does not publish limits, so assume similar or lower limits. citeturn0search3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Optional keys（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want OpenAI or ElevenLabs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ELEVENLABS_API_KEY` (or `XI_API_KEY`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENAI_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Edge TTS does **not** require an API key. If no API keys are found, OpenClaw defaults（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to Edge TTS (unless disabled via `messages.tts.edge.enabled=false`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If multiple providers are configured, the selected provider is used first and the others are fallback options.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Auto-summary uses the configured `summaryModel` (or `agents.defaults.model.primary`),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
so that provider must also be authenticated if you enable summaries.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Service links（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [OpenAI Text-to-Speech guide](https://platform.openai.com/docs/guides/text-to-speech)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [OpenAI Audio API reference](https://platform.openai.com/docs/api-reference/audio)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ElevenLabs Authentication](https://elevenlabs.io/docs/api-reference/authentication)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Microsoft Speech output formats](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Is it enabled by default?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No. Auto‑TTS is **off** by default. Enable it in config with（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`messages.tts.auto` or per session with `/tts always` (alias: `/tts on`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Edge TTS **is** enabled by default once TTS is on, and is used automatically（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
when no OpenAI or ElevenLabs API keys are available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
TTS config lives under `messages.tts` in `openclaw.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full schema is in [Gateway configuration](/gateway/configuration).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Minimal config (enable + provider)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  messages: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      auto: "always",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      provider: "elevenlabs",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### OpenAI primary with ElevenLabs fallback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  messages: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      auto: "always",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      provider: "openai",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      summaryModel: "openai/gpt-4.1-mini",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      modelOverrides: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      openai: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "openai_api_key",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        model: "gpt-4o-mini-tts",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        voice: "alloy",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      elevenlabs: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "elevenlabs_api_key",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        baseUrl: "https://api.elevenlabs.io",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        voiceId: "voice_id",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        modelId: "eleven_multilingual_v2",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        seed: 42,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        applyTextNormalization: "auto",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        languageCode: "en",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        voiceSettings: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          stability: 0.5,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          similarityBoost: 0.75,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          style: 0.0,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          useSpeakerBoost: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          speed: 1.0,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Edge TTS primary (no API key)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  messages: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      auto: "always",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      provider: "edge",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      edge: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        voice: "en-US-MichelleNeural",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        lang: "en-US",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        rate: "+10%",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        pitch: "-5%",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Disable Edge TTS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  messages: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      edge: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Custom limits + prefs path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  messages: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      auto: "always",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      maxTextLength: 4000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      timeoutMs: 30000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      prefsPath: "~/.openclaw/settings/tts.json",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Only reply with audio after an inbound voice note（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  messages: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      auto: "inbound",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Disable auto-summary for long replies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  messages: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      auto: "always",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then run:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/tts summary off（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Notes on fields（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `auto`: auto‑TTS mode (`off`, `always`, `inbound`, `tagged`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `inbound` only sends audio after an inbound voice note.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `tagged` only sends audio when the reply includes `[[tts]]` tags.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `enabled`: legacy toggle (doctor migrates this to `auto`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `mode`: `"final"` (default) or `"all"` (includes tool/block replies).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `provider`: `"elevenlabs"`, `"openai"`, or `"edge"` (fallback is automatic).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `provider` is **unset**, OpenClaw prefers `openai` (if key), then `elevenlabs` (if key),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  otherwise `edge`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `summaryModel`: optional cheap model for auto-summary; defaults to `agents.defaults.model.primary`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Accepts `provider/model` or a configured model alias.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `modelOverrides`: allow the model to emit TTS directives (on by default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maxTextLength`: hard cap for TTS input (chars). `/tts audio` fails if exceeded.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timeoutMs`: request timeout (ms).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `prefsPath`: override the local prefs JSON path (provider/limit/summary).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `apiKey` values fall back to env vars (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `elevenlabs.baseUrl`: override ElevenLabs API base URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `elevenlabs.voiceSettings`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `stability`, `similarityBoost`, `style`: `0..1`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `useSpeakerBoost`: `true|false`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `speed`: `0.5..2.0` (1.0 = normal)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `elevenlabs.applyTextNormalization`: `auto|on|off`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `elevenlabs.languageCode`: 2-letter ISO 639-1 (e.g. `en`, `de`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `elevenlabs.seed`: integer `0..4294967295` (best-effort determinism)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `edge.enabled`: allow Edge TTS usage (default `true`; no API key).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `edge.voice`: Edge neural voice name (e.g. `en-US-MichelleNeural`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `edge.lang`: language code (e.g. `en-US`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `edge.outputFormat`: Edge output format (e.g. `audio-24khz-48kbitrate-mono-mp3`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - See Microsoft Speech output formats for valid values; not all formats are supported by Edge.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `edge.rate` / `edge.pitch` / `edge.volume`: percent strings (e.g. `+10%`, `-5%`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `edge.saveSubtitles`: write JSON subtitles alongside the audio file.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `edge.proxy`: proxy URL for Edge TTS requests.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `edge.timeoutMs`: request timeout override (ms).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Model-driven overrides (default on)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, the model **can** emit TTS directives for a single reply.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When `messages.tts.auto` is `tagged`, these directives are required to trigger audio.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When enabled, the model can emit `[[tts:...]]` directives to override the voice（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for a single reply, plus an optional `[[tts:text]]...[[/tts:text]]` block to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
provide expressive tags (laughter, singing cues, etc) that should only appear in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the audio.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example reply payload:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Here you go.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[[tts:text]](laughs) Read the song once more.[[/tts:text]]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Available directive keys (when enabled):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `provider` (`openai` | `elevenlabs` | `edge`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `voice` (OpenAI voice) or `voiceId` (ElevenLabs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `model` (OpenAI TTS model or ElevenLabs model id)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `applyTextNormalization` (`auto|on|off`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `languageCode` (ISO 639-1)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `seed`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Disable all model overrides:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  messages: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      modelOverrides: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional allowlist (disable specific overrides while keeping tags enabled):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  messages: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      modelOverrides: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        allowProvider: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        allowSeed: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Per-user preferences（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Slash commands write local overrides to `prefsPath` (default:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`~/.openclaw/settings/tts.json`, override with `OPENCLAW_TTS_PREFS` or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`messages.tts.prefsPath`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Stored fields:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `enabled`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `provider`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maxLength` (summary threshold; default 1500 chars)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `summarize` (default `true`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These override `messages.tts.*` for that host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Output formats (fixed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Telegram**: Opus voice note (`opus_48000_64` from ElevenLabs, `opus` from OpenAI).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 48kHz / 64kbps is a good voice-note tradeoff and required for the round bubble.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Other channels**: MP3 (`mp3_44100_128` from ElevenLabs, `mp3` from OpenAI).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 44.1kHz / 128kbps is the default balance for speech clarity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Edge TTS**: uses `edge.outputFormat` (default `audio-24khz-48kbitrate-mono-mp3`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `node-edge-tts` accepts an `outputFormat`, but not all formats are available（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    from the Edge service. citeturn2search0（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Output format values follow Microsoft Speech output formats (including Ogg/WebM Opus). citeturn1search0（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Telegram `sendVoice` accepts OGG/MP3/M4A; use OpenAI/ElevenLabs if you need（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    guaranteed Opus voice notes. citeturn1search1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If the configured Edge output format fails, OpenClaw retries with MP3.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenAI/ElevenLabs formats are fixed; Telegram expects Opus for voice-note UX.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Auto-TTS behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When enabled, OpenClaw:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- skips TTS if the reply already contains media or a `MEDIA:` directive.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- skips very short replies (< 10 chars).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- summarizes long replies when enabled using `agents.defaults.model.primary` (or `summaryModel`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- attaches the generated audio to the reply.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the reply exceeds `maxLength` and summary is off (or no API key for the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary model), audio（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
is skipped and the normal text reply is sent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Flow diagram（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Reply -> TTS enabled?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  no  -> send text（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  yes -> has media / MEDIA: / short?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          yes -> send text（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          no  -> length > limit?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                   no  -> TTS -> attach audio（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                   yes -> summary enabled?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                            no  -> send text（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                            yes -> summarize (summaryModel or agents.defaults.model.primary)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                                      -> TTS -> attach audio（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Slash command usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
There is a single command: `/tts`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Slash commands](/tools/slash-commands) for enablement details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Discord note: `/tts` is a built-in Discord command, so OpenClaw registers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`/voice` as the native command there. Text `/tts ...` still works.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/tts off（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/tts always（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/tts inbound（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/tts tagged（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/tts status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/tts provider openai（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/tts limit 2000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/tts summary off（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/tts audio Hello from OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Commands require an authorized sender (allowlist/owner rules still apply).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands.text` or native command registration must be enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `off|always|inbound|tagged` are per‑session toggles (`/tts on` is an alias for `/tts always`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `limit` and `summary` are stored in local prefs, not the main config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/tts audio` generates a one-off audio reply (does not toggle TTS on).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Agent tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `tts` tool converts text to speech and returns a `MEDIA:` path. When the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
result is Telegram-compatible, the tool includes `[[audio_as_voice]]` so（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Telegram sends a voice bubble.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway RPC（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway methods:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tts.status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tts.enable`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tts.disable`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tts.convert`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tts.setProvider`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tts.providers`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
