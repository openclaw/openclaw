---
summary: "Use Anvil Voice as a gateway-relay realtime speech-to-speech provider"
read_when:
  - You want OpenClaw Talk or Voice Call to speak through Anvil Voice
  - You are routing speech-to-speech turns to a local fast-tier LLM
  - You need a backend-only realtime voice provider instead of browser WebRTC
title: "Anvil Voice"
---

Anvil Voice is a bundled realtime voice provider for OpenClaw. It connects
OpenClaw Talk or Voice Call to an Anvil `/v1/realtime` WebSocket so speech
turns can reach a local or private fast-tier LLM and return streamed audio.

- Provider id: `anvil`
- Transport: `gateway-relay`
- Default model: `fast-local`
- Audio: Browser Talk PCM16 24 kHz or Voice Call G.711 mu-law 8 kHz, adapted to Anvil Voice PCM16 16 kHz
- Auth: optional on loopback; bearer token or SecretRef for remote endpoints

Use this provider when the Gateway should own the vendor/private socket and
the browser, phone bridge, or mobile app should only stream microphone audio
to the Gateway. For OpenAI browser WebRTC use the `openai` provider instead.
For Google Live browser WebSocket sessions use the `google` provider. For
streaming transcription-only call audio, use a realtime transcription
provider such as `elevenlabs`, `openai`, `deepgram`, `mistral`, or `xai`.

## Capabilities

| Capability             | Supported                                            |
| ---------------------- | ---------------------------------------------------- |
| Browser Talk           | Yes, through Gateway relay                           |
| Voice Call realtime    | Yes, through Gateway relay                           |
| Browser-direct WebRTC  | No                                                   |
| Provider browser token | No                                                   |
| Tool calls             | No direct provider tool calls in the Anvil v1 bridge |
| Barge-in               | Yes                                                  |

## Control UI Talk

Same-host Anvil Voice does not need a token when the Anvil realtime server is
bound to loopback:

```json5
{
  talk: {
    realtime: {
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "anvil",
      instructions: "Speak briefly and use the fast local tier.",
      providers: {
        anvil: {
          realtimeUrl: "ws://127.0.0.1:8765/v1/realtime",
          model: "fast-local",
        },
      },
    },
  },
}
```

For a remote or tailnet Anvil Voice endpoint, use TLS or a private trusted
network address and configure a bearer token through a SecretRef:

```json5
{
  talk: {
    realtime: {
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "anvil",
      providers: {
        anvil: {
          baseUrl: "https://anvil-voice.example.com",
          apiKey: { source: "env", provider: "default", id: "ANVIL_ROUTER_TOKEN" },
          model: "fast-local",
          speakerVoice: "default",
          silenceDurationMs: 200,
          vadThreshold: 0.5,
        },
      },
    },
  },
}
```

`baseUrl` accepts `http://`, `https://`, `ws://`, or `wss://`; OpenClaw appends
`/v1/realtime` when needed. Plain `ws://` is accepted only for loopback,
private, `.local`, or `.ts.net` hosts. Public endpoints should use `wss://`.

## Voice Call

Voice Call uses the same provider id under
`plugins.entries.voice-call.config.realtime`:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio",
          inboundPolicy: "allowlist",
          allowFrom: ["+15550005678"],
          realtime: {
            enabled: true,
            provider: "anvil",
            instructions: "Keep spoken answers concise.",
            providers: {
              anvil: {
                realtimeUrl: "ws://127.0.0.1:8765/v1/realtime",
                model: "fast-local",
                silenceDurationMs: 200,
              },
            },
          },
        },
      },
    },
  },
}
```

For cross-machine calls, put `apiKey` under
`plugins.entries.voice-call.config.realtime.providers.anvil.apiKey` and store
it as a SecretRef or environment-backed value. Do not put bearer tokens in
committed config files.

## Settings

| Setting          | Config path                                                                       | Default       |
| ---------------- | --------------------------------------------------------------------------------- | ------------- |
| Realtime URL     | `talk.realtime.providers.anvil.realtimeUrl` / `...voice-call...anvil.realtimeUrl` | -             |
| Base URL         | `...anvil.baseUrl`                                                                | -             |
| API key          | `...anvil.apiKey` or `...anvil.token`                                             | optional      |
| Model            | `...anvil.model`                                                                  | `fast-local`  |
| Voice            | `...anvil.speakerVoice` or `...anvil.voice`                                       | Anvil default |
| VAD threshold    | `...anvil.vadThreshold`                                                           | `0.5`         |
| Silence duration | `...anvil.silenceDurationMs`                                                      | `200`         |
| Prefix padding   | `...anvil.prefixPaddingMs`                                                        | `0`           |

## Operational notes

- The Anvil Voice server owns STT, fast-tier LLM routing, and TTS.
- OpenClaw sends one `session.update` on connect, adapts browser PCM or phone
  mu-law audio into Anvil PCM16 16 kHz, commits after sustained silence, and
  forwards Anvil `response.output_audio.delta` events to the client.
- `response.cancel` is sent for barge-in. OpenClaw clears client playback and
  suppresses late audio deltas from the cancelled response.
- The Gateway keeps the Anvil bearer token server-side; browsers and mobile
  clients do not receive it.

## Related

- [Talk mode](/nodes/talk)
- [Voice Call](/plugins/voice-call)
- [Control UI](/web/control-ui)
