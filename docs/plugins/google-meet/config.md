---
summary: "Google Meet plugin config defaults, overrides, and provider examples"
read_when:
  - You are looking up a Google Meet plugin config key and its default
  - You are pointing Google Meet at a specific realtime or TTS provider
  - You are configuring the Twilio dial plan for Google Meet
title: "Google Meet configuration"
sidebarTitle: "Configuration"
---

Plugin config defaults, optional overrides, and the ElevenLabs and Twilio config examples. Part of the [Google Meet plugin](/plugins/google-meet) guide.

## Config

The common Chrome agent path only needs the plugin enabled, BlackHole, SoX, a realtime provider key, and a configured OpenClaw TTS provider:

```json5
{
  plugins: {
    entries: {
      "google-meet": {
        enabled: true,
        config: {},
      },
    },
  },
}
```

### Defaults

| Key                               | Default                                  | Notes                                                                                                                                                                                                             |
| --------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultTransport`                | `"chrome"`                               |                                                                                                                                                                                                                   |
| `defaultMode`                     | `"agent"`                                | `"realtime"` is accepted as a legacy alias for `"agent"`; new callers should say `"agent"`                                                                                                                        |
| `chromeNode.node`                 | unset                                    | Node id/name/IP for `chrome-node`; required when more than one capable node may be connected                                                                                                                      |
| `chrome.launch`                   | `true`                                   | Launch Chrome for the join; set `false` only when reusing an already-open session                                                                                                                                 |
| `chrome.audioBackend`             | `"auto"`                                 | Selects `blackhole-2ch` on macOS or `pipewire-pulse` on Linux; set an explicit backend when a paired Chrome node uses a different OS than the Gateway                                                             |
| `chrome.guestName`                | `"OpenClaw Agent"`                       | Shown on the signed-out Meet guest screen                                                                                                                                                                         |
| `chrome.autoJoin`                 | `true`                                   | Best-effort guest-name fill and Join Now click on `chrome-node`                                                                                                                                                   |
| `chrome.reuseExistingTab`         | `true`                                   | Activates an existing Meet tab instead of opening duplicates                                                                                                                                                      |
| `chrome.waitForInCallMs`          | `20000`                                  | Wait for the Meet tab to report in-call before the talk-back intro fires                                                                                                                                          |
| `chrome.audioFormat`              | `"pcm16-24khz"`                          | Command-pair audio format; `"g711-ulaw-8khz"` is only for legacy/custom command pairs that emit telephony audio                                                                                                   |
| `chrome.audioBufferBytes`         | `4096`                                   | Processing buffer used to derive generated command latency; values are clamped to a minimum of 17 bytes                                                                                                           |
| `chrome.audioInputCommand`        | generated native command                 | SoX/CoreAudio on macOS; `parec` from the OpenClaw PipeWire-Pulse source on Linux                                                                                                                                  |
| `chrome.audioOutputCommand`       | generated native command                 | SoX/CoreAudio on macOS; `pacat` into the OpenClaw PipeWire-Pulse sink on Linux                                                                                                                                    |
| `chrome.bargeInInputCommand`      | unset                                    | Optional local microphone command writing signed 16-bit little-endian mono PCM for human barge-in detection during assistant playback; applies to the Gateway-hosted command-pair bridge                          |
| `chrome.bargeInRmsThreshold`      | `650`                                    | RMS level counted as human interruption                                                                                                                                                                           |
| `chrome.bargeInPeakThreshold`     | `2500`                                   | Peak level counted as human interruption                                                                                                                                                                          |
| `chrome.bargeInCooldownMs`        | `900`                                    | Minimum delay between repeated interruption clears                                                                                                                                                                |
| `mode` (per-request)              | `"agent"`                                | Talk-back mode; see the [Agent and bidi modes](/plugins/google-meet/tool-and-modes#agent-and-bidi-modes) table                                                                                                    |
| `realtime.provider`               | `"openai"`                               | Compatibility fallback used when the scoped fields below are unset                                                                                                                                                |
| `realtime.transcriptionProvider`  | `"openai"`                               | Provider id used by `agent` mode for realtime transcription                                                                                                                                                       |
| `realtime.voiceProvider`          | unset                                    | Provider id used by `bidi` mode for direct realtime voice; set to `"google"` for Gemini Live while keeping agent-mode transcription on OpenAI. Pair with `realtime.model` to pick the specific Gemini Live model. |
| `realtime.toolPolicy`             | `"safe-read-only"`                       | See [Agent and bidi modes](/plugins/google-meet/tool-and-modes#agent-and-bidi-modes)                                                                                                                              |
| `realtime.instructions`           | brief spoken-reply instructions          | Tells the model to speak briefly and use `openclaw_agent_consult` for deeper answers                                                                                                                              |
| `realtime.introMessage`           | `"Say exactly: I'm here and listening."` | Spoken once when the realtime bridge connects; set to `""` to join silently                                                                                                                                       |
| `realtime.agentId`                | `"main"`                                 | OpenClaw agent id used for `openclaw_agent_consult`                                                                                                                                                               |
| `voiceCall.enabled`               | `true`                                   | Delegates the Twilio PSTN call, DTMF, and intro greeting to the Voice Call plugin                                                                                                                                 |
| `voiceCall.dtmfDelayMs`           | `12000`                                  | Leading wait before playing a PIN-derived DTMF sequence over Twilio                                                                                                                                               |
| `voiceCall.postDtmfSpeechDelayMs` | `5000`                                   | Delay before requesting the realtime intro greeting after Voice Call starts the Twilio leg                                                                                                                        |

`chrome.audioBridgeCommand` and `chrome.audioBridgeHealthCommand` let an external bridge own the whole local audio path instead of `chrome.audioInputCommand`/`chrome.audioOutputCommand`; see [Notes](/plugins/google-meet#notes) for the constraint on which mode can use them.

An `openclaw doctor --fix` migration exists for the legacy `realtime.provider: "google"` shape: it moves that intent to `realtime.voiceProvider: "google"` plus `realtime.transcriptionProvider: "openai"` when those fields are not already set.

### Optional overrides

```json5
{
  defaults: {
    meeting: "https://meet.google.com/abc-defg-hij",
  },
  browser: {
    defaultProfile: "openclaw",
  },
  chrome: {
    guestName: "OpenClaw Agent",
    waitForInCallMs: 30000,
    bargeInInputCommand: [
      "sox",
      "-q",
      "-t",
      "coreaudio",
      "External Microphone",
      "-r",
      "24000",
      "-c",
      "1",
      "-b",
      "16",
      "-e",
      "signed-integer",
      "-t",
      "raw",
      "-",
    ],
  },
  chromeNode: {
    node: "parallels-macos",
  },
  defaultMode: "agent",
  realtime: {
    provider: "openai",
    transcriptionProvider: "openai",
    voiceProvider: "google",
    model: "gemini-3.1-flash-live-preview",
    agentId: "jay",
    toolPolicy: "owner",
    introMessage: "Say exactly: I'm here.",
    providers: {
      google: {
        speakerVoice: "Kore",
      },
    },
  },
}
```

ElevenLabs for both agent-mode listening and speaking:

```json5
{
  tts: {
    provider: "elevenlabs",
    providers: {
      elevenlabs: {
        modelId: "eleven_v3",
        speakerVoiceId: "pMsXgVXv3BLzUgSXRplE",
      },
    },
  },
  plugins: {
    entries: {
      "google-meet": {
        config: {
          realtime: {
            transcriptionProvider: "elevenlabs",
            providers: {
              elevenlabs: {
                modelId: "scribe_v2_realtime",
                audioFormat: "ulaw_8000",
                sampleRate: 8000,
                commitStrategy: "vad",
              },
            },
          },
        },
      },
    },
  },
}
```

The persistent Meet voice comes from `tts.providers.elevenlabs.speakerVoiceId`. Agent replies can also use per-reply `[[tts:speakerVoiceId=... model=eleven_v3]]` directives when TTS model overrides are enabled, but config is the deterministic default for meetings. On join, logs show `transcriptionProvider=elevenlabs`, and each spoken reply logs `provider=elevenlabs model=eleven_v3 speakerVoiceId=<voiceId>`.

Twilio-only config:

```json5
{
  defaultTransport: "twilio",
  twilio: {
    defaultDialInNumber: "+15551234567",
    defaultPin: "123456",
  },
  voiceCall: {
    gatewayUrl: "ws://127.0.0.1:18789",
  },
}
```

With `voiceCall.enabled: true` (the default) and Twilio transport, Voice Call places the DTMF sequence before opening the realtime media stream, then uses the saved intro text as the initial realtime greeting. If `voice-call` is not enabled, Google Meet can still validate and record the dial plan but cannot place the Twilio call.

Leave `voiceCall.gatewayUrl` unset to use the local trusted Gateway runtime, which preserves the
invoking agent for the full call. A configured Gateway URL remains an explicit WebSocket target and
cannot authenticate plugin provenance; non-default agent joins fail closed instead of silently
using another agent. Run Google Meet and Voice Call in the same Gateway process when per-agent
routing is required.
