## PRD Approved

The PRD proposes the simplest viable path to early voice playback latency reduction by reusing existing embedded assistant stream events and adding an optional `onTextDelta` callback at `agentCommand`, then consuming that stream in Discord voice `processSegment` for sentence-by-sentence TTS while preserving canonical final response/session persistence from the completed command result.

### Location

prd/issue-3.md

### Stages

1. `agentCommand` callback wiring: add optional `onTextDelta` and forward embedded assistant delta + ACP `text_delta` without breaking existing callsites; test criteria: embedded and ACP callbacks fire in order and omitted callback is no-op.
2. Voice streaming + barge-in generation gating: buffer deltas, dispatch complete sentences to TTS immediately, flush unsent tail once, and drop stale chunks after interruption; test criteria: first TTS starts before command completion, sentence boundaries are respected, no duplicate tail speech, stale generation chunks never play.
3. Final response persistence integrity: keep storage based on final `agentCommand` payload, not streaming side effects; test criteria: full final response is persisted and streaming callback does not mutate/duplicate canonical payload.

### Test Plan

- `src/commands/agent.test.ts`: embedded delta forwarding, optional-callback regression, final payload/session integrity.
- `src/commands/agent.acp.test.ts`: ACP `text_delta` forwarding with unchanged final aggregation.
- `src/discord/voice/manager.test.ts`: early-TTS-before-completion, sentence-boundary buffering, completion-tail flush, non-streaming single-speak behavior, and stale-generation suppression after barge-in.
