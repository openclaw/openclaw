---
summary: "The tts agent tool and the Gateway TTS RPC methods"
title: "Text-to-speech agent tool and Gateway RPC"
read_when:
  - You are calling TTS from an agent tool call
  - You need the Gateway tts.* RPC method list
---

## Agent tool

The `tts` tool converts text to speech and returns an audio attachment for
reply delivery. On Feishu, Matrix, Telegram, and WhatsApp, the audio is
delivered as a voice message rather than a file attachment. Feishu and
WhatsApp can transcode non-Opus TTS output on this path when `ffmpeg` is
available.

WhatsApp sends audio through Baileys as a PTT voice note (`audio` with
`ptt: true`) and sends visible text **separately** from PTT audio because
clients do not consistently render captions on voice notes.

The tool accepts optional `channel` and `timeoutMs` fields; `timeoutMs` is a
per-call provider request timeout in milliseconds. Per-call values override
`tts.timeoutMs`; configured TTS timeouts override any plugin-authored
provider default.

## Gateway RPC

| Method            | Purpose                                      |
| ----------------- | -------------------------------------------- |
| `tts.status`      | Read current TTS state and last attempt.     |
| `tts.enable`      | Set local auto preference to `always`.       |
| `tts.disable`     | Set local auto preference to `off`.          |
| `tts.convert`     | One-off text → audio.                        |
| `tts.setProvider` | Set local provider preference.               |
| `tts.personas`    | List configured personas and the active one. |
| `tts.setPersona`  | Set local persona preference.                |
| `tts.providers`   | List configured providers and status.        |
