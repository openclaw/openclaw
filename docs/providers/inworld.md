---
summary: "Inworld streaming text-to-speech for OpenClaw replies and realtime speech-to-speech voice for Talk and Voice Call"
read_when:
  - You want Inworld speech synthesis for outbound replies
  - You need PCM telephony or OGG_OPUS voice-note output from Inworld
  - You want an Inworld voice on realtime Talk or Voice Call sessions
title: "Inworld"
---

Inworld is a streaming text-to-speech (TTS) provider. In OpenClaw it synthesizes outbound reply audio (MP3 by default, OGG_OPUS for voice notes) and raw PCM audio for telephony channels such as Voice Call.

OpenClaw posts to Inworld's streaming TTS endpoint, concatenates the returned base64 audio chunks into a single buffer, and hands the result to the standard reply-audio pipeline.

| Property      | Value                                                               |
| ------------- | ------------------------------------------------------------------- |
| Provider id   | `inworld`                                                           |
| Plugin        | official external package (`@openclaw/inworld-speech`)              |
| Contract      | `speechProviders` (TTS), `realtimeVoiceProviders` (Talk/Voice Call) |
| Auth env var  | `INWORLD_API_KEY` (HTTP Basic, Base64 dashboard credential)         |
| Base URL      | `https://api.inworld.ai`                                            |
| Default voice | `Sarah`                                                             |
| Default model | `inworld-tts-1.5-max`                                               |
| Output        | MP3 (default), OGG_OPUS (voice notes), PCM 22050 Hz (telephony)     |
| Website       | [inworld.ai](https://inworld.ai)                                    |
| Docs          | [docs.inworld.ai/tts/tts](https://docs.inworld.ai/tts/tts)          |

## Install plugin

```bash
openclaw plugins install @openclaw/inworld-speech
```

Installation applies to a running Gateway automatically; otherwise it takes effect
on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

## Getting started

<Steps>
  <Step title="Set your API key">
    Copy the credential from your Inworld dashboard (Workspace > API Keys) and set it as an env var. The value is sent verbatim as the HTTP Basic credential, so do not Base64-encode it again or convert it to a bearer token.

    ```bash
    INWORLD_API_KEY=<base64-credential-from-dashboard>
    ```

  </Step>
  <Step title="Select Inworld in tts">
    ```json5
    {
      tts: {
        auto: "always",
        provider: "inworld",
        providers: {
          inworld: {
            voiceId: "Sarah",
            modelId: "inworld-tts-1.5-max",
          },
        },
      },
    }
    ```
  </Step>
  <Step title="Send a message">
    Send a reply through any connected channel. OpenClaw synthesizes the audio with Inworld and delivers it as MP3 (or OGG_OPUS when the channel expects a voice note).
  </Step>
</Steps>

## Configuration options

| Option        | Path                                | Description                                                         |
| ------------- | ----------------------------------- | ------------------------------------------------------------------- |
| `apiKey`      | `tts.providers.inworld.apiKey`      | Base64 dashboard credential. Falls back to `INWORLD_API_KEY`.       |
| `baseUrl`     | `tts.providers.inworld.baseUrl`     | Override Inworld API base URL (default `https://api.inworld.ai`).   |
| `voiceId`     | `tts.providers.inworld.voiceId`     | Voice identifier (default `Sarah`). Legacy alias: `speakerVoiceId`. |
| `modelId`     | `tts.providers.inworld.modelId`     | TTS model id (default `inworld-tts-1.5-max`).                       |
| `temperature` | `tts.providers.inworld.temperature` | Sampling temperature, `0` (exclusive) to `2` (optional).            |

## Notes

<AccordionGroup>
  <Accordion title="Authentication">
    Inworld uses HTTP Basic auth with a single Base64-encoded credential string. Copy it verbatim from the Inworld dashboard. The provider sends it as `Authorization: Basic <apiKey>` without any further encoding, so do not Base64-encode it yourself and do not pass a bearer-style token. See [TTS auth notes](/tools/tts#inworld-primary) for the same callout.
  </Accordion>
  <Accordion title="Models">
    Supported model ids: `inworld-tts-1.5-max` (default), `inworld-tts-1.5-mini`, `inworld-tts-1-max`, `inworld-tts-1`.
  </Accordion>
  <Accordion title="Audio outputs">
    Replies use MP3 by default. When the channel target is `voice-note`, OpenClaw asks Inworld for `OGG_OPUS` so the audio plays as a native voice bubble. Telephony synthesis uses raw `PCM` at 22050 Hz to feed the telephony bridge.
  </Accordion>
  <Accordion title="Realtime voice (Talk and Voice Call)">
    The plugin also registers an Inworld realtime voice provider. Inworld's Realtime API runs
    speech-to-text, the LLM you pick on Inworld's router, and TTS-2 synthesis on one WebSocket,
    so Talk and Voice Call sessions can use an Inworld voice with sub-second turns, interruptions,
    and TTS-2 steering tags (`[speak warmly]`, `[laugh]`) when the model emits them. The OpenClaw
    agent stays the brain through the shared `openclaw_agent_consult` tool; Voice Call also exposes
    `openclaw_end_call`.

    - Endpoint: `wss://api.inworld.ai/api/v1/realtime/session` (OpenAI Realtime protocol with Inworld extensions)
    - Auth: the same Base64 dashboard credential, sent as `Authorization: Basic <apiKey>`
    - Default LLM: Inworld's server default (`google-ai-studio/gemini-2.5-flash`); set `model` to any router or `provider/model` id Inworld offers
    - Default TTS model and voice: `inworld-tts-2`, `Sarah`
    - Transport: `gateway-relay` (iOS, Android, and Control UI relay paths)
    - Audio: PCM16 24 kHz or G.711 µ-law 8 kHz, no host transcoding
    - Barge-in: Inworld turn detection interrupts the response; OpenClaw clears queued playback and truncates unplayed history
    - Not in this version: Inworld back-channel interjections (no out-of-band host playback channel yet)

    Configure Talk on the Gateway:

    ```json5
    {
      talk: {
        realtime: {
          provider: "inworld",
          mode: "realtime",
          transport: "gateway-relay",
          brain: "agent-consult",
          providers: {
            inworld: {
              apiKey: { source: "env", provider: "default", id: "INWORLD_API_KEY" },
              model: "openai/gpt-4.1-mini",
              voiceId: "Sarah",
              ttsModel: "inworld-tts-2",
              speakingRate: 1.0,
              deliveryMode: "BALANCED",
            },
          },
        },
      },
    }
    ```

    Provider-owned config also resolves from
    `plugins.entries.voice-call.config.realtime.providers.inworld` when Voice Call reuses the
    same provider map. Supported keys are `apiKey`, `baseUrl`, `model`, `voiceId`, `ttsModel`,
    `sttModel`, `speakingRate` (`0.5`-`1.5`), `temperature`, `deliveryMode`
    (`STABLE` / `BALANCED` / `CREATIVE`, honored by `inworld-tts-2`), `steeringHandling`,
    `segmenterStrategy`, `turnDetection` (`semantic_vad` default or `server_vad`), `eagerness`
    (`low` / `medium` / `high`), `vadThreshold`, `silenceDurationMs`, `prefixPaddingMs`,
    `responsiveness`, and `providerData`. Responsiveness fillers ("let me think") arrive on the normal assistant audio stream and are supported. Inworld back-channel interjections are not exposed in this version: Inworld delivers them as out-of-band audio while the user is still speaking, and OpenClaw's realtime playback contract has no out-of-band channel yet, so the adapter never enables them and rejects `backchannel` in config or `providerData`. The last is a bounded passthrough for the
    documented Inworld extensions (`stt`, `tts`, `memory`, `responsiveness`
    sections only, 8 KiB max); typed keys win over it, and `auto_tool_response` is always
    pinned to `false` so the Gateway keeps control of `response.create` after tool results.
    Session resumption is not available on Inworld, so a
    dropped socket ends the session instead of reconnecting.

    Inworld turn detection always creates responses and handles audio interruption. Use
    `consultRouting: "provider-direct"`; forced transcript routing and disabling input-audio
    interruption are not supported by this provider.

  </Accordion>
  <Accordion title="Custom endpoints">
    Override the API host with `tts.providers.inworld.baseUrl`. Trailing slashes are stripped before requests are sent.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Text-to-speech" href="/tools/tts" icon="waveform-lines">
    TTS overview, providers, and `tts` config.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="gear">
    Full config reference including `tts` settings.
  </Card>
  <Card title="Providers" href="/providers" icon="grid">
    All supported OpenClaw providers.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    Common issues and debugging steps.
  </Card>
</CardGroup>
