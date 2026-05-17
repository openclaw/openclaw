# Plan — OpenAI Realtime API for Talk Mode + Voice Wake

## Approach

Add a Realtime adapter layer to the agent runtime that owns a long-lived OpenAI Realtime session per active Talk Mode session, bridges audio in/out, and re-uses the existing tool registry. On the device side, the macOS/iOS/Android apps stream microphone audio over WebRTC to the Gateway, which forwards (after auth) to OpenAI Realtime. The current TTS/STT pipeline becomes a fallback for environments where Realtime keys aren't configured. The `VoiceWakeForwarder` PATH/command pattern (`openclaw-mac agent --message "${text}" --thinking low`) stays compatible because the wake path still emits a final transcript via `gpt-realtime-whisper` before invoking the agent.

## Steps

1. Add `src/agents/realtime/session.ts` — OpenAI Realtime client built on `ws` + `undici` per-account proxy dispatcher; capability negotiation; tool registration mapping `tool-policy` allowlist into `tools` field on session config.
2. Add `src/agents/realtime/audio-bridge.ts` — pcm16 ↔ Opus / WebM transcoding; sample-rate handling for Apple ↔ Android ↔ server side.
3. Extend the Gateway WS protocol (`src/gateway/`) with a `realtime.open|input|output|close` message family. Generate Swift bindings via `pnpm protocol:gen:swift` (then `pnpm protocol:check`).
4. `apps/macos`, `apps/ios`, `apps/android` — point Talk Mode and Voice Wake at the new Gateway methods. Reuse existing Canvas / camera capture; pipe captured frames as image input to the Realtime session.
5. Voice Wake STT path: replace the current transcription helper with a single Realtime-Whisper call that streams a final transcript, then invokes the text agent as today. Keep the launchd PATH fix from `AGENTS.md`.
6. Tool dispatch: wire long-running tool calls into the Realtime `function_call` event flow such that the model keeps talking while a browser/canvas call runs (Realtime now tolerates long function calls).
7. MCP tools (from `2026-05-16-mcp-host`) surface to Realtime via the session config — same allowlist, no separate registration.
8. Config: `voice.realtime.enabled`, `voice.realtime.model` (default `gpt-realtime-2`), `voice.realtime.reasoningEffort` (default `low`), `voice.realtime.whisperModel` (default `gpt-realtime-whisper`). Onboarding wizard asks for `OPENAI_REALTIME_API_KEY` (separate from existing OpenAI key — allows different quota).
9. Fallback: if Realtime config is absent, route Talk Mode through the current TTS+text+STT pipeline unchanged.

## Dependencies / order

- Steps 1–2 block everything else.
- Step 3 (protocol) blocks step 4 (apps).
- Step 6 (long tool calls) depends on step 1.
- Step 7 (MCP) depends on `2026-05-16-mcp-host` shipping the client side.
- Step 9 (fallback) is a guard; can land first to avoid breaking existing users.
