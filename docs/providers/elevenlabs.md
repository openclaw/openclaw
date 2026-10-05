---
summary: "Use ElevenLabs speech, Scribe STT, and realtime transcription with OpenClaw"
read_when:
  - You want ElevenLabs text-to-speech in OpenClaw
  - You want ElevenLabs Scribe speech-to-text for audio attachments
  - You want ElevenLabs realtime transcription for Voice Call or Google Meet
title: "ElevenLabs"
---

OpenClaw uses ElevenLabs for text-to-speech, batch speech-to-text with Scribe
v2, and streaming STT with Scribe v2 Realtime. The plugin is bundled and
enabled by default; no `plugins install` step is needed.

| Capability               | OpenClaw surface                                                     | Default                  |
| ------------------------ | -------------------------------------------------------------------- | ------------------------ |
| Text-to-speech           | `tts` / `talk`                                                       | `eleven_multilingual_v2` |
| Batch speech-to-text     | `tools.media.audio`                                                  | `scribe_v2`              |
| Streaming speech-to-text | Voice Call streaming or Google Meet `realtime.transcriptionProvider` | `scribe_v2_realtime`     |

## Authentication

Set `ELEVENLABS_API_KEY` in the environment. `XI_API_KEY` is also accepted for
compatibility with existing ElevenLabs tooling.

```bash
export ELEVENLABS_API_KEY="..."
```

## Text-to-speech

```json5
{
  tts: {
    providers: {
      elevenlabs: {
        apiKey: "${ELEVENLABS_API_KEY}",
        voiceId: "pMsXgVXv3BLzUgSXRplE",
        modelId: "eleven_multilingual_v2",
      },
    },
  },
}
```

Set `modelId` to `eleven_v3` to use ElevenLabs v3 on the text-to-speech API.
Set `modelId` to `eleven_v4_turbo` for low-latency agent speech, or `eleven_v4`
for the slower narration model. `eleven_v3_conversational` also uses the
dialogue path. OpenClaw keeps `eleven_multilingual_v2` as the default for
existing installs.

`eleven_v4`, `eleven_v4_turbo`, and `eleven_v3_conversational` are not accepted
by the text-to-speech endpoint. OpenClaw sends those models over the Text to
Dialogue WebSocket at `/v1/text-to-dialogue/stream-input`. Flash, Turbo v2.5,
and Multilingual stay on text-to-speech. `eleven_turbo_v2_5` is still rewritten
to `eleven_flash_v2_5`, and `eleven_turbo_v2` is still rewritten to
`eleven_flash_v2`.

Dialogue models read `stability` only. The other voice settings still apply to
text-to-speech models. A telephony caller can pass a `conversationId` provider
override so later utterances on that call share one socket and keep the scene.
Each utterance is one turn. Aborting synthesis closes that socket, which is
how interruption works on this API. While the conversation is idle the socket
sends `keep_alive`, and it closes after 10 minutes without another utterance.

Discord voice channels use ElevenLabs' streaming TTS endpoint when ElevenLabs
is the selected `voice.tts`/`tts` provider: playback starts from the
returned audio stream instead of waiting for OpenClaw to download the whole
audio file first. `latencyTier` maps to ElevenLabs' `optimize_streaming_latency`
query parameter for models that accept it. OpenClaw omits that parameter for
`eleven_v3`, which rejects it. Dialogue models do not use it.

## Speech-to-text

Use Scribe v2 for inbound audio attachments and short recorded voice segments:

```json5
{
  tools: {
    media: {
      models: [{ provider: "elevenlabs", model: "scribe_v2", capabilities: ["audio"] }],
      audio: {
        enabled: true,
      },
    },
  },
}
```

OpenClaw sends multipart audio to ElevenLabs `/v1/speech-to-text` with
`model_id: "scribe_v2"`. Language hints map to `language_code` when present.

## Streaming STT

The bundled `elevenlabs` plugin registers Scribe v2 Realtime for Voice Call and
Google Meet agent-mode streaming transcription.

| Setting         | Config path                                                               | Default                                           |
| --------------- | ------------------------------------------------------------------------- | ------------------------------------------------- |
| API key         | `plugins.entries.voice-call.config.streaming.providers.elevenlabs.apiKey` | Falls back to `ELEVENLABS_API_KEY` / `XI_API_KEY` |
| Model           | `...elevenlabs.modelId`                                                   | `scribe_v2_realtime`                              |
| Audio format    | `...elevenlabs.audioFormat`                                               | `ulaw_8000`                                       |
| Sample rate     | `...elevenlabs.sampleRate`                                                | `8000`                                            |
| Commit strategy | `...elevenlabs.commitStrategy`                                            | `vad`                                             |
| Language        | `...elevenlabs.languageCode`                                              | (unset)                                           |

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          streaming: {
            enabled: true,
            provider: "elevenlabs",
            providers: {
              elevenlabs: {
                apiKey: "${ELEVENLABS_API_KEY}",
                audioFormat: "ulaw_8000",
                commitStrategy: "vad",
                languageCode: "en",
              },
            },
          },
        },
      },
    },
  },
}
```

<Note>
Voice Call receives Twilio media as 8 kHz G.711 u-law. The ElevenLabs realtime
provider defaults to `ulaw_8000`, so telephony frames can be forwarded without
transcoding.
</Note>

For Google Meet agent mode, set
`plugins.entries.google-meet.config.realtime.transcriptionProvider` to
`"elevenlabs"` and configure the same provider block under
`plugins.entries.google-meet.config.realtime.providers.elevenlabs`.

## Related

- [Text-to-speech](/tools/tts)
- [Google Meet](/plugins/google-meet)
- [Model selection](/concepts/model-providers)
