---
summary: "Per-channel audio formats, transcoding, and what Auto-TTS sends"
title: "Text-to-speech output and Auto-TTS behavior"
read_when:
  - You need the audio format a channel receives
  - You are debugging voice-note delivery or transcoding
  - You want to know when Auto-TTS summarizes or truncates a reply
---

## Output formats

TTS voice delivery is channel-capability driven. Channel plugins advertise
whether voice-style TTS should ask providers for a native `voice-note` target or
keep normal `audio-file` synthesis, and whether the channel transcodes
non-native output before sending.

One-off speech requests from the agent tool and `/tts` commands use the same
channel delivery rules as automatic replies.

Telegram also advertises captioned final TTS. With `tts.mode: "final"` and
Auto-TTS set to `always` (or eligible `inbound` mode), streamed text is held
until synthesis finishes and sent as the voice-note caption. Text beyond
Telegram's caption limit follows the voice note as a normal text message. If
synthesis or a proven pre-send delivery step fails, OpenClaw sends the visible
text instead. `tagged` mode keeps its normal streaming behavior, and text
inside a `[[tts:text]]` block remains audio-only.

After synthesis, OpenClaw persists batch TTS output in the media store under
`tool-speech-synthesis`. The reply uses that stable media path instead of a
provider temporary file, and normal media maintenance prunes expired output.
Local CLI providers may still use `{{OutputPath}}` as scratch space before
OpenClaw imports the completed bytes. See [Media playback](/nodes/media-playback)
for inline-player formats and limits.

| Target                                | Format                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Feishu / Matrix / Telegram / WhatsApp | Voice-note replies prefer **Opus** (`opus_48000_64` from ElevenLabs, `opus` from OpenAI). 48 kHz / 64 kbps balances clarity and size. |
| Other channels                        | **MP3** (`mp3_44100_128` from ElevenLabs, `mp3` from OpenAI). 44.1 kHz / 128 kbps is the default balance for speech.                  |
| Talk / telephony                      | Provider-native **PCM** (Inworld 22050 Hz, Google 24 kHz), or `ulaw_8000` from Gradium for telephony.                                 |

Per-provider notes:

- **Feishu / WhatsApp transcoding:** when a voice-note reply lands as MP3/WebM/WAV/M4A or another likely audio file, the channel plugin transcodes it to 48 kHz Ogg/Opus with `ffmpeg` (`libopus`, 64 kbps) before sending the native voice message. WhatsApp sends the result through the Baileys `audio` payload with `ptt: true` and `audio/ogg; codecs=opus`. On transcode failure: Feishu catches the error and falls back to sending the original file as a plain attachment; WhatsApp has no fallback, so the send itself fails rather than posting an incompatible PTT payload.
- **MiniMax:** MP3 (`speech-2.8-hd` model, 32 kHz sample rate) for normal audio attachments; transcoded to 48 kHz Opus with `ffmpeg` for channel-advertised voice-note targets.
- **Xiaomi MiMo:** MP3 by default, or WAV when configured; transcoded to 48 kHz Opus with `ffmpeg` for channel-advertised voice-note targets.
- **Local CLI:** uses the configured `outputFormat`. Voice-note targets are converted to Ogg/Opus and telephony output is converted to raw 16 kHz mono PCM with `ffmpeg`.
- **Google Gemini:** returns raw 24 kHz PCM. OpenClaw wraps it as WAV for audio attachments, transcodes it to 48 kHz Opus for voice-note targets, and returns PCM directly for Talk/telephony.
- **Gradium:** WAV for audio attachments, Opus for voice-note targets, and `ulaw_8000` at 8 kHz for telephony.
- **Inworld:** MP3 for normal audio attachments, native `OGG_OPUS` for voice-note targets, and raw `PCM` at 22050 Hz for Talk/telephony.
- **xAI:** MP3 by default; audio-file synthesis may use `mp3`, `wav`, `pcm`, `mulaw`, or `alaw` for both buffered and streaming output. Voice-note targets use MP3 for streaming and buffered fallback because xAI's `pcm`, `mulaw`, and `alaw` outputs are headerless raw audio. Buffered synthesis uses xAI's batch REST `/v1/tts` endpoint; `textToSpeechStream` uses native `wss://api.x.ai/v1/tts`. This is not the realtime voice contract. Native Opus voice-note format is not supported.
- **Microsoft:** uses `microsoft.outputFormat` (default `audio-24khz-48kbitrate-mono-mp3`).
  - The bundled transport accepts an `outputFormat`, but not all formats are available from the service.
  - Output format values follow Microsoft Speech output formats (including Ogg/WebM Opus).
  - Telegram `sendVoice` accepts OGG/MP3/M4A; use OpenAI/ElevenLabs if you need guaranteed Opus voice messages.
  - If the configured Microsoft output format fails, OpenClaw retries with MP3.
  - When no explicit voice override is set and the default English voice is used, OpenClaw auto-switches to a Chinese neural voice (`zh-CN-XiaoxiaoNeural`, `zh-CN` locale) if the reply text is CJK-dominant.

OpenAI and ElevenLabs choose output formats per channel as listed above. An
explicit OpenAI `responseFormat` overrides that selection; a format that is not
voice-note compatible may be delivered as an audio file or transcoded by a
channel that supports conversion.

## Auto-TTS behavior

When `tts.auto` is enabled, OpenClaw:

- Keeps terminal slash and plugin command replies text-only, including with
  `auto: "always"`. Explicit speech requests such as `/tts audio` and `/tts latest`
  still send audio. Commands that continue into an assistant run keep the normal
  auto-TTS behavior for the assistant's answer.
- Skips TTS if the reply already contains structured media.
- Skips very short replies (under 10 chars).
- Skips replies dominated by fenced code; inline code and surrounding prose remain eligible for speech.
- Summarizes long replies when summaries are enabled, using
  `summaryModel` (or `agents.defaults.model.primary`).
- Attaches the generated audio to the reply.
- In `mode: "final"`, sends TTS after streamed text completes. Channels without
  captioned-final support receive an audio-only supplement; Telegram puts text
  within its caption limit on the voice note and sends overflow as follow-up
  text. Generated media goes through the same channel media normalization as
  normal reply attachments.

If the reply exceeds `maxLength`, OpenClaw never skips audio outright:

- **Summary on** (default) and a summary model is available: summarizes the
  text to roughly `maxLength` chars, then synthesizes the summary.
- **Summary off**, summarization fails, or no API key is available for the
  summary model: truncates the text to `maxLength` chars and synthesizes the
  truncated text.

```text
Reply -> TTS enabled?
  no  -> send text
  yes -> has media / short?
          yes -> send text
          no  -> length > limit?
                   no  -> TTS -> attach audio
                   yes -> summary enabled and available?
                            no  -> truncate -> TTS -> attach audio
                            yes -> summarize -> TTS -> attach audio
```
