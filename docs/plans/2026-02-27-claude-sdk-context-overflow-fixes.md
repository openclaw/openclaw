# Claude SDK Runtime Hardening Plan (Context, Media, Compaction, Parity)

Date: 2026-02-27
Status: Draft execution spec (implementation-ready)
Owners: Agents runtime / Claude SDK integration

## 1) Why this exists

This document is the authoritative implementation plan for hardening OpenClaw's Claude SDK runtime path so we:

- stop re-sending redundant context,
- stop inflating prompts with inline base64 media unless strictly necessary,
- preserve prompt-priming parity with Pi where required,
- rely on Claude SDK / server-side session semantics correctly,
- maintain session JSONL parity for observability and cross-runtime resume.

If this thread is interrupted, continue from this file.

## 2) Problem statement (current risks)

### 2.1 Duplicate thread context still leaks into resumed Claude turns

Current stripping only works when thread context is at the very beginning of the prompt (`[Thread history - for context]` / `[Thread starter - for context]`).

- Stripping logic: `src/agents/claude-sdk-runner/create-session.ts`
- Prompt can have prefixes before thread context (media note, hook prepend):
  - `src/auto-reply/reply/get-reply-run.ts`
  - `src/agents/pi-embedded-runner/run/attempt.ts`

Impact: resumed sessions can still get repeated thread history and token bloat.

### 2.2 We still inline media data in critical paths

- User prompt images are sent as base64 blocks in `create-session.ts`.
- Tool results can carry image-like blocks and we serialize non-text blocks into local transcript text in MCP bridge.

Relevant files:

- `src/agents/claude-sdk-runner/create-session.ts`
- `src/agents/claude-sdk-runner/mcp-tool-server.ts`
- `src/agents/claude-sdk-runner/event-adapter.ts` (tracks `files_persisted` but does not drive attachment mode yet)

Impact: unnecessary token pressure, larger request payloads, and weak attachment lifecycle semantics.

### 2.3 Prompt-priming parity for Claude path is incomplete

Pi path does extensive local transcript sanitize/limit/repair before request assembly. Claude path does not run the same history pipeline because runtime is server-managed.

Relevant file split:

- Claude branch starts: `src/agents/pi-embedded-runner/run/attempt.ts`
- Pi-only sanitize/limit branch: same file

Impact: hooks and diagnostics that depend on local history may diverge from Pi behavior.

### 2.4 Runtime-specific safety handling gaps

- Orphan trailing user-message cleanup is effectively Pi-only.
- Claude overflow retry may repeat with no material state change for hard-size failures.
- Resume ID is consumed without robust stale/invalid recovery policy.

Relevant files:

- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/claude-sdk-runner/prepare-session.ts`

## 3) Architecture constraints we must respect

1. Claude SDK sessions are server-managed and resumable; local mirror is secondary. [R1] [R3]
2. SDK has explicit query/session semantics and supports resumable sessions, compact boundaries, and status lifecycle events. [R1] [R4]
3. Prompt/media should follow Anthropic multimodal conventions (text + media content blocks, URL/base64/file-based patterns depending on path). [R6] [R7]
4. OpenClaw JSONL still must remain useful for observability and cross-runtime continuity.
5. We should not run Pi-local compaction for Claude SDK runtime overflow recovery. Claude SDK/server handles context management and compaction. [R5]

## 4) Target behavior (required)

### 4.1 Thread context handling

- First turn in a fresh Claude SDK session may include thread bootstrap context.
- Subsequent resumed turns must never re-send historical thread context scaffold.
- Stripping must be robust to prefixed content (media-note, hook prepend, etc.), not just `startsWith`.

### 4.2 Media handling

- Prefer Anthropic-native external/persisted media patterns over repeated inline base64 where possible. [R6] [R7]
- Inline base64 remains fallback only for:
  - immediate one-shot media not persisted yet,
  - low-size payloads under explicit threshold,
  - strict compatibility fallback when file reference flow is unavailable.
- `files_persisted` events must be used as first-class lifecycle signals, not passive diagnostics.

### 4.3 Compaction behavior

- Claude runtime: never invoke Pi direct compaction or Pi tool-result truncation fallback in overflow path.
- Retry policy must differentiate:
  - retryable (compaction in-flight/just-finished),
  - terminal hard-size errors (fail fast with clear remediation).

### 4.4 Local parity for hooks and observability

- Keep local mirror sufficiently complete for hooks and diagnostics.
- Ensure Pi-resume from same JSONL remains coherent when switching runtime.

## 5) Implementation plan (all-inclusive)

## A) Robust thread-context stripping for resumed Claude sessions

### A.1 Behavior spec

Replace fragile prefix-only stripping with structured extraction:

- Find thread-context block markers anywhere near prompt top segment:
  - `[Thread history - for context]`
  - `[Thread starter - for context]`
- Strip only the scoped thread context segment, preserving:
  - media notes/hints,
  - hook prepend context,
  - user body.
- If format cannot be parsed safely, do not drop content silently.

### A.2 Code touchpoints

- `src/agents/claude-sdk-runner/create-session.ts`
  - replace `stripThreadContextPrefix(...)` with resilient parser-based variant.
- `src/agents/claude-sdk-runner/create-session.test.ts`
  - add tests for hook/media-prefix + thread context combinations.

### A.3 Acceptance tests

1. Resume session + hook prepend + thread context => only thread context removed.
2. Resume session + media note + thread context => only thread context removed.
3. Fresh session => no stripping.
4. Malformed delimiters => safe no-op.

## B) Attachment/media strategy migration (base64 -> persisted/external first)

### B.1 Behavior spec

Introduce attachment strategy layers (highest to lowest preference):

1. Persisted file reference (when available for same content hash).
2. URL reference (when safe + durable URL available).
3. Inline base64 fallback.

For repeated media across turns, avoid re-inlining bytes.

### B.2 Data model additions

In Claude session state and/or persisted JSONL custom entries, track:

- content hash -> file_id
- filename/logical label -> file_id
- last persistence failure + reason + timestamp
- retry backoff metadata

### B.3 Code touchpoints

- `src/agents/claude-sdk-runner/types.ts`
- `src/agents/claude-sdk-runner/create-session.ts`
- `src/agents/claude-sdk-runner/event-adapter.ts`
- `src/agents/claude-sdk-runner/mcp-tool-server.ts`

### B.4 Event usage

Use `system/files_persisted` to confirm which payloads are persisted and eligible for file-reference mode in later turns.

### B.5 Transcript parity requirements

Local JSONL should store explicit media reference metadata (hash, logical source, reference type), not opaque giant payload blobs when avoidable.

### B.6 Acceptance tests

1. same image reused across turns -> first turn may inline, subsequent uses reference persisted ID.
2. persistence failure path -> fallback inline + diagnostic marker.
3. no provider/session mismatch leakage of file IDs.

## C) Claude-path priming parity hardening

### C.1 Behavior spec

Even with server-side session authority, maintain local priming parity for hooks:

- build hook-visible history snapshot from local mirror + session manager context,
- run same validation/sanity steps used by Pi where they are safe/read-only,
- do not replay this history into Claude prompt payload.

### C.2 Code touchpoints

- `src/agents/pi-embedded-runner/run/attempt.ts`
  - factor Pi-only history sanitize into reusable read-only helper for hook context.
- `src/agents/claude-sdk-runner/create-session.ts`
  - optionally enrich local mirror from session manager at start.

### C.3 Acceptance tests

1. Hook gets expected historical context in Claude runtime.
2. Claude prompt payload size does not regress due to local parity improvements.

## D) Runtime-agnostic transcript integrity safeguards

### D.1 Orphan-user-message repair parity

Move orphan trailing-user correction out of Pi-only branch so Claude path can apply equivalent session-manager-level guard before append.

### D.2 Resume-ID stale recovery

If resume fails with session-not-found/invalid-session class errors:

1. clear stale local resume marker,
2. create fresh server session once,
3. retry once,
4. emit explicit diagnostic event.

### D.3 Code touchpoints

- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/claude-sdk-runner/prepare-session.ts`
- `src/agents/claude-sdk-runner/error-mapping.ts`

## E) Claude overflow retry policy hardening

### E.1 Behavior spec

For Claude runtime overflow:

- Retry only when evidence suggests post-compaction retry can succeed (e.g., compaction lifecycle observed this attempt).
- If repeated hard-size error fingerprint with no meaningful state delta, fail fast with actionable guidance instead of burning attempts.

### E.2 Code touchpoints

- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/claude-sdk-runner/event-adapter.ts` (expose compaction lifecycle markers)

### E.3 Acceptance tests

1. hard-size overflow repeats without compaction signals => early terminal path.
2. compaction observed + retry improves => succeeds.

## F) Expand SDK message exploitation (not just capture)

We already capture many event types; next step is operational use:

- `status` + `compact_boundary`: compaction-state machine quality and retry gating.
- `auth_status`: better UX/error stratification.
- `rate_limit_event`: dynamic backoff hints.
- `prompt_suggestion`: optional follow-up hinting path.
- hook/task events: improved progress and postmortem diagnostics.

Current capture points:

- `src/agents/claude-sdk-runner/event-adapter.ts`

Required next step: propagate selected signals into runtime policy decisions and metrics.

## G) Observability/metrics requirements

Add runtime counters + structured logs:

- `claude_sdk.prompt.thread_context_stripped` (bool + chars removed)
- `claude_sdk.media.inline_bytes_sent`
- `claude_sdk.media.file_ref_used`
- `claude_sdk.media.persist_failures`
- `claude_sdk.overflow.retries`
- `claude_sdk.overflow.fail_fast`
- `claude_sdk.resume.stale_recovered`

Diagnostics must include `runId`, `sessionId`, `sessionKey`, provider/model, attempt.

## 6) Rollout plan

Phase 1 (safe/high-impact)

1. Robust thread context stripping
2. Claude overflow retry hard-fail policy
3. Resume stale recovery path

Phase 2 (media migration)

1. Add persisted media map + file-ref preference
2. Wire `files_persisted` into actual send behavior
3. Transcript parity updates

Phase 3 (parity + telemetry)

1. Hook-priming parity helper
2. Orphan repair parity for Claude path
3. Metrics + dashboards/alerts

## 7) Test plan matrix

Unit

- create-session prompt normalization/stripping permutations
- event-adapter compaction and lifecycle transitions
- media strategy selection logic and fallback ordering
- stale resume detection/retry

Integration

- Claude runtime resumed thread with/without media notes/hook prepend
- multi-attempt overflow with compaction/no-compaction signals
- cross-runtime handoff (Claude -> Pi) on same JSONL

Regression

- Existing `run.overflow-compaction*.test.ts`
- Existing `create-session.test.ts` and `event-adapter.test.ts`

## 8) Non-goals

- Replacing Claude server-side compaction with custom local compaction.
- Duplicating full Anthropic SDK docs in OpenClaw docs.
- Forcing a single media path for every provider/runtime.

## 9) Risks and mitigations

1. Over-aggressive stripping could remove user content.

- Mitigation: strict parser + conservative fallback no-op + snapshot tests.

2. File reference semantics differ from local assumptions.

- Mitigation: use SDK message lifecycle (`files_persisted`) as source of truth; keep fallback path.

3. Runtime parity work reintroduces prompt bloat.

- Mitigation: parity context for hooks/diagnostics only; never auto-injected into Claude prompt on resumed sessions.

## 10) Reference index (external)

R1. Claude Code SDK overview: https://docs.anthropic.com/en/docs/claude-code/sdk

R2. Claude Code SDK streaming input (string vs async iterable user messages): https://docs.anthropic.com/en/docs/claude-code/sdk/streaming-input

R3. Claude Code SDK sessions/resume semantics: https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-sessions

R4. Claude Code SDK TypeScript reference (query options, message/event types): https://docs.anthropic.com/en/docs/claude-code/sdk/typescript

R5. Anthropic context windows and automatic context management/compaction: https://docs.anthropic.com/en/docs/build-with-claude/context-windows

R6. Anthropic vision input conventions (URL/base64/file API pathways): https://docs.anthropic.com/en/docs/build-with-claude/vision

R7. Anthropic Files API (upload + file_id reference workflows): https://docs.anthropic.com/en/docs/build-with-claude/files

R8. MCP specification (message/tool protocol baseline): https://modelcontextprotocol.io/specification/2025-06-18

R9. JSON-RPC 2.0 spec (for MCP transport framing semantics): https://www.jsonrpc.org/specification

## 11) Reference index (internal code + docs)

- `src/agents/claude-sdk-runner/create-session.ts`
- `src/agents/claude-sdk-runner/event-adapter.ts`
- `src/agents/claude-sdk-runner/mcp-tool-server.ts`
- `src/agents/claude-sdk-runner/prepare-session.ts`
- `src/agents/claude-sdk-runner/error-mapping.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/auto-reply/reply/get-reply-run.ts`
- `docs/concepts/claude-sdk-runtime.md`

## 12) Execution checklist

- [x] A: robust resumed-thread stripping
- [x] B: media strategy migration with persisted references
- [x] C: Claude hook-context parity hardening
- [x] D: orphan + stale-resume safeguards
- [x] E: overflow retry/fail-fast policy
- [x] F: message lifecycle signals -> runtime decisions
- [x] G: metrics and diagnostics
- [x] integration and regression test pass
