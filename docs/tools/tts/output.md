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
text instead. When that fallback follows an immediate delivery result, it comes
before later replies from the same turn. Channels that buffer sends until the
turn settles may send the fallback after their buffered replies. `tagged` mode
keeps its normal streaming behavior. Speech inside a `[[tts:text]]` block remains
audio-only and is delivered after the streamed text, including when a separate
final reply remains and when `tts.mode` is `"all"`.

Visible captions and their text fallbacks preserve whitespace inside code blocks.
When streamed and final answers differ only in paragraph separators, OpenClaw
delivers the final answer once, preserving its paragraph spacing. Spaces, tabs,
and indentation within lines remain significant when comparing answers.

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
- Never attaches audio to a reply that already carries media: one message holds
  one media set, and the audio would replace the attachment. In `mode: "final"`,
  when that attachment is not audio — a picture, a document, a video — the answer
  is spoken as a separate voice message that follows the visible one. A reply
  that already carries audio stays as it is, and so does a terminal command
  reply.
  That separate voice message is live-only on every channel: it is not written to
  the durable outbound queue and is not replayed after a Gateway restart, so a
  restart can lose the audio while the visible answer it repeats has already
  arrived. Channels see the policy on the payload itself (`ttsSupplement.liveOnly`).
  The separate message exists only in final-mode auto-TTS: with `mode: "all"` a
  media reply stays silent — inline synthesis skips media payloads and no
  supplement is minted — and ACP delivery applies its own synthesis and is not
  part of this path.
- Skips very short replies (under 10 chars).
- Skips replies dominated by fenced code; inline code and surrounding prose remain eligible for speech.
- Summarizes long replies when summaries are enabled, using
  `summaryModel` (or `agents.defaults.model.primary`).
  Summary model access uses the replying agent's credentials and ownership.
- Attaches the generated audio to the reply.
- In `mode: "final"`, sends TTS after streamed text completes. Channels without
  captioned-final support receive an audio-only supplement; Telegram puts text
  within its caption limit on the voice note and sends overflow as follow-up
  text. Generated media goes through the same channel media normalization as
  normal reply attachments.

In the Control UI, delayed speech attaches to its original answer, including
after a reload. Publishing the answer text does not consume its pending speech
supplement; a final message-tool reply retains its separate delivery custody.

If the reply exceeds `maxLength`, OpenClaw never skips audio outright:

- **Summary on** (default) and a summary model is available: summarizes the
  text to roughly `maxLength` chars, then synthesizes the summary.
- **Summary off**, summarization fails, or no API key is available for the
  summary model: truncates the text to `maxLength` chars and synthesizes the
  truncated text.

```text
Reply -> TTS enabled?
  no  -> send text
  yes -> short?
          yes -> send text
          no  -> has media?
                    yes -> send the reply as it is, then:
                             audio attachment     -> nothing further
                             non-audio attachment -> mode "final"?
                                                      yes -> TTS -> send audio-only message
                                                      no  -> nothing further (ACP and
                                                              non-final modes stay silent)
                   no  -> length > limit?
                            no  -> TTS -> attach audio
                            yes -> summary enabled and available?
                                      no  -> truncate -> TTS -> attach audio
                                      yes -> summarize -> TTS -> attach audio
```

## Channel contract for live-only supplements

Several payload shapes carry `ttsSupplement`: ordinary auto-TTS replies and the
deferred text of captioned-final delivery keep the answer text and are not
marked live-only. The rules below apply only to the media voice supplement
described above — a payload marked `ttsSupplement.liveOnly: true` together with
`ttsSupplement.visibleTextAlreadyDelivered: true` (text absent, `mediaUrl` holds
the audio). Channels and reply-delivery plugins that consume outbound payloads
must honor three rules for such a payload:

1. **A supplement never replaces the visible answer.** It arrives as its own
   audio-only payload (text is absent, `mediaUrl` holds the audio, and
   `ttsSupplement.visibleTextAlreadyDelivered` explains why): send it as an
   additional voice message and leave the already-delivered answer untouched.
   A channel that maps textless payloads onto "edit last message" or "delete
   then resend" will destroy the answer it repeats — a real VK plugin shipped
   that defect once, which is why the flag exists.
2. **`liveOnly` must survive payload normalization.** While preparing a payload
   for transport, keep `ttsSupplement.liveOnly` intact. The audio is fenced
   only by an in-memory writer authority; persisting it for replay would let a
   restart deliver it past a replaced writer. Treat the flag as
   delivery-policy, not display metadata.
3. **Never batch a live-only supplement with durable payloads.** Send it in its
   own delivery; the outbound queue rejects mixed batches outright. A supplement
   that loses the race with a Gateway restart is simply gone — the visible
   answer has already arrived, and that is the accepted trade.
