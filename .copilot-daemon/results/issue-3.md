## PRD Approved

The PRD proposes a minimal and coherent streaming integration: add an optional `onTextDelta` callback through embedded + ACP command paths, stream sentence-level TTS in `processSegment`, and preserve canonical final response/session history on completion. It directly addresses prior reviewer concerns (runner callback plumbing and explicit barge-in integration), keeps non-voice behavior backward compatible, and defines staged acceptance criteria with concrete tests for ordering, deduplication, and interruption safety.

### Location

prd/issue-3.v2.md

### Stages

1. Runner callback plumbing (`runEmbeddedPiAgent`/`runEmbeddedAttempt`) with optional `onTextDelta`; test that only assistant `text_delta` events trigger callback in-order and no duplicates from `text_end`.
2. `agentCommand` callback surface and forwarding for embedded + ACP; test non-breaking optional behavior and per-delta callback parity across both execution paths.
3. Voice sentence streaming in `processSegment`; test early first-TTS before command completion, sentence-boundary buffering, trailing-fragment flush, unseen-suffix-only final flush, and non-streaming fallback.
4. Barge-in + history integrity safeguards; test stale generation chunk suppression at TTS/playback boundaries and complete single-entry final persistence.

### Test Plan

- Embedded subscriber + attempt tests for callback invocation scope and forwarding.
- `agentCommand` embedded/ACP tests for callback parity and unchanged final payload/persistence semantics.
- Voice manager tests for early audio start, deterministic sentence ordering, overlap-safe completion flush, directive consistency, and stale-generation dropping after interruption.
