# PRD: Voice LLM Streaming for Early TTS (Issue #3)

## Status

Draft

## Problem Statement

The current Discord voice flow blocks on `agentCommand()` until the full model response is complete, then performs sentence splitting and TTS. This creates avoidable first-audio latency even though sentence-level TTS/playback is already pipelined. The goal is to start TTS as soon as the first complete sentence is available from streamed LLM output, while preserving final response correctness and session history integrity.

## Proposed Approach

Use the existing embedded assistant stream events instead of adding a new runner-level stream hook:

1. **Command callback contract:** Add optional `onTextDelta?: (delta: string) => void` to `AgentCommandOpts`.
2. **Embedded path bridging (no runner plumbing):** In `agentCommand`, compose the existing embedded `onAgentEvent` callback so that when `stream === "assistant"` and `data.delta` is non-empty, `onTextDelta(data.delta)` is invoked. Keep existing lifecycle tracking logic intact.
3. **ACP path parity:** In ACP `text_delta` handling, invoke `onTextDelta(event.text)` in addition to current aggregated `streamedText` behavior.
4. **Voice streaming pipeline:** In `DiscordVoiceManager.processSegment`, start `agentCommand` with `onTextDelta`, buffer incoming text, emit complete sentences to TTS immediately, and flush trailing text when the run completes.
5. **Barge-in gating:** Add a monotonic per-session generation counter in voice manager and gate both TTS generation and playback tasks so stale chunks are skipped after interruption.
6. **History integrity:** Keep final persistence sourced from the final `agentCommand` result; streaming remains playback-only side channel.

## Scope

### In Scope

- `AgentCommandOpts` optional text-delta callback.
- Embedded/ACP callback invocation from `agentCommand`.
- Voice sentence streaming + early TTS start in `src/discord/voice/manager.ts`.
- Generation-token stale-chunk suppression for barge-in.
- Regression coverage for final response/session history integrity.

### Out of Scope

- Changes to `runEmbeddedPiAgent`/`runEmbeddedAttempt` stream internals.
- Reworking TTS provider internals.
- Changing ACP runtime protocol/event schema.

## Implementation Stages

### Stage 1 — `agentCommand` text-delta callback (non-breaking)

Implement optional callback support in:

- `src/commands/agent/types.ts` (`AgentCommandOpts`)
- `src/commands/agent.ts` (invoke callback in embedded assistant-delta path and ACP `text_delta` path)

**Acceptance criteria**

- Existing callsites compile unchanged.
- Embedded assistant delta events invoke callback with monotonic deltas.
- ACP `text_delta` events invoke callback.
- Callback remains optional and no-op when omitted.

### Stage 1 Test Plan

- **Test file:** `src/commands/agent.test.ts`
- **Test cases:**
  1. `agentCommand_embedded_forwards_assistant_deltas_to_onTextDelta` — embedded run emits assistant deltas and tool/lifecycle events; only assistant deltas trigger callback, in order.
  2. `agentCommand_without_onTextDelta_preserves_existing_behavior` — omitting callback returns same payload/meta behavior.
- **Test file:** `src/commands/agent.acp.test.ts`
- **Test cases:**
  1. `agentCommand_acp_forwards_text_delta_to_onTextDelta` — ACP `text_delta` events invoke callback while final payload remains aggregated text.

---

### Stage 2 — Voice sentence streaming + generation gating

Refactor `processSegment` in `src/discord/voice/manager.ts`:

- kick off `agentCommand` with `onTextDelta`,
- maintain streaming text buffer + sentence extraction state,
- send each complete sentence to TTS immediately,
- flush any non-empty trailing sentence when command resolves,
- gate TTS/playback tasks by current generation token so stale work is dropped.

**Acceptance criteria**

- First playable audio can start before `agentCommand` resolves.
- Sentence order is preserved.
- Interruption increments generation and prevents stale queued chunks from prior generation playing.
- Non-streaming runs (no incremental deltas, final text emitted at end) still speak exactly once.
- Completion flush only speaks unsent remainder; it never duplicates already-dispatched sentences.

### Stage 2 Test Plan

- **Test file:** `src/discord/voice/manager.test.ts`
- **Test cases:**
  1. `processSegment_starts_tts_before_agent_completion` — first sentence TTS starts before agent promise resolves.
  2. `processSegment_buffers_until_sentence_boundary` — incomplete text does not trigger TTS until boundary arrives.
  3. `processSegment_flushes_tail_on_completion` — trailing non-punctuated remainder is spoken once on completion.
  4. `processSegment_skips_stale_chunks_after_barge_in` — generation N chunks after interruption are skipped; generation N+1 proceeds.
  5. `processSegment_non_streaming_model_speaks_once_on_completion` — when only a final assistant chunk arrives, speech still occurs once without duplicate playback.
  6. `processSegment_flush_does_not_repeat_already_streamed_text` — completion logic dispatches only unsent remainder.

---

### Stage 3 — Final response persistence regression hardening

Ensure streaming playback does not change canonical stored response behavior:

- final text persistence still comes from `agentCommand` completion payload,
- no duplicate final text emission side effects from streaming callback usage.

**Acceptance criteria**

- Session history stores full final response text.
- No duplicate final payloads or transcript entries caused by streaming callback.

### Stage 3 Test Plan

- **Test file:** `src/commands/agent.test.ts`
- **Test cases:**
  1. `agentCommand_streaming_callback_does_not_mutate_final_payload` — callback receives deltas; returned payload remains exact final text.
  2. `agentCommand_session_store_records_complete_text_with_streaming` — persisted session/transcript reflects complete final response.

## Alternatives Considered

1. **Runner-level `onTextDelta` plumbing through `runEmbeddedAttempt`**
   - Rejected: embedded streaming deltas already surface through assistant `onAgentEvent`; duplicating stream hooks adds complexity without improving behavior.
2. **Voice subscribing directly to global `emitAgentEvent` bus**
   - Rejected: tighter coupling to global event plumbing and run-id filtering; explicit `agentCommand` callback is cleaner and easier to test.
3. **Keep current blocking flow and optimize only TTS generation**
   - Rejected: does not remove the dominant latency from waiting for full LLM completion.

## Dependencies

- Existing assistant delta emission from embedded subscriber (`src/agents/pi-embedded-subscribe.handlers.messages.ts`).
- ACP `text_delta` events in `agentCommand` ACP path.
- Voice TTS stack (`parseTtsDirectives`, `textToSpeech`, playback queueing) in `src/discord/voice/manager.ts`.

## Risks and Mitigations

1. **Sentence boundary mistakes (abbreviations/newlines/fragments)**
   - Mitigation: use conservative boundary detection, plus guaranteed final tail flush on completion.
2. **Stale speech after interruption**
   - Mitigation: generation token check before both TTS generation and playback execution.
3. **Non-voice regression risk**
   - Mitigation: callback is optional and isolated; add no-callback regression tests in command layer.
4. **Directive interaction while streaming**
   - Mitigation: retain existing `parseTtsDirectives` behavior for spoken text normalization before TTS dispatch.
5. **Duplicate speech from stream/end overlap**
   - Mitigation: track dispatched text boundary (or sentence queue identity) and flush only unseen content.

## Decisions (Resolved)

1. Sentence boundaries use punctuation (`.`, `!`, `?`) and newline boundaries.
2. Non-empty trailing text is flushed once when `agentCommand` completes.
3. Barge-in generation token handling is implemented in this issue (do not depend on external branch state).
