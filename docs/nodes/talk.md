---
summary: "Talk mode: continuous speech conversations across local STT/TTS and realtime voice"
read_when:
  - Implementing Talk mode on macOS/iOS/Android
  - Using standalone voice on Apple Watch
  - Changing voice/TTS/interrupt behavior
title: "Talk mode"
---

Talk mode covers these runtime shapes:

- **Native macOS/iOS/Android Talk**: native speech recognition, Gateway chat, and `talk.speak` TTS. Apple Speech recognition on macOS/iOS may use network services; Android behavior depends on the installed speech service. Nodes advertise the `talk` capability and declare which `talk.*` commands they support.
- **iOS Talk (realtime)**: client-owned WebRTC for OpenAI realtime configs that select `webrtc` transport or omit transport, including framed and frameless transcript/audio events. Explicit `gateway-relay`, `provider-websocket`, and non-OpenAI realtime configs stay on the Gateway-owned relay; non-realtime configs use the native speech loop.
- **Apple Watch standalone Talk**: native WebRTC/Opus over UDP with Gateway-owned call control (`gateway-control-v1`). The Watch uses the Gateway's configured realtime provider and keeps tools and transcript ownership on the Gateway; unsupported configurations fail visibly without a relay fallback.
- **Browser Talk**: `talk.client.create` for client-owned `webrtc`/`provider-websocket` sessions, or `talk.session.create` for Gateway-owned `gateway-relay` sessions. `managed-room` is reserved for Gateway handoff and walkie-talkie rooms.
- **Android Talk (realtime)**: Android uses Gateway-owned relay realtime when `talk.catalog` reports the realtime group ready and the configured model passes the Android client gate; it never opens a client-owned WebRTC session. The Gateway now supports `gpt-live-*` relay sessions, but Android intentionally keeps those models on native speech recognition, Gateway chat, and `talk.speak` until the relay path is proven live from an Android device.
- **Transcription-only clients**: `talk.session.create({ mode: "transcription", transport: "gateway-relay", brain: "none" })`, then `talk.session.appendAudio` and `talk.session.close` for captions/dictation without an assistant voice response. One-shot uploaded voice notes still use the [media understanding](/nodes/media-understanding) audio path.

Native Talk is a continuous loop: listen for speech, send the transcript to the model through the active session, wait for the response, then speak it via the configured Talk provider (`talk.speak`).

For replies dominated by fenced code, `talk.speak` uses a short spoken message directing the listener to the screen. Inline code and ordinary prose remain part of the spoken reply.

Apple Watch also retains **Talk to Claw**, the separate [one-turn companion flow](/platforms/ios#talk-to-claw-with-the-iphone): native dictation, text relayed through the iPhone, and system-voice readback. **Talk on Watch** is the realtime path included in normal Watch setup; see [standalone voice setup](/platforms/ios#standalone-voice).

## Talk documentation pages

Talk mode is documented on this page and four child pages, one per reader job.
This page keeps the voice directives and the `talk` configuration reference.
Open the child page that matches your task.

| Page                                                                   | Read it when                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Talk realtime sessions and delegation](/nodes/talk/realtime-sessions) | You are wiring realtime Talk: voice selection, delegation, steering, and transcripts. |
| [Talk session ownership](/nodes/talk/session-ownership)                | You need agent and session resolution, control authority, or close semantics.         |
| [Talk on macOS and the Gateway relay](/nodes/talk/macos-relay)         | You run Talk on macOS or enable the streamed realtime Gateway relay.                  |
| [Talk client UI](/nodes/talk/client-ui)                                | You need the macOS, Apple Watch, or Android client controls and behavior.             |

## Where each section moved

Every section heading from the previous single-page version keeps its anchor
here, so an existing link such as `/nodes/talk#session-ownership` still
resolves. Each entry points at the page that now holds the content.

