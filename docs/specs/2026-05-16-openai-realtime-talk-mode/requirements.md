# Requirements — OpenAI Realtime API for Talk Mode + Voice Wake

## Outcome

Talk Mode (continuous conversation) and Voice Wake (push-to-talk / wake-word transcription) on the macOS/iOS/Android apps run on OpenAI's GA Realtime API: `gpt-realtime-2` for the conversational loop and `gpt-realtime-whisper` for streaming speech-to-text, replacing the current TTS+STT round-trip stack. Long-running tool calls (browser, canvas, channel send) don't interrupt the voice loop.

## Users affected

- Operators using Voice Wake / Talk Mode on Apple/Android devices.
- The agent runtime — currently routes voice through transcription → text agent → TTS in three steps.
- The `extensions/voice-call` plugin (separate Twilio path — coordinated, not replaced here).
- Talk Mode UI in `apps/macos`, `apps/ios`, `apps/android`.

## In scope

- New `src/agents/realtime/` runtime that holds a WebRTC/WebSocket Realtime session, streams audio in, streams audio + transcripts out, and dispatches tool calls through the same `tool-policy` + `sessions_*` machinery as the text loop.
- `gpt-realtime-2` for the conversational model; configurable reasoning effort (minimal / low / medium / high / very-high) — default `low` to match the existing Voice Wake forwarder.
- `gpt-realtime-whisper` for streaming STT in Voice Wake (push-to-talk capture → final transcript before the text agent runs).
- Image input through the Realtime API (camera snap / canvas screenshot piped inline).
- MCP server tools surfaced to Realtime via the Realtime API's MCP server support.
- Fallback to the current pipeline when `OPENAI_REALTIME_API_KEY` is absent.

## Out of scope

- SIP phone-call answering (covered by `2026-05-16-sip-phone-channel`).
- Realtime translation channel (the `gpt-realtime-translate` integration is a follow-up; tracked separately).
- Anthropic voice (no GA realtime voice from Anthropic as of May 2026).
- Removing the existing `node-edge-tts` / ElevenLabs paths — they stay as cheap fallbacks for text-only TTS in non-Talk contexts.

## Decisions

- WebSocket transport for the macOS/Linux Gateway → OpenAI Realtime hop; WebRTC for the iOS/Android nodes → Gateway hop. Reason: WebRTC handles client-side jitter; the server→OpenAI side benefits from the simpler WS transport.
- Default reasoning effort `low`. Reason: matches today's `openclaw-mac agent --thinking low` convention so existing operators don't get unexpected latency.
- Keep streaming OFF for external messaging channels. Reason: existing rule (no partials to WhatsApp/Telegram/etc.). Voice surfaces are internal so streaming is fine.
