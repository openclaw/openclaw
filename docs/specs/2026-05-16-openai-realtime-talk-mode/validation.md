# Validation — OpenAI Realtime API for Talk Mode + Voice Wake

## Automated tests

- `src/agents/realtime/session.test.ts` — connection lifecycle, capability negotiation, tool registration, reasoning-effort config plumb-through.
- `src/agents/realtime/audio-bridge.test.ts` — pcm16↔Opus round-trip, sample-rate conversion, silence/EOS handling.
- `src/gateway/realtime-rpc.test.ts` — new WS methods accept/reject per fail-closed auth; protocol schema validates.
- `pnpm protocol:check` — confirms `dist/protocol.schema.json` + Swift bindings stay in sync.
- Apps unit tests (XCTest + JUnit) — Talk Mode state machine + Voice Wake forwarder.
- `vitest.live.config.ts` matrix entry for Realtime: gated on `OPENAI_REALTIME_LIVE=1`, exercises a 30-second conversation with one tool call.

## Smoke checks

- `openclaw configure --section voice` shows the new Realtime section with the masked key.
- macOS: hold-to-talk via the menu bar; speak "what time is it?"; expect spoken reply.
- macOS: Talk Mode toggle; ask the agent to "search the web for X" → tool call fires, audio reply resumes without dropping the channel.
- Voice Wake (mobile): say the wake word; the final transcript appears in the chat surface and the agent answers via Realtime audio.
- Fallback test: remove `OPENAI_REALTIME_API_KEY`; Talk Mode degrades to the previous TTS/STT path without errors.

## Manual criteria

- Latency from end-of-speech to first audio output ≤ 800ms on a wired Mac in good network conditions (subjective on mobile cellular).
- Echo/duplex is acceptable — the device doesn't pick up its own output as new input.
- Reasoning-effort `low` doesn't add perceived sluggishness vs. the old pipeline.

## AI eval plan

- Success criteria: on a 25-prompt voice-eval set spanning Q&A, multi-turn, tool calls, and image inputs, transcript WER ≤ 5% (vs. a reference transcript) and tool-call accuracy ≥ 90%.
- Eval dataset: `tests/evals/realtime-voice/` — short WAV clips + expected transcripts + expected tool selections.
- Regression set: 6 cases — "hello", "remember Y", "search X", "look at this image" (with camera snap), "stop", barge-in mid-reply.
- Cadence: live matrix on every PR that touches `src/agents/realtime/` or the apps' Talk Mode views; nightly on the live-models matrix.

## Risks & rollback

- **Risks:**
  - WebRTC NAT traversal fails on some networks. *Detect via* a TURN fallback config + the `gateway-network` E2E.
  - Realtime usage bills against a different OpenAI quota than text — operators get surprise costs. *Mitigate* by surfacing per-session token + audio-second usage in `/usage`.
  - Audio sync drift on long sessions. *Detect via* timed echo test in the live matrix.
  - Long-running tool calls block the loop on older Realtime versions. *Mitigate* by gating on the GA model id; doctor warns when set to a pre-GA id.
- **Rollback:** set `voice.realtime.enabled=false` to revert to the old pipeline. PR revert is safe because step 9 (fallback) preserves existing behavior.

## Open questions

- Should the camera-snap image input fire automatically on every Talk Mode turn, or only when the operator opts in per session? Lean opt-in for privacy.
- How do we expose audio-second usage in the existing `/usage` chat command? (Decide before Step 8 ships.)