- <a id="choose-a-talk-voice-from-chat" />[Choose a Talk voice from chat](/nodes/talk/realtime-sessions#choose-a-talk-voice-from-chat)
- <a id="session-ownership" />[Session ownership](/nodes/talk/session-ownership#session-ownership)
- <a id="behavior-(macos)" />[Behavior (macOS)](</nodes/talk/macos-relay#behavior-(macos)>)
- <a id="behavior-macos" />[Behavior (macOS)](/nodes/talk/macos-relay#behavior-macos)
- <a id="realtime-talk-over-the-gateway-relay-(macos)" />[Realtime Talk over the Gateway relay (macOS)](</nodes/talk/macos-relay#realtime-talk-over-the-gateway-relay-(macos)>)
- <a id="realtime-talk-over-the-gateway-relay-macos" />[Realtime Talk over the Gateway relay (macOS)](/nodes/talk/macos-relay#realtime-talk-over-the-gateway-relay-macos)
- <a id="when-realtime-cannot-start" />[When realtime cannot start](/nodes/talk/macos-relay#when-realtime-cannot-start)
- <a id="macos-ui" />[macOS UI](/nodes/talk/client-ui#macos-ui)
- <a id="apple-watch-ui" />[Apple Watch UI](/nodes/talk/client-ui#apple-watch-ui)
- <a id="android-ui" />[Android UI](/nodes/talk/client-ui#android-ui)

## Voice directives in replies

The assistant can prefix a reply with a single JSON line to control voice:

```json
{ "voice": "<voice-id>", "once": true }
```

Rules:

- First non-empty line only; the JSON line is stripped before TTS playback.
- Unknown keys are ignored.
- `once: true` applies to the current reply only; without it, the voice becomes the new Talk mode default.

Supported keys: `voice` / `voice_id` / `voiceId`, `model` / `model_id` / `modelId`, `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`, `seed`, `normalize`, `lang`, `output_format`, `latency_tier`, `once`.

## Config (`~/.openclaw/openclaw.json`)

```json5
{
  talk: {
    provider: "elevenlabs",
    providers: {
      elevenlabs: {
        voiceId: "elevenlabs_voice_id",
        modelId: "eleven_v3",
        outputFormat: "mp3_44100_128",
        apiKey: "elevenlabs_api_key",
      },
      mlx: {
        modelId: "mlx-community/Soprano-80M-bf16",
        // Fish S2 Pro can also use a local reference voice:
        // referenceAudioPath: "/Users/example/Voices/reference.wav",
        // referenceText: "Exact transcript of the reference clip.",
      },
      system: {},
    },
    speechLocale: "ru-RU",
    silenceTimeoutMs: 1500,
    interruptOnSpeech: true,
    realtime: {
      provider: "openai",
      providers: {
        openai: {
          apiKey: "openai_api_key",
          model: "gpt-realtime-2.1",
          speakerVoice: "cedar",
        },
      },
      instructions: "Speak warmly and keep answers brief.",
      mode: "realtime",
      transport: "webrtc",
      brain: "agent-consult",
    },
  },
}
```

OpenAI browser WebRTC and Gateway-relay Talk support native GPT-Live. The
released route remains available in **Settings → Talk**. Account-issued,
unlisted routes can be set in `talk.realtime.model`, but are not published
through catalogs or diagnostics. Browser Talk uses client WebRTC with
Gateway-owned control. Gateway relay uses Gateway-owned WebRTC for the released
route with either OAuth or Platform fallback. Unlisted routes and other backend
consumers use the direct Platform-only transport.

For browser and Gateway-relay Talk, the released route prefers an OpenClaw
ChatGPT OAuth profile and falls back to Platform API-key authentication.
Unlisted routes never use OAuth and require a Platform key. GPT-Live browser
Talk also requires the bundled `openai` plugin registered in full mode; a
restrictive `plugins.allow` list fails session creation with "OpenAI GPT-Live
browser session broker is unavailable".
Runtime bounds: 8 concurrent sessions per Gateway and a 30-minute session TTL.
Browser sessions also use 60-second single-use offer tokens.

The released route uses `arbor`, `breeze`, `cove`, `ember`, `juniper`, `maple`,
`sol`, `spruce`, and `vale`, with `cove` as the default. Unlisted routes use
their account-issued voice contract; the current Platform profile accepts
`marin` and `cedar`, with `marin` as the default. A rejected session does not
identify the cause by itself; check the selected account, model, and voice.

| Consumer                    | GPT-Live status                                                             |
| --------------------------- | --------------------------------------------------------------------------- |
| Browser Talk                | Released route: OAuth-first; unlisted routes: Platform-key client WebRTC    |
| Gateway-relay Talk          | Released route: OAuth-first; unlisted routes: direct Platform-key transport |
| Discord bidirectional voice | Platform-key backend WebSocket                                              |
| Voice Call and telephony    | Platform-key backend WebSocket                                              |
| iOS client-owned Talk       | Implemented; GPT-Live device live verification pending                      |
| Apple Watch standalone Talk | Gateway-controlled WebRTC implemented; physical Watch verification pending  |
| Android realtime Talk       | Pending an Android device live-proof flip; Android stays on native Talk     |

These rows describe implemented transport paths, not account entitlement or a
successful live call on every device. iOS implements frameless transcripts and
the Gateway offer exchange; Android retains an explicit GPT-Live model gate.
For model capability limits, see [Discord voice policies](/channels/discord/voice-channels#voice-channels)
and [Voice Call tools](/plugins/voice-call#realtime-voice-conversations).

The Gateway-owned WebRTC route keeps OAuth and Platform credentials away from
relay clients. Backend WebSocket paths keep the Platform key on the Gateway;
OpenClaw converts telephony G.711 u-law audio to and from GPT-Live's 24 kHz PCM
contract.

For GA `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, and `gpt-realtime-2`
browser sessions, Platform credentials remain preferred in this order: the
configured realtime API key, an `openai` API-key profile, then
`OPENAI_API_KEY`. With none configured, browser Talk falls back to an OpenClaw
ChatGPT OAuth profile and exchanges SDP through the Gateway's single-use offer
broker, so the OAuth token never reaches the browser. A configured Platform
credential that cannot be resolved fails closed instead of silently falling
through to OAuth.

iOS client-owned WebRTC, GA Gateway relay, and Android realtime remain
Platform-key-only. GA browser Talk keeps the existing client-owned data channel
and `talk.client.toolCall` loop; only the credential owner and SDP exchange path
change under OAuth. The released GPT-Live route remains OAuth-first with
Platform fallback for browser and Gateway-owned WebRTC; direct backend sockets
and unlisted GPT-Live routes remain Platform-key-only.

| Key                                      | Default                                     | Notes                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentId`                                | configured default agent                    | Owns Talk sessions created without an explicit agent-scoped session key.                                                                                                                                                                                       |
| `provider`                               | -                                           | Active Talk TTS provider. Use `elevenlabs`, `mlx`, or `system` for macOS-local playback paths.                                                                                                                                                                 |
| `providers.<id>.voiceId`                 | -                                           | ElevenLabs falls back to `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID`, or the first available voice with an API key.                                                                                                                                                 |
| `speechLocale`                           | device default                              | BCP 47 locale for Android, iOS, and macOS native speech recognition, plus the iOS system-voice fallback. Apple Speech may use network services; Android also forwards the language component to realtime input transcription.                                  |
| `providers.elevenlabs.modelId`           | `eleven_multilingual_v2`                    |                                                                                                                                                                                                                                                                |
| `providers.mlx.modelId`                  | `mlx-community/Soprano-80M-bf16`            |                                                                                                                                                                                                                                                                |
| `providers.mlx.referenceAudioPath`       | -                                           | Optional client-local reference recording for MLX models that support voice cloning. The path is resolved on the native macOS app host.                                                                                                                        |
| `providers.mlx.referenceText`            | -                                           | Exact transcript of `referenceAudioPath`; Fish S2 Pro uses both values for local voice cloning.                                                                                                                                                                |
| `providers.elevenlabs.apiKey`            | -                                           | Falls back to `ELEVENLABS_API_KEY` (or gateway shell profile if available).                                                                                                                                                                                    |
| `silenceTimeoutMs`                       | `700` ms macOS/Android, `900` ms iOS        | Pause window before Talk sends the transcript.                                                                                                                                                                                                                 |
| `interruptOnSpeech`                      | `true`                                      |                                                                                                                                                                                                                                                                |
| `providers.<id>.outputFormat`            | `pcm_44100` macOS/iOS, `pcm_24000` Android  | Set `mp3_*` to force MP3 streaming.                                                                                                                                                                                                                            |
| `consultThinkingLevel`                   | unset                                       | Thinking level override for the agent run behind realtime `openclaw_agent_consult` calls.                                                                                                                                                                      |
| `consultFastMode`                        | unset                                       | Fast-mode override for realtime `openclaw_agent_consult` calls.                                                                                                                                                                                                |
| `realtime.provider`                      | -                                           | `openai` for WebRTC, `google` for provider WebSocket, or a bridge-only provider through Gateway relay.                                                                                                                                                         |
| `realtime.providers.<id>`                | -                                           | Provider-owned realtime config. Browsers receive only ephemeral/constrained session credentials, never a standard API key.                                                                                                                                     |
| `realtime.providers.openai.speakerVoice` | `alloy` for GA; route-specific for GPT-Live | Built-in OpenAI realtime voice id (the older `voice` key still works but is deprecated). GA voices: `alloy`, `ash`, `ballad`, `cedar`, `coral`, `echo`, `marin`, `sage`, `shimmer`, `verse`. GPT-Live uses the route-specific voice families documented above. |
| `realtime.model`                         | provider default                            | Realtime voice model. Overrides `realtime.providers.<id>.model` when both are set — the same precedence `talk.client.create` applies at session time.                                                                                                          |
| `realtime.transport`                     | -                                           | `webrtc`: OpenAI WebRTC on iOS, in the browser, and on Watch with Gateway control. `provider-websocket`: browser-owned, stays on Gateway relay on iOS. `gateway-relay`: keeps provider audio on the Gateway; Android uses realtime only with this transport.   |
| `realtime.brain`                         | -                                           | `agent-consult` routes realtime tool calls through Gateway policy; `direct-tools` is legacy direct-tool compatibility; `none` is for transcription/external orchestration.                                                                                     |
| `realtime.consultRouting`                | -                                           | `provider-direct` preserves the provider's direct reply when it skips `openclaw_agent_consult`; `force-agent-consult` routes finalized user transcripts through OpenClaw instead.                                                                              |
| `realtime.instructions`                  | -                                           | Appends provider-facing system instructions to OpenClaw's built-in realtime prompt.                                                                                                                                                                            |

`talk.catalog` exposes canonical provider ids and registry aliases, each provider's valid modes/transports/brain strategies/realtime audio formats/capability flags, and the runtime-selected readiness result. First-party Talk clients should read that catalog instead of maintaining provider aliases locally; treat an older Gateway that omits group readiness as unverified rather than definitively unconfigured. Streaming transcription providers are discovered through `talk.catalog.transcription`; the current Gateway relay uses the Voice Call streaming provider config until a dedicated Talk transcription config surface ships.

## Notes

- Native speech recognition requires the platform's speech and microphone access. Standalone Watch realtime requires microphone access, not local speech recognition.
- Native Talk uses the active Gateway session and only falls back to history polling when response events are unavailable.
- The gateway resolves Talk playback through `talk.speak` using the active Talk provider. Android falls back to local system TTS only when that RPC is unavailable.
- macOS local MLX playback uses the bundled `openclaw-mlx-tts` helper when present, or an executable on `PATH`. Set `OPENCLAW_MLX_TTS_BIN` to point at a custom helper binary during development. The helper streams PCM, keeps one selected model resident, and supports Fish S2 Pro reference audio through `providers.mlx.referenceAudioPath` plus `referenceText`.
- Voice directive value ranges (ElevenLabs): `stability`, `similarity`, and `style` accept `0..1`; `speed` accepts `0.5..2`; `latency_tier` accepts `0..4`.

## Related

- [Voice wake](/nodes/voicewake)
- [Audio and voice notes](/nodes/audio)
- [Media understanding](/nodes/media-understanding)
- [Google Meet plugin](/plugins/google-meet)
