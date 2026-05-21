---
summary: "Use Gradium text-to-speech and semantic realtime speech-to-text in OpenClaw"
read_when:
  - You want Gradium for text-to-speech
  - You want semantic realtime speech-to-text on Voice Call
  - You need Gradium API key, voice, or directive token configuration
title: "Gradium"
---

[Gradium](https://gradium.ai) is a bundled speech provider for OpenClaw. Use it when you want one provider for text-to-speech and realtime speech-to-text, especially for voice agents that need natural turn taking instead of simple silence timers.

The plugin can render normal audio replies (WAV), voice-note-compatible Opus output, and 8 kHz u-law audio for telephony surfaces. It can also stream Voice Call audio through Gradium's realtime ASR WebSocket and use Gradium's semantic VAD events to decide when a spoken turn is ready to commit.

| Property      | Value                                |
| ------------- | ------------------------------------ |
| Provider id   | `gradium`                            |
| Auth          | `GRADIUM_API_KEY` or config `apiKey` |
| Base URL      | `https://api.gradium.ai` (default)   |
| Default voice | `Emma` (`YTpq7expH9539ERJ`)          |

## When to choose Gradium

Choose Gradium when your voice workflow cares about conversation timing:

- **Semantic turn taking**: Gradium streams `step` events with semantic VAD probabilities. OpenClaw uses those scores to request a Gradium `flush` and commit the current transcript when the user appears to be done.
- **Multilingual live calls**: omit `language` for Gradium auto-detection, or pass a language hint such as `en`, `fr`, `de`, `es`, or `pt`.
- **One speech vendor**: use Gradium TTS for outbound speech and Gradium realtime STT for inbound telephony audio in the same Voice Call setup.
- **Telephony-shaped defaults**: `ulaw_8000` is the default realtime STT input format, so Twilio-style G.711 u-law audio can be forwarded without transcoding.

Gradium realtime STT is for live Voice Call streams. Batch audio attachments and recorded voice notes still use OpenClaw's shared `tools.media.audio` providers such as Deepgram, ElevenLabs, Mistral, OpenAI, SenseAudio, or xAI.

## Setup

Create a Gradium API key, then expose it to OpenClaw with either an env var or the config key.

<Tabs>
  <Tab title="Env var">
    ```bash
    export GRADIUM_API_KEY="gsk_..."
    ```
  </Tab>

  <Tab title="Config key">
    ```json5
    {
      messages: {
        tts: {
          auto: "always",
          provider: "gradium",
          providers: {
            gradium: {
              apiKey: "${GRADIUM_API_KEY}",
            },
          },
        },
      },
    }
    ```
  </Tab>
</Tabs>

The plugin checks the resolved `apiKey` first and falls back to the `GRADIUM_API_KEY` environment variable.

## Config

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "gradium",
      providers: {
        gradium: {
          voiceId: "YTpq7expH9539ERJ",
          // apiKey: "${GRADIUM_API_KEY}",
          // baseUrl: "https://api.gradium.ai",
        },
      },
    },
  },
}
```

| Key                                      | Type   | Description                                                                                   |
| ---------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| `messages.tts.providers.gradium.apiKey`  | string | Resolved API key. Supports `${ENV}` and secret refs.                                          |
| `messages.tts.providers.gradium.baseUrl` | string | Override the API origin. Trailing slashes are stripped. Defaults to `https://api.gradium.ai`. |
| `messages.tts.providers.gradium.voiceId` | string | Default voice id used when no directive override is present.                                  |

The output audio format is selected automatically by the runtime based on the target surface and is not configurable from `openclaw.json`. See [Output](#output) below.

## Voices

| Name      | Voice ID           |
| --------- | ------------------ |
| Emma      | `YTpq7expH9539ERJ` |
| Kent      | `LFZvm12tW_z0xfGo` |
| Tiffany   | `Eu9iL_CYe8N-Gkx_` |
| Christina | `2H4HY2CBNyJHBCrP` |
| Sydney    | `jtEKaLYNn6iif5PR` |
| John      | `KWJiFWu2O9nMPYcR` |
| Arthur    | `3jUdJyOi9pgbxBTK` |

Default voice: Emma.

### Per-message voice override

When the active speech policy allows voice overrides, you can switch voices inline using a directive token. All of these resolve to the same `voiceId` override:

```text
/voice:LFZvm12tW_z0xfGo
/voice_id:LFZvm12tW_z0xfGo
/voiceid:LFZvm12tW_z0xfGo
/gradium_voice:LFZvm12tW_z0xfGo
/gradiumvoice:LFZvm12tW_z0xfGo
```

If the speech policy disables voice overrides, the directive is consumed but ignored.

## Output

The runtime picks the output format from the target surface. The provider does not synthesize other formats today.

| Target         | Format      | File ext | Sample rate | Voice-compatible flag |
| -------------- | ----------- | -------- | ----------- | --------------------- |
| Standard audio | `wav`       | `.wav`   | provider    | no                    |
| Voice note     | `opus`      | `.opus`  | provider    | yes                   |
| Telephony      | `ulaw_8000` | n/a      | 8 kHz       | n/a                   |

## Auto-select order

Among configured TTS providers, Gradium's auto-select order is `30`. See [Text-to-Speech](/tools/tts) for how OpenClaw picks the active provider when `messages.tts.provider` is not pinned.

## Realtime speech-to-text

Gradium's realtime ASR WebSocket (`wss://api.gradium.ai/api/speech/asr`) is registered as a Voice Call streaming STT provider. Configure it under the Voice Call plugin:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          streaming: {
            enabled: true,
            provider: "gradium",
            providers: {
              gradium: {
                // apiKey: "${GRADIUM_API_KEY}",
                modelName: "default",
                inputFormat: "ulaw_8000",
                // Omit language for Gradium auto-detection.
                language: "en",
                delayInFrames: 20,
                // Semantic VAD is enabled by default.
                semanticVad: true,
                semanticVadThreshold: 0.5,
                semanticVadHorizonIndex: 2,
              },
            },
          },
        },
      },
    },
  },
}
```

| Key                                                                                     | Type    | Description                                                                                                                                                |
| --------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugins.entries.voice-call.config.streaming.providers.gradium.apiKey`                  | string  | Resolved API key. Supports `${ENV}` and secret refs; falls back to `GRADIUM_API_KEY`.                                                                      |
| `plugins.entries.voice-call.config.streaming.providers.gradium.baseUrl`                 | string  | Override the API origin. Trailing slashes are stripped. Defaults to `https://api.gradium.ai`.                                                              |
| `plugins.entries.voice-call.config.streaming.providers.gradium.modelName`               | string  | Gradium ASR model name. Defaults to `default`.                                                                                                             |
| `plugins.entries.voice-call.config.streaming.providers.gradium.inputFormat`             | string  | Audio input format: `pcm`, `wav`, `opus`, `ulaw_8000`, or `alaw_8000`. Defaults to `ulaw_8000`.                                                            |
| `plugins.entries.voice-call.config.streaming.providers.gradium.language`                | string  | Optional language hint passed in Gradium's setup payload.                                                                                                  |
| `plugins.entries.voice-call.config.streaming.providers.gradium.temp`                    | number  | Optional Gradium decoding temperature passed through `json_config.temp`.                                                                                   |
| `plugins.entries.voice-call.config.streaming.providers.gradium.paddingBonus`            | number  | Optional Gradium padding bonus passed through `json_config.padding_bonus`.                                                                                 |
| `plugins.entries.voice-call.config.streaming.providers.gradium.delayInFrames`           | number  | Optional Gradium VAD delay passed through `json_config.delay_in_frames`. Must be one of `7`, `8`, `10`, `12`, `14`, `16`, `20`, `24`, `32`, `36`, or `48`. |
| `plugins.entries.voice-call.config.streaming.providers.gradium.semanticVad`             | boolean | Enable semantic VAD driven turn commits. Defaults to `true`.                                                                                               |
| `plugins.entries.voice-call.config.streaming.providers.gradium.semanticVadThreshold`    | number  | VAD probability threshold that triggers a Gradium `flush`. Defaults to `0.5`.                                                                              |
| `plugins.entries.voice-call.config.streaming.providers.gradium.semanticVadHorizonIndex` | number  | Which `step.vad[]` prediction horizon OpenClaw reads. Defaults to `2`.                                                                                     |

The default `ulaw_8000` input format matches the audio format Voice Call telephony bridges send.

### Natural turn taking

OpenClaw maps Gradium realtime events into the shared Voice Call transcript lifecycle:

| Gradium event                      | OpenClaw behavior                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ready`                            | Marks the realtime transcription session ready.                                                                                                                                      |
| `text`                             | Emits a partial transcript delta and starts a user turn if needed.                                                                                                                   |
| `step`                             | Reads semantic VAD `inactivity_prob` scores; when the configured horizon crosses the threshold, OpenClaw sends `flush`.                                                              |
| `end_text`                         | Commits the pending text after a semantic flush request, or schedules a short fallback `flush` if no semantic flush is pending. When `semanticVad` is disabled, commits immediately. |
| `flushed`, `done`, `end_of_stream` | Commits the pending text as the final user transcript.                                                                                                                               |
| `error`                            | Fails connection setup or reports a session error.                                                                                                                                   |

This means Gradium can commit a turn because the transcript context suggests the user is done, not only because the audio went quiet. If your calls cut users off, raise `semanticVadThreshold` or `semanticVadHorizonIndex`. If responses feel late, lower one of those values.

### Minimal voice-agent recipe

1. Enable Voice Call streaming with `provider: "gradium"`.
2. Keep `inputFormat: "ulaw_8000"` for telephony bridges that already send G.711 u-law frames.
3. Leave `semanticVad: true` for normal agent conversations.
4. Omit `language` for multilingual calls, or set a language hint when a line is known to be monolingual.
5. Use `messages.tts.provider: "gradium"` when you want Gradium to synthesize the agent's reply audio too.

## How Gradium differs from other STT providers

Deepgram, ElevenLabs, Mistral, OpenAI, and xAI also provide Voice Call streaming STT in OpenClaw. Gradium's main distinction is that semantic VAD is part of the realtime STT stream and OpenClaw uses it to trigger transcript commits.

| Need                                                              | Good fit                                                                                |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Batch voice-note transcription                                    | Use `tools.media.audio` with Deepgram, ElevenLabs, Mistral, OpenAI, SenseAudio, or xAI. |
| Live calls with codec-level endpointing                           | Deepgram, ElevenLabs, Mistral, OpenAI, or xAI.                                          |
| Live calls where turn timing should consider transcript semantics | Gradium.                                                                                |
| One provider for live STT plus outbound TTS                       | Gradium or ElevenLabs.                                                                  |

## Related

- [Text-to-Speech](/tools/tts)
- [Media Overview](/tools/media-overview)
- [Voice Call](/cli/voicecall)
