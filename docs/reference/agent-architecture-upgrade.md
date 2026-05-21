# Agent Architecture Upgrade — Audit & Implementation Report

**Date:** 2026-05-18
**Branch:** `feat/agent-architecture-discipline`
**Reference doc:** `OpenClaw_学习_Claude_Code_Agent_架构能力指令`
**Claude Code ref:** `/Users/sean/Desktop/claw-code-main/rust/crates/runtime/`

---

## 1. Existing Capability Map

| Area                          | File(s)                                                                                | What exists                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent main loop**           | `src/agents/pi-embedded-runner/run.ts`                                                 | `while(true)` retry loop with auth rotation, rate-limit fallback, compaction trigger. `MAX_RUN_LOOP_ITERATIONS` enforced.                         |
| **Provider bridge**           | `src/agents/harness/selection.ts`, `run/backend.ts`                                    | `AgentHarness` abstraction; plugin harnesses selected at runtime; fallback chain to PI.                                                           |
| **Tool registration**         | `src/agents/pi-embedded-runner/tool-schema-runtime.ts`, `effective-tool-policy.ts`     | Tools provisioned per-attempt; allowlist/denylist applied; schema built from manifests.                                                           |
| **Tool result handling**      | `src/agents/pi-embedded-subscribe.handlers.tools.ts`, `pi-embedded-subscribe.tools.ts` | Event-driven pipeline: start tracking → extract text/media → detect errors → sanitize → truncate → emit hooks. Error text truncated to 400 chars. |
| **Tool error classification** | `src/agents/failover-error.ts`, `run/failover-policy.ts`                               | Provider-level errors classified (auth, rate-limit, billing, timeout, overflow). Tool-level errors are NOT structured — raw text only.            |
| **Subagent routing**          | `src/agents/subagent-spawn.ts`, `subagent-registry.ts`                                 | Full subagent spawn with session forking, depth limits (default 100), `context: inherit/fork/isolated`, gateway lane dispatch.                    |
| **Prompt construction**       | `src/agents/system-prompt.ts`, `attempt-system-prompt.ts`                              | Hierarchical sections (identity → bootstrap → workspace → structured contributions → dynamic). LRU prompt cache (64 entries).                     |
| **Context compaction**        | `src/agents/pi-embedded-runner/compact.ts`, `compact-reasons.ts`                       | Hook-driven; context engine delegation; post-compaction loop guard; lifecycle hooks (before/after). No structured field preservation requirement. |
| **Memory handling**           | `src/plugins/memory-state.ts`, `src/memory/root-memory-files.ts`                       | Plugin hook registry (`before_compaction`/`after_compaction`); agent workspace files; no write-judgment decision layer.                           |
| **Tool loop guard**           | `post-compaction-loop-guard.ts`                                                        | Detects `PostCompactionLoopPersistedError` to break tool loops after compaction.                                                                  |

---

## 2. Gaps Found (vs. Doc Goals)

### Gap 1: Tool result format is unstructured

**Doc goal:** `{ok, summary, data, sources, next_hint}` / `{ok:false, error:{code, message, retryable}, partial_data, next_hint}`
**Current state:** Tool results are raw text (or truncated text). No structured envelope. No `next_hint`. No `sources` provenance. No `retryable` flag at tool level.

### Gap 2: Tool failure error code taxonomy missing

**Doc goal:** Five error categories: `temporary`, `input_error`, `permission_or_auth`, `not_found`, `tool_bug`.
**Current state:** Provider-level retry reasons exist, but individual tool call failures don't carry a typed code. The model receives raw error text — it cannot determine retryability structurally.

### Gap 3: Task status tracking is absent

**Doc goal:** Lightweight `{task_id, goal, status, completed_steps, pending_steps, blockers, sources}` state that survives compaction.
**Current state:** No first-class task state object. Agent state is implicit in the conversation transcript.

### Gap 4: Compaction summary has no required field contract

**Doc goal:** Compact output must preserve: user goal, current status, completed steps, tools called, key findings, sources, pending steps, blockers, next step, user constraints — in a `<summary>` XML block.
**Current state:** `compact.ts` delegates to the context engine or PI's own summarization. No field contract enforced.

### Gap 5: Memory write judgment is absent

**Doc goal:** At task end, agent should ask: "Did I produce a reusable workflow? A user preference? A pending follow-up? A project state change?" Only write if yes.
**Current state:** Memory writes happen via plugin hooks and prompt instructions, with no explicit decision gate in core.

---

## 3. What Was NOT Changed

- Feishu channel, auth, permissions, and write capabilities: **untouched**.
- Gateway runtime: **untouched**.
- Existing tool registration pipeline: **untouched**.
- Existing compaction hook machinery: **untouched**.
- Existing subagent spawn/routing: **untouched**.
- Existing plugin hook system: **untouched**.

---

## 4. Files Added / Changed

Phases 1 and 2 are **additive** — new files only. Phases 3 and 4 also edit
existing runtime files, but only to attach optional fields and inject optional
metadata; no existing behavior or return values are altered.

| File                                  | Purpose                                                                                                                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/agent-tool-result.ts`     | `AgentToolResult` discriminated union type; `wrapToolOk`, `wrapToolError`, `classifyToolError`, `isRetryableErrorCode`, `serializeToolResult` helpers                                                          |
| `src/agents/agent-task-state.ts`      | `AgentTaskState` type; `createTaskState`, `startTask`, `advanceTaskStep`, `blockTask`, `unblockTask`, `completeTask`, `failTask`, `recordTaskOutputs`, `addTaskSources`, `isTaskTerminal`, `renderTaskSummary` |
| `src/agents/agent-compact-summary.ts` | `CompactSummaryFields` type; `buildCompactSummaryFromTask`, `formatCompactSummary`, `getCompactContinuationMessage`, `buildCompactContinuationFromTask`, `renderMidTaskProgressLine`                           |
| `src/agents/agent-memory-judgment.ts` | `MemoryJudgmentInput`, `MemoryJudgmentResult` types; `judgeMemoryWrite`, `buildMemoryEntry`                                                                                                                    |

### Test files added

| File                                       | Tests                                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/agent-tool-result.test.ts`     | 30 test cases covering: ok/error envelopes, error classification, retryability, JSON serialization, TS union narrowing                         |
| `src/agents/agent-task-state.test.ts`      | 24 test cases covering: create, start, advance, block/unblock, outputs, sources, complete, fail, terminal check, summary render                |
| `src/agents/agent-compact-summary.test.ts` | 17 test cases covering: summary field mapping, XML format, continuation message, progress line, zero-step guard                                |
| `src/agents/agent-memory-judgment.test.ts` | 18 test cases covering: sensitive guard, group context guard, explicit request, workflow/preference/follow-up signals, combined judgment+entry |

**Total: 70 test cases**

---

## 5. Phase 2 — Runtime Integration Bridge (2026-05-18)

### What was added

| File                                          | Purpose                                                                                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/agent-tool-result-bridge.ts`      | Pure bridge helper: converts pre-extracted tool result fields (already available in `handleToolExecutionEnd`) into an `AgentToolResult` envelope without importing any heavy runtime modules |
| `src/agents/agent-tool-result-bridge.test.ts` | 15 test cases covering all error codes, fallback message synthesis, timeout precedence, summary truncation, summaryHint override, whitespace stripping                                       |

### Design decision

The bridge accepts **pre-extracted scalar values** rather than raw result objects:

```ts
type ToolResultBridgeInput = {
  toolName: string;
  isToolError: boolean; // from: isError || isToolResultError(sanitizedResult)
  isTimedOut: boolean; // from: isToolResultTimedOut(sanitizedResult)
  errorMessage: string | undefined; // from: extractToolErrorMessage(sanitizedResult)
  outputText: string | undefined; // from: extractToolResultText(sanitizedResult)
  summaryHint?: string;
};
```

This keeps the bridge import-free from `pi-embedded-subscribe.tools.ts` (which has heavy
channel/plugin runtime deps) while still integrating cleanly. The handler already has all
these values as local variables in scope — see `handleToolExecutionEnd` around line 920–936.

### Safe next wiring step

To wire into the hook payload (without touching existing behavior), add this block just before
the `after_tool_call` hook fires in `pi-embedded-subscribe.handlers.tools.ts` (~line 1260):

```ts
// Build structured envelope for hook consumers (additive — does not change raw delivery).
import { buildToolResultEnvelope } from "./agent-tool-result-bridge.js";

const structuredResult = buildToolResultEnvelope({
  toolName,
  isToolError,
  isTimedOut: isToolResultTimedOut(sanitizedResult),
  errorMessage: isToolError ? extractToolErrorMessage(sanitizedResult) : undefined,
  outputText: extractToolResultText(sanitizedResult),
});
// Pass structuredResult into hookEvent or telemetry as an optional field.
```

This is additive — the `structuredResult` can be attached to hook events as an optional field
without breaking existing consumers that ignore unknown fields.

---

## 6. Phase 3 — Minimal Safe Runtime Wiring (2026-05-18)

### Goal

Wire the Phase 2 bridge into the existing tool execution end path so that every
completed tool call produces a structured `AgentToolResult` envelope. The
envelope is attached to the `after_tool_call` hook event as an optional field —
fully additive, no change to user-visible output or existing runtime behavior.

### Files changed

| File                                                 | Change                                                                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/plugins/hook-types.ts`                          | Added `import type { AgentToolResult }` from agents; added optional `structuredResult?: AgentToolResult` field to `PluginHookAfterToolCallEvent`   |
| `src/agents/pi-embedded-subscribe.handlers.tools.ts` | Added `import { buildToolResultEnvelope }` from bridge; added 6-line call block just before `hookEvent` is constructed in `handleToolExecutionEnd` |
| `src/agents/agent-tool-result-wiring.test.ts`        | New — 25 tests covering the wiring contract: success path, error path, hook event shape, discriminated union narrowing, safety/no-throw            |

### How it works

In `handleToolExecutionEnd`, just before the `after_tool_call` hook fires,
the handler now calls:

```ts
const structuredResult = buildToolResultEnvelope({
  toolName,
  isToolError,
  isTimedOut: isToolResultTimedOut(sanitizedResult),
  errorMessage: isToolError ? extractToolErrorMessage(sanitizedResult) : undefined,
  outputText: extractToolResultText(sanitizedResult),
});
```

All five inputs are already local variables at that point — no new extraction
or parsing. The resulting `AgentToolResult` is added to `hookEvent.structuredResult`.

### What was NOT changed

- `PluginHookAfterToolCallEvent.result` (raw unstructured result) — untouched.
- `PluginHookAfterToolCallEvent.error` (raw error string) — untouched.
- All downstream hook consumers that ignore unknown fields — unaffected.
- Tool result text delivered to the model — unchanged.
- Session transcript / JSONL persistence — unchanged.
- All other hook types — unchanged.

### Cycle safety

`agent-tool-result.ts` has zero imports, so adding `import type { AgentToolResult }`
from `src/plugins/hook-types.ts` introduces no import cycle.

### Verification

```sh
node scripts/run-vitest.mjs \
  src/agents/agent-tool-result.test.ts \
  src/agents/agent-task-state.test.ts \
  src/agents/agent-compact-summary.test.ts \
  src/agents/agent-memory-judgment.test.ts \
  src/agents/agent-tool-result-bridge.test.ts \
  src/agents/agent-tool-result-wiring.test.ts
```

> **Phase 3 verification (2026-05-18):** 7 files, 144 tests passed.

---

## 7. Phase 4 — Model-Visible Structured Tool Result Integration (2026-05-18)

### Goal

Inject the `AgentToolResult` envelope into the `tool_result` content block that
the model receives, so it can read the structured summary, error code, and
retryability hint directly — not just the raw text.

### Design

A new module `agent-tool-result-model-output.ts` provides three pure helpers:

- `appendStructuredResultMetadata(text, envelope)` — appends a compact JSON
  block, delimited by `<oc_result_meta>…</oc_result_meta>` tags, after the
  existing output text. The original text is byte-for-byte unchanged.
- `extractStructuredResultFromText(text)` — round-trips the envelope back out.
  Returns `undefined` for text with no metadata block (backwards compat).
- `stripStructuredResultMetadata(text)` — removes the appended block, restoring
  the original text exactly.

All three helpers never throw.

### Files changed

| File                                                 | Change                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/agent-tool-result-model-output.ts`       | New — three pure helpers for metadata injection, extraction, and stripping                                                                                                                                                                                              |
| `src/agents/agent-tool-result-model-output.test.ts`  | New — 31 tests covering all helpers, round-trip, edge cases, safety                                                                                                                                                                                                     |
| `src/agents/pi-embedded-subscribe.handlers.tools.ts` | Moved `buildToolResultEnvelope` call before `emitToolResultOutput`; added `import { appendStructuredResultMetadata }`; added `structuredResult?` param to `emitToolResultOutput`; injected metadata via `appendStructuredResultMetadata` in the `shouldEmitOutput` path |

### How it works

In `handleToolExecutionEnd`, the envelope is now built **before** the call to
`emitToolResultOutput` (previously it was built inside the hook-only `if` block
after the call):

```ts
const structuredResult = buildToolResultEnvelope({
  toolName,
  isToolError,
  isTimedOut: isToolResultTimedOut(sanitizedResult),
  errorMessage: isToolError ? extractToolErrorMessage(sanitizedResult) : undefined,
  outputText: extractToolResultText(sanitizedResult),
});

await emitToolResultOutput({ ..., structuredResult });
```

Inside `emitToolResultOutput`, the output text the model sees becomes:

```ts
const modelOutputText = params.structuredResult
  ? appendStructuredResultMetadata(outputText, params.structuredResult)
  : outputText;
ctx.emitToolOutput(rawToolName, meta, modelOutputText, result);
```

The model now receives, for example:

```
file contents here
<oc_result_meta>{"ok":true,"summary":"first line of file","data":null,"sources":[]}</oc_result_meta>
```

### What was NOT changed

- `PluginHookAfterToolCallEvent.result` (raw unstructured result) — untouched.
- `PluginHookAfterToolCallEvent.error` (raw error string) — untouched.
- User-visible item events (title, status, summary) — untouched.
- `emitToolOutput`'s formatting logic in `pi-embedded-subscribe.ts` — untouched.
- Session transcript / JSONL persistence — untouched.
- Media / audio / approval result paths in `emitToolResultOutput` — untouched.
- All other hook types — untouched.

### Special output paths excluded from metadata annotation

`appendStructuredResultMetadata` is **not** called for outputs where exact text
semantics are required by downstream consumers:

- **Media paths** (`hasStructuredMedia = true`): tool outputs that carry
  `details.media` (TTS, image_generate, video_generate, browser screenshot, etc.).
  The text here is a caption/overlay for the associated media; appending tags
  would corrupt media path parsing in the channel layer.
- **Provider inventory paths** (`details.providers` is an array): structured
  meta-query results from `image_generate`/`video_generate` when listing
  available models. The model compares these verbatim for planning; annotation
  would break those comparisons.

Both paths still go through `emitToolOutput` and reach the model — they just do
not carry the `<oc_result_meta>` block. The `limitWarning` (Phase 8) is still
appended for these paths when the per-turn guard fires.

### Backwards compatibility

- `extractStructuredResultFromText` returns `undefined` for any text that
  predates Phase 4 (no metadata block present). No crash, no false parse.
- `appendStructuredResultMetadata` is called only from `emitToolResultOutput`;
  callers that bypass that path (approval-pending, media-only paths) are
  unaffected.
- The delimiter tags (`<oc_result_meta>`) are chosen to be visually distinct and
  unlikely to appear in real tool output.

### Verification

```sh
node scripts/run-vitest.mjs \
  src/agents/agent-tool-result.test.ts \
  src/agents/agent-task-state.test.ts \
  src/agents/agent-compact-summary.test.ts \
  src/agents/agent-memory-judgment.test.ts \
  src/agents/agent-tool-result-bridge.test.ts \
  src/agents/agent-tool-result-wiring.test.ts \
  src/agents/agent-tool-result-model-output.test.ts
```

> **Phase 4 verification (2026-05-18):** 9 files, 206 tests passed.

---

## 8. Phase 5 — AgentTaskState Wired into Subagent Spawn (2026-05-18)

### Goal

Wire `AgentTaskState` into the subagent spawn boundary so that callers can pass
a pre-created task state when calling `spawnSubagentDirect`. The spawn transitions
the task to "running" and injects a compact summary into the child system prompt.
On return, the started task state is available for callers to advance or fail via
`mergeSubagentResultIntoTask` / `completeTaskAfterSubagent`.

### Design

A new pure module `agent-subagent-task-bridge.ts` owns the three spawn-boundary
moments:

| Moment          | Helper                                      | What it does                                                                              |
| --------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Pre-spawn       | `startTaskForSubagentSpawn(task)`           | Transitions to "running"; no side effects                                                 |
| Pre-spawn       | `buildTaskContextForChildPrompt(task)`      | Builds the `## Parent Task Context\n…` block for injection                                |
| Post-spawn      | `mergeSubagentResultIntoTask(task, result)` | `accepted` → advance step + record runId/childSessionKey; `error`/`forbidden` → fail task |
| Post-completion | `completeTaskAfterSubagent(task)`           | Alias for `completeTask`; single import point for full lifecycle                          |

`SpawnSubagentResult.taskStateAtDispatch` is the started task state returned when
`params.taskState` is provided. Callers persist this and call the merge helpers when
the subagent completes. The gateway-level delivery of the completion result is
unchanged; no new runtime callbacks are added.

### Files changed

| File                                            | Change                                                                                                                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/agent-subagent-task-bridge.ts`      | New — four pure helpers for spawn-boundary task lifecycle                                                                                                                                                  |
| `src/agents/agent-subagent-task-bridge.test.ts` | New — 23 tests covering all helpers, full lifecycle, and immutability                                                                                                                                      |
| `src/agents/subagent-spawn.ts`                  | Added `taskState?: AgentTaskState` to `SpawnSubagentParams`; added `taskStateAtDispatch?: AgentTaskState` to `SpawnSubagentResult`; wired injection block after attachment suffix in `spawnSubagentDirect` |
| `src/agents/subagent-spawn.task-state.test.ts`  | New — 11 integration tests covering backcompat, propagation, caller merge workflow                                                                                                                         |

### How it works

In `spawnSubagentDirect`, after attachment suffix is applied to `childSystemPrompt`
and before the gateway call, the following block runs:

```ts
// Phase 5: inject parent task context into child system prompt.
let taskStateAtDispatch: AgentTaskState | undefined;
if (params.taskState) {
  taskStateAtDispatch = startTaskForSubagentSpawn(params.taskState);
  childSystemPrompt = `${childSystemPrompt}\n\n${buildTaskContextForChildPrompt(taskStateAtDispatch)}`;
}
```

The accepted return now conditionally includes:

```ts
...(taskStateAtDispatch ? { taskStateAtDispatch } : {}),
```

Callers then run:

```ts
// After spawn:
const merged = mergeSubagentResultIntoTask(result.taskStateAtDispatch, {
  status: result.status,
  runId: result.runId,
  childSessionKey: result.childSessionKey,
});

// After subagent replies:
const done = completeTaskAfterSubagent(merged);
```

### What was NOT changed

- `spawnSubagentDirect` return for any path without `params.taskState` — identical.
- Gateway call parameters — unchanged.
- `registerSubagentRun` record — unchanged.
- Hook events (`subagent_spawning`, `subagent_spawned`, `subagent_ended`) — unchanged.
- `SpawnSubagentContext` — unchanged.
- Any downstream consumer of `SpawnSubagentResult` that does not read `taskStateAtDispatch` — unaffected by the optional spread.

### Import cycle safety

`agent-subagent-task-bridge.ts` imports only from `agent-task-state.ts` (zero deps).
`subagent-spawn.ts` imports `AgentTaskState` (type-only) and two named functions from
the bridge — no new cycles introduced.

### Verification

```sh
node scripts/run-vitest.mjs \
  src/agents/agent-tool-result.test.ts \
  src/agents/agent-task-state.test.ts \
  src/agents/agent-compact-summary.test.ts \
  src/agents/agent-memory-judgment.test.ts \
  src/agents/agent-tool-result-bridge.test.ts \
  src/agents/agent-tool-result-wiring.test.ts \
  src/agents/agent-tool-result-model-output.test.ts \
  src/agents/agent-subagent-task-bridge.test.ts \
  src/agents/subagent-spawn.task-state.test.ts
```

> **Phase 5 verification (2026-05-18):** 11 files, 233 tests passed.

---

## 9. Phase 6 — Compaction Task Summary Integration (2026-05-18)

### Goal

Wire `formatCompactSummary` into the compaction lifecycle so that callers with an
`AgentTaskState` can inject a structured continuation prompt before the
`after_compaction` hook fires. Fully additive — no existing compaction behavior
changes when `taskState` is omitted.

### Design

A new pure module `agent-compaction-task-summary.ts` owns the conversion:

- `buildCompactionTaskSummary(task, extra?)` — builds the full continuation-prompt
  text (XML `<summary>` block + resume directive) from an `AgentTaskState`. Never
  throws; returns `""` on any internal error.
- `buildCompactionTaskSummaryIfPresent(taskState?, extra?)` — null-safe wrapper;
  returns `undefined` when no task state is provided (backcompat path).

`runAfterCompactionHooks` in `compaction-hooks.ts` now accepts two new optional params:

| Param               | Type                         | Purpose                                                                  |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| `taskState?`        | `AgentTaskState`             | When provided, summary is built before hooks fire                        |
| `taskSummaryExtra?` | `CompactionTaskSummaryExtra` | tools_used, key_findings, next_step, user_constraints, hasRecentMessages |

Before the internal `session:compact:after` hook event fires, the summary is built
and included as `compactionTaskSummary` in the hook event `context` payload. Plugin
consumers that inspect hook context can read it directly.

`runAfterCompactionHooks` now returns `AfterCompactionHooksResult`:

```ts
type AfterCompactionHooksResult = {
  compactionTaskSummary?: string; // present only when taskState was provided
};
```

The existing call site in `compact.ts` (line 1337) does not capture the return
value, so it is unaffected. Callers that want the summary can capture it:

```ts
const { compactionTaskSummary } = await runAfterCompactionHooks({ ..., taskState });
// use compactionTaskSummary in customInstructions or session injection
```

### Files changed

| File                                                | Change                                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/agent-compaction-task-summary.ts`       | New — two pure helpers: `buildCompactionTaskSummary`, `buildCompactionTaskSummaryIfPresent`                                                                                                                                                                                        |
| `src/agents/agent-compaction-task-summary.test.ts`  | New — 10 tests covering formatting, optional propagation, extra fields, backcompat/no task state, no-throw                                                                                                                                                                         |
| `src/agents/pi-embedded-runner/compaction-hooks.ts` | Added imports for `AgentTaskState` and bridge; new `AfterCompactionHooksResult` type; added `taskState?` / `taskSummaryExtra?` to `runAfterCompactionHooks`; summary built before hooks fire and included in hook event context; function now returns `AfterCompactionHooksResult` |

### What was NOT changed

- `compact.ts` — no changes; call site is backward compatible (return value ignored).
- All existing `runAfterCompactionHooks` callers — unaffected; new params are optional.
- Internal hook event structure (`context` is `Record<string, unknown>`) — additive field only.
- Plugin `after_compaction` hook payload — unchanged.
- Any session, transcript, or memory write behavior — unchanged.

### Import cycle safety

`agent-compaction-task-summary.ts` imports only from `agent-compact-summary.ts` and
`agent-task-state.ts` (both zero-dep). `compaction-hooks.ts` imports the two helpers
via a type-only import for `AgentTaskState` and a value import for `buildCompactionTaskSummaryIfPresent` — no new cycles.

### Verification

```sh
node scripts/run-vitest.mjs \
  src/agents/agent-tool-result.test.ts \
  src/agents/agent-task-state.test.ts \
  src/agents/agent-compact-summary.test.ts \
  src/agents/agent-memory-judgment.test.ts \
  src/agents/agent-tool-result-bridge.test.ts \
  src/agents/agent-tool-result-wiring.test.ts \
  src/agents/agent-tool-result-model-output.test.ts \
  src/agents/agent-subagent-task-bridge.test.ts \
  src/agents/subagent-spawn.task-state.test.ts \
  src/agents/agent-compaction-task-summary.test.ts
```

> **Phase 6 verification (2026-05-18):** 12 files, 243 tests passed.

---

## 10. Phase 7 — Post-Compaction Memory-Write Judgment Bridge (2026-05-18)

### Goal

Add a `judgeMemoryWrite` call inside `runPostCompactionSideEffects` so that
after compaction, memory signals are evaluated and a write decision is
returned to the caller. No file is written in this phase — the result is a
pure decision object for a future writer path to consume once a safe,
tested writer exists.

### Design

A new pure module `agent-compaction-memory-judgment.ts` owns the bridge:

- `buildPostCompactionMemoryJudgment({ taskState?, signals? })` — calls
  `judgeMemoryWrite` with the provided task state and optional signal flags.
  Returns `MemoryJudgmentResult | undefined` (undefined when no task state).
  Never throws.
- `PostCompactionMemorySignals` — the optional signal bag: `userRequestedMemory`,
  `hasReusableWorkflow`, `hasUserPreference`, `hasPendingFollowUp`,
  `hasProjectStateChange`, `involvesSensitiveData`, `isGroupContext`.

`runPostCompactionSideEffects` in `compaction-hooks.ts` gains two new optional
params and changes its return type from `Promise<void>` to
`Promise<PostCompactionSideEffectsResult>`:

| Param            | Type                          | Purpose                                   |
| ---------------- | ----------------------------- | ----------------------------------------- |
| `taskState?`     | `AgentTaskState`              | When present, memory judgment is computed |
| `memorySignals?` | `PostCompactionMemorySignals` | Optional signal overrides                 |

```ts
type PostCompactionSideEffectsResult = {
  memoryJudgment?: MemoryJudgmentResult;
};
```

`memoryJudgment` is `undefined` when no `taskState` is provided (backcompat).
When provided, it carries `write`, `type`, `reason`, and `suggested_entry?`.
The entry is NOT written to any file — callers receive it and decide.

### Why not write now

There is no existing tested writer path to `MEMORY.md` in the agent runner
layer. Writing directly from a compaction hook without one would be:

1. Hard to test (file I/O, workspace path resolution, concurrent sessions).
2. Unbounded (which workspace? which agent's MEMORY.md?).
3. Irreversible without explicit undo.

The pure bridge satisfies the architecture requirement (judgment happens at
compaction time) while leaving the write decision to a future caller that
owns the workspace path and can be tested end-to-end.

### Files changed

| File                                                  | Change                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/agents/agent-compaction-memory-judgment.ts`      | New — `buildPostCompactionMemoryJudgment`, `PostCompactionMemorySignals`                                                                                                                                                                                                                                                 |
| `src/agents/agent-compaction-memory-judgment.test.ts` | New — 28 tests covering no-task-state backcompat, no-signal write:false, all positive signal cases, safety guards, task variety, writer-path readiness                                                                                                                                                                   |
| `src/agents/pi-embedded-runner/compaction-hooks.ts`   | Added imports for bridge and `MemoryJudgmentResult`; new `PostCompactionSideEffectsResult` type; added optional `taskState?` / `memorySignals?` params to `runPostCompactionSideEffects`; changed return type to `Promise<PostCompactionSideEffectsResult>`; calls `buildPostCompactionMemoryJudgment` after memory sync |

### What was NOT changed

- Any file write to `MEMORY.md` or other workspace files — untouched.
- Existing `runPostCompactionSideEffects` callers — return type was `void`
  so existing callers that discard the result compile and run identically.
- `runAfterCompactionHooks` — untouched.
- `runBeforeCompactionHooks` — untouched.
- Session transcript emit and session memory sync — untouched.
- Plugin hook system — untouched.

### Import cycle safety

`agent-compaction-memory-judgment.ts` imports only from
`agent-memory-judgment.ts` and `agent-task-state.ts` (both zero-dep).
`compaction-hooks.ts` imports the bridge and `MemoryJudgmentResult`
(type-only) — no new cycles.

### Verification

```sh
node scripts/run-vitest.mjs \
  src/agents/agent-tool-result.test.ts \
  src/agents/agent-task-state.test.ts \
  src/agents/agent-compact-summary.test.ts \
  src/agents/agent-memory-judgment.test.ts \
  src/agents/agent-tool-result-bridge.test.ts \
  src/agents/agent-tool-result-wiring.test.ts \
  src/agents/agent-tool-result-model-output.test.ts \
  src/agents/agent-subagent-task-bridge.test.ts \
  src/agents/subagent-spawn.task-state.test.ts \
  src/agents/agent-compaction-task-summary.test.ts \
  src/agents/agent-compaction-memory-judgment.test.ts
```

> **Phase 7 verification (2026-05-18):** 13 files, 271 tests passed.

---

## 11. Phase 8 — Per-Turn Tool Call Limit Guard (2026-05-18)

### Goal

Add a soft, opt-in limit on the number of tool calls the model can make
in a single assistant turn. When the limit is reached, a structured warning
is injected into the model-visible `tool_result` block instructing the model
to stop calling tools, summarize what it has found, and respond to the user
or ask a clarifying question before continuing.

Default behavior is **unchanged** — the guard is disabled by default (`limit=0`).
No existing callsite is affected unless `maxToolCallsPerTurn` is explicitly set.

### Design

A new pure module `agent-tool-call-turn-guard.ts` owns the guard logic:

| Export                                                  | Purpose                                             |
| ------------------------------------------------------- | --------------------------------------------------- |
| `MAX_TOOL_CALLS_PER_TURN_DISABLED = 0`                  | Sentinel for "disabled" — used as default           |
| `MAX_TOOL_CALLS_PER_TURN_CONSERVATIVE = 25`             | Recommended opt-in limit                            |
| `isToolCallLimitExceeded(count, limit)`                 | Returns false when limit=0; true when count ≥ limit |
| `buildToolCallLimitWarning({ toolName, count, limit })` | Builds the model-visible warning string             |

### State and params wiring

- `EmbeddedPiSubscribeState.toolCallsThisTurn: number` — incremented in
  `handleToolExecutionEnd`; reset to `0` in `handleMessageStart` at the
  start of each assistant turn.
- `SubscribeEmbeddedPiSessionParams.maxToolCallsPerTurn?: number` — opt-in
  param; defaults to `0` (disabled) when omitted.
- Both types flow through `ToolHandlerState` (via `Pick`) and `ToolHandlerParams`
  (via `Pick`) so tool execution handlers can access them without importing
  the full subscribe context.

### Warning injection

When the limit is reached, `handleToolExecutionEnd` computes a `limitWarning`
string and passes it to `emitToolResultOutput`. Inside `emitToolResultOutput`,
the warning is appended after the existing tool output text, or emitted
standalone if the tool produced no output. The model-visible block becomes:

```
<actual tool output here>

[TOOL_LOOP_GUARD] Per-turn tool call limit reached: 25 of 25 calls used this turn (last: read).
You have called 25 tools in this turn. Please stop calling additional tools, summarize what you
have found so far, and either respond to the user or ask a clarifying question before continuing
with more tool calls.
```

The Phase 4 `<oc_result_meta>` structured metadata block (if present) is
appended after the warning, preserving the existing envelope order.

A `ctx.log.warn(...)` line is emitted for observability when the limit fires.

### What was NOT changed

- Default behavior for any caller that does not set `maxToolCallsPerTurn` — no change.
- Existing tool output text for callers under the limit — identical bytes.
- `tool_execution_start` / `tool_execution_update` events — untouched.
- Plugin hook events (`after_tool_call`) — untouched.
- Approval-pending / approval-unavailable paths in `emitToolResultOutput` — untouched.
- Media/audio paths in `emitToolResultOutput` — untouched.
- Any session transcript, compaction, or memory write — untouched.

### Files changed

| File                                                    | Change                                                                                                                                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/agent-tool-call-turn-guard.ts`              | New — pure guard helpers: `isToolCallLimitExceeded`, `buildToolCallLimitWarning`, exported constants                                                                                                  |
| `src/agents/agent-tool-call-turn-guard.test.ts`         | New — 30 tests covering constants, disabled, under/at/over limit, warning content, safety, per-turn reset, backcompat                                                                                 |
| `src/agents/pi-embedded-subscribe.handlers.types.ts`    | Added `toolCallsThisTurn: number` to `EmbeddedPiSubscribeState`; added `toolCallsThisTurn` to `ToolHandlerState` Pick; added `maxToolCallsPerTurn` to `ToolHandlerParams` Pick                        |
| `src/agents/pi-embedded-subscribe.types.ts`             | Added `maxToolCallsPerTurn?: number` to `SubscribeEmbeddedPiSessionParams`                                                                                                                            |
| `src/agents/pi-embedded-subscribe.handlers.messages.ts` | Reset `ctx.state.toolCallsThisTurn = 0` in `handleMessageStart`                                                                                                                                       |
| `src/agents/pi-embedded-subscribe.handlers.tools.ts`    | Imported guard helpers; incremented counter + computed `limitWarning` in `handleToolExecutionEnd`; added `limitWarning?` param to `emitToolResultOutput`; injected warning into annotated output text |

### Verification

```sh
node scripts/run-vitest.mjs \
  src/agents/agent-tool-result.test.ts \
  src/agents/agent-task-state.test.ts \
  src/agents/agent-compact-summary.test.ts \
  src/agents/agent-memory-judgment.test.ts \
  src/agents/agent-tool-result-bridge.test.ts \
  src/agents/agent-tool-result-wiring.test.ts \
  src/agents/agent-tool-result-model-output.test.ts \
  src/agents/agent-subagent-task-bridge.test.ts \
  src/agents/subagent-spawn.task-state.test.ts \
  src/agents/agent-compaction-task-summary.test.ts \
  src/agents/agent-compaction-memory-judgment.test.ts \
  src/agents/agent-tool-call-turn-guard.test.ts
```

> **Phase 8 verification (2026-05-18):** 14 files, 301 tests passed.

---

## 12. Phase 9 — Context Fragment Source Tagging (2026-05-18)

### Goal

Introduce a `ContextFragment` type with `source`, `type`, and `content` fields
so that prompt contributions can carry structured provenance metadata alongside
their rendered text. The new field on `ProviderSystemPromptContribution` is
**metadata-only** — the existing prompt assembly pipeline does not read it,
so omitting it produces byte-for-byte identical output to all previous phases.

### Design

A new pure module `agent-context-fragment.ts` owns the type and all helpers:

| Export                           | Purpose                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `ContextFragment`                | `{ source: string; type: "fact"\|"inference"\|"preference"; content: string }`   |
| `ContextFragmentType`            | Union of the three semantic labels                                               |
| `isContextFragment(v)`           | Structural validation; never throws                                              |
| `parseFragmentType(s)`           | Narrows a raw string to `ContextFragmentType \| undefined`; never throws         |
| `renderContextFragment(f)`       | `"<content> *(source: <s>, type: <t>)*"` — empty for empty content; never throws |
| `renderContextFragments(fs)`     | Joins all non-empty lines with `\n`; returns `""` for empty input; never throws  |
| `renderContextFragmentsSafe(fs)` | Returns `undefined` when nothing renders, so callers can use `??`; never throws  |

`ProviderSystemPromptContribution` gains an optional field:

```ts
contextFragments?: ContextFragment[];
```

This lets provider/plugin authors attach provenance-tagged fragments to their
contributions without rewriting any existing prompt assembly paths. A future
prompt builder can filter or render fragments selectively; the current assembler
ignores the field entirely, preserving full backwards compatibility.

### Files changed

| File                                        | Change                                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/agent-context-fragment.ts`      | New — `ContextFragment` type, `ContextFragmentType`, validation helpers, render helpers                                                            |
| `src/agents/agent-context-fragment.test.ts` | New — 57 tests covering type/validation, rendering, backcompat, no-throw safety                                                                    |
| `src/agents/system-prompt-contribution.ts`  | Added `import type { ContextFragment }` and re-export; added optional `contextFragments?: ContextFragment[]` to `ProviderSystemPromptContribution` |

### What was NOT changed

- `system-prompt.ts` prompt assembly — untouched; new field is metadata-only.
- `pi-embedded-runner/system-prompt.ts` — untouched.
- `gpt5-prompt-overlay.ts` — untouched.
- Existing `ProviderSystemPromptContribution` fields (`stablePrefix`, `dynamicSuffix`, `sectionOverrides`) — untouched.
- Any runtime, session, hook, compaction, or memory path — untouched.

### Import cycle safety

`agent-context-fragment.ts` has zero imports. `system-prompt-contribution.ts`
imports only a type from it — no new import cycles introduced anywhere.

### Verification

```sh
node scripts/run-vitest.mjs \
  src/agents/agent-tool-result.test.ts \
  src/agents/agent-task-state.test.ts \
  src/agents/agent-compact-summary.test.ts \
  src/agents/agent-memory-judgment.test.ts \
  src/agents/agent-tool-result-bridge.test.ts \
  src/agents/agent-tool-result-wiring.test.ts \
  src/agents/agent-tool-result-model-output.test.ts \
  src/agents/agent-subagent-task-bridge.test.ts \
  src/agents/subagent-spawn.task-state.test.ts \
  src/agents/agent-compaction-task-summary.test.ts \
  src/agents/agent-compaction-memory-judgment.test.ts \
  src/agents/agent-tool-call-turn-guard.test.ts \
  src/agents/agent-context-fragment.test.ts
```

> **Phase 9 verification (2026-05-18):** 15 files, 358 tests passed.

---

## 13. Phase 8 Regression Fix (2026-05-18)

Phase 8 focused verification exposed regressions in existing tests. This section
documents the two fixes applied.

### Fix 1 — Metadata annotation skipped for media/provider-inventory paths

**Root cause:** Phase 4's `appendStructuredResultMetadata` was called for ALL
`shouldEmitOutput` paths, including media tool outputs (`details.media`) and
provider inventory results (`details.providers`). Existing tests for these paths
expected the exact original output text.

**Fix:** Added `isSpecialOutputPath` guard in `emitToolResultOutput`:

```ts
const isSpecialOutputPath =
  hasStructuredMedia ||
  (Boolean(result) &&
    typeof result === "object" &&
    Boolean((result as { details?: unknown }).details) &&
    Array.isArray((result as { details?: { providers?: unknown } }).details?.providers));
const modelOutputText =
  params.structuredResult && outputText && !isSpecialOutputPath
    ? appendStructuredResultMetadata(annotatedOutputText, params.structuredResult)
    : annotatedOutputText;
```

The `limitWarning` (Phase 8) is still appended for special paths when the guard
fires. Only the `<oc_result_meta>` structured envelope is excluded.

### Fix 2 — Approval test updated to check `presentation` instead of `interactive`

**Root cause:** `buildExecApprovalPendingReplyPayload` was migrated to return
`presentation` (the current `ReplyPayload` field) rather than the deprecated
`interactive` field. The test helper `expectInteractiveApprovalButtons` still
checked `result["interactive"]`.

**Fix:** Updated the test helper path from `["interactive"]` to `["presentation"]`
in `pi-embedded-subscribe.handlers.tools.test.ts`.

### Files changed

| File                                                      | Change                                                                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/pi-embedded-subscribe.handlers.tools.ts`      | Added `isSpecialOutputPath` guard in `emitToolResultOutput`; skips metadata annotation for media paths and provider inventory paths |
| `src/agents/pi-embedded-subscribe.handlers.tools.test.ts` | Updated `expectInteractiveApprovalButtons` to check `result.presentation` instead of `result.interactive`                           |

### Verification

```sh
node scripts/run-vitest.mjs \
  src/agents/pi-embedded-subscribe.handlers.tools.test.ts \
  src/agents/pi-embedded-subscribe.handlers.tools.media.test.ts \
  src/agents/agent-tool-call-turn-guard.test.ts \
  src/agents/agent-tool-result.test.ts \
  src/agents/agent-task-state.test.ts \
  src/agents/agent-compact-summary.test.ts \
  src/agents/agent-memory-judgment.test.ts \
  src/agents/agent-tool-result-bridge.test.ts \
  src/agents/agent-tool-result-wiring.test.ts \
  src/agents/agent-tool-result-model-output.test.ts \
  src/agents/agent-subagent-task-bridge.test.ts \
  src/agents/subagent-spawn.task-state.test.ts \
  src/agents/agent-compaction-task-summary.test.ts \
  src/agents/agent-compaction-memory-judgment.test.ts
```

> **Phase 8 regression fix verification (2026-05-18):** 15 files, 423 tests passed.

---

## 14. Cumulative Test Suite

With the Codex worktree wrapper (all Phases 1–10):

```sh
node scripts/run-vitest.mjs \
  src/agents/agent-tool-result.test.ts \
  src/agents/agent-task-state.test.ts \
  src/agents/agent-compact-summary.test.ts \
  src/agents/agent-memory-judgment.test.ts \
  src/agents/agent-tool-result-bridge.test.ts \
  src/agents/agent-tool-result-wiring.test.ts \
  src/agents/agent-tool-result-model-output.test.ts \
  src/agents/agent-subagent-task-bridge.test.ts \
  src/agents/subagent-spawn.task-state.test.ts \
  src/agents/agent-compaction-task-summary.test.ts \
  src/agents/agent-compaction-memory-judgment.test.ts \
  src/agents/agent-tool-call-turn-guard.test.ts \
  src/agents/agent-context-fragment.test.ts \
  src/agents/agent-tool-result-next-hint.test.ts
```

> **Phase 1 verification (2026-05-18):** 4 files, 89 tests passed in full source checkout.
> **Phase 2 verification (2026-05-18):** 6 files, 119 tests passed.
> **Phase 3 verification (2026-05-18):** 7 files, 144 tests passed.
> **Phase 4 verification (2026-05-18):** 9 files, 206 tests passed.
> **Phase 5 verification (2026-05-18):** 11 files, 233 tests passed.
> **Phase 6 verification (2026-05-18):** 12 files, 243 tests passed.
> **Phase 7 verification (2026-05-18):** 13 files, 271 tests passed.
> **Phase 8 verification (2026-05-18):** 14 files, 301 tests passed.
> **Phase 9 verification (2026-05-18):** 15 files, 358 tests passed.
> **Phase 10 verification (2026-05-18):** 16 files, 386 tests passed.

---

## 15. Phase 10 — next_hint Inference for Common Tool Output Patterns (2026-05-18)

### Goal

Add contextual `next_hint` strings to `AgentToolResultOk` envelopes so the model
knows what to do after receiving a result — e.g., after a search it should fetch
the returned IDs; after a create it should use the returned token. The hint is
**metadata-only**: it does not change the user-visible output or any existing
behavior. Callers that do not read `next_hint` are unaffected.

### Design

A new pure module `agent-tool-result-next-hint.ts` owns the inference:

| Export                    | Purpose                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `inferNextHint(toolName)` | Returns a hint string or `undefined`; pattern-matches on tool name; never throws; zero imports |

Pattern categories:

| Tool name pattern                                                      | Inferred hint                                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `search`, `list`, `find`, `query`, `lookup`                            | "Use the returned IDs or tokens to fetch full record content with the corresponding get or read tool." |
| `create`, `insert`, `_new` suffix, `new_` prefix                       | "Use the returned ID or token to update, reference, or share this new resource."                       |
| Everything else (`read`, `get`, `exec`, `update`, `delete`, `send`, …) | `undefined` — no hint injected                                                                         |

`ToolResultBridgeInput` in `agent-tool-result-bridge.ts` gains an optional
`nextHint?: string` field:

- When provided: overrides the inferred hint. An empty string `""` suppresses
  any inferred hint without attaching a custom one.
- When omitted: `inferNextHint(toolName)` provides the default.

`buildToolResultEnvelope` passes the resolved hint to `wrapToolOk` as `next_hint`.
Error results are unaffected — no next_hint is added to `AgentToolResultError`.

### Files changed

| File                                             | Change                                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/agent-tool-result-next-hint.ts`      | New — `inferNextHint(toolName)` pure helper                                                                                                       |
| `src/agents/agent-tool-result-next-hint.test.ts` | New — 36 tests covering search/list hints, create hints, no-hint patterns, safety/no-throw, bridge integration, backcompat, and explicit override |
| `src/agents/agent-tool-result-bridge.ts`         | Added `import { inferNextHint }`; added `nextHint?` field to `ToolResultBridgeInput`; resolved hint passed to `wrapToolOk({ next_hint })`         |

### What was NOT changed

- `agent-tool-result.ts` — the `AgentToolResultOk.next_hint?` field already existed; no type changes needed.
- Any user-visible output text delivered to the model — unchanged.
- `PluginHookAfterToolCallEvent` — unchanged.
- Error envelopes (`AgentToolResultError`) — no next_hint added in this phase.
- All existing `buildToolResultEnvelope` call sites — `nextHint` is optional; existing callers compile and behave identically.
- Session transcript, compaction, memory write — untouched.

### Import cycle safety

`agent-tool-result-next-hint.ts` has zero imports. `agent-tool-result-bridge.ts`
imports only from `agent-tool-result.ts` and the new hint module — no new cycles.

### Verification

```sh
node scripts/run-vitest.mjs \
  src/agents/agent-tool-result.test.ts \
  src/agents/agent-task-state.test.ts \
  src/agents/agent-compact-summary.test.ts \
  src/agents/agent-memory-judgment.test.ts \
  src/agents/agent-tool-result-bridge.test.ts \
  src/agents/agent-tool-result-wiring.test.ts \
  src/agents/agent-tool-result-model-output.test.ts \
  src/agents/agent-subagent-task-bridge.test.ts \
  src/agents/subagent-spawn.task-state.test.ts \
  src/agents/agent-compaction-task-summary.test.ts \
  src/agents/agent-compaction-memory-judgment.test.ts \
  src/agents/agent-tool-call-turn-guard.test.ts \
  src/agents/agent-context-fragment.test.ts \
  src/agents/agent-tool-result-next-hint.test.ts
```

> **Phase 10 verification (2026-05-18):** 16 files, 386 tests passed.

---

## 16. Phase 11 — ToolSpec `output_schema` Metadata (2026-05-18)

### Goal

Add optional tool output schema metadata so descriptors can carry expected result
shapes for future IDE/lint/validation work, without changing runtime behavior.

### Files changed

| File                                          | Change                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/agents/tools/common.ts`                  | Added optional `outputSchema?: JsonObject` to `AgentToolWithMeta` and `AnyAgentTool`                |
| `src/tools/types.ts`                          | `ToolDescriptor.outputSchema?: JsonObject` is supported/confirmed                                   |
| `src/plugins/tool-descriptor-cache.ts`        | Captures valid object `tool.outputSchema` into descriptors; omits malformed values without throwing |
| `src/agents/agent-tool-output-schema.test.ts` | New tests for backcompat, pass-through, no-throw behavior, and plugin descriptor cache integration  |

### What was NOT changed

- No runtime output validation was added.
- Tools without `outputSchema` remain byte-for-byte descriptor-compatible.
- Malformed runtime values are ignored rather than surfaced as errors.
- Tool execution, model-visible output, hooks, Feishu permissions, credentials, and memory files are untouched.

### Verification

```sh
node scripts/test-projects.mjs   src/agents/agent-tool-output-schema.test.ts   src/plugins/tool-descriptor-cache.test.ts   src/agents/agent-tool-result-next-hint.test.ts   src/agents/agent-tool-result-bridge.test.ts
```

> **Phase 11 verification (2026-05-18):** 4 files, 77 tests passed.

---

## 17. Phase 12 — Heartbeat Task Progress Context (2026-05-18)

### Goal

Integrate `renderMidTaskProgressLine` into the heartbeat prompt boundary so a
long-running task can surface one compact progress line during heartbeat turns.
This is opt-in: when no task state is supplied, heartbeat behavior is unchanged.

### Design

A new pure helper module renders heartbeat task progress from an optional
`AgentTaskState`:

- `buildHeartbeatTaskProgressLine(taskState?)` wraps `renderMidTaskProgressLine` and never throws.
- `buildHeartbeatTaskProgressContext(taskState?)` returns a small `## Current Task Progress` context block or `undefined`.

`resolvePromptBuildHookResult` now accepts optional `heartbeatTaskState` and:

- passes it to `heartbeat_prompt_contribution` hook events as `taskState?`;
- appends the rendered progress context only when `hookCtx.trigger === "heartbeat"`;
- omits everything when no task state is supplied.

### Files changed

| File                                                          | Change                                                                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/agent-heartbeat-task-progress.ts`                 | New pure helper for heartbeat progress line/context rendering                                                              |
| `src/agents/agent-heartbeat-task-progress.test.ts`            | New tests for backcompat, rendering, and no-throw safety                                                                   |
| `src/agents/pi-embedded-runner/run/attempt.prompt-helpers.ts` | Optional `heartbeatTaskState`; passes `taskState?` to heartbeat hooks and appends progress context on heartbeat turns only |
| `src/agents/pi-embedded-runner/run/attempt.test.ts`           | Integration test for heartbeat-only progress context injection                                                             |
| `src/plugins/host-hook-turn-types.ts`                         | Optional `taskState?: AgentTaskState` on `PluginHeartbeatPromptContributionEvent`                                          |

### What was NOT changed

- Existing heartbeat runs with no task state produce no additional prompt text.
- Non-heartbeat turns ignore `heartbeatTaskState`.
- No current task persistence or memory writes were added.
- No credentials, Feishu permissions, running OpenClaw state, or workspace memory files were touched.

### Verification

```sh
node scripts/test-projects.mjs   src/agents/agent-heartbeat-task-progress.test.ts   src/agents/pi-embedded-runner/run/attempt.test.ts
```

> **Phase 12 verification (2026-05-18):** 2 files, 151 tests passed.

---

## 18. Learned From Claude Code

| Claude Code pattern                                               | What we learned                            | How we applied it                                                        |
| ----------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| `conversation.rs` — `while(true)` loop with `max_iterations`      | Tool call loop discipline, iteration limit | Already exists in OpenClaw. Documented in this report.                   |
| `conversation.rs` — `ToolError` struct with `Display`             | Typed error at tool call boundary          | `AgentToolErrorCode` enum + `wrapToolError`                              |
| `tools/src/lib.rs` — `ToolSpec {name, description, input_schema}` | Tool contract                              | Foundation for future `output_schema` + `next_hint` registration         |
| `compact.rs` — `CompactionResult {summary, formatted_summary}`    | Compaction output fields                   | `CompactSummaryFields` type with all required doc fields                 |
| `compact.rs` — `get_compact_continuation_message`                 | Resume message pattern                     | `getCompactContinuationMessage` with suppress-questions directive        |
| `session.rs` — session state across compaction                    | Task state survival                        | `AgentTaskState` serializable, renders to prompt via `renderTaskSummary` |

---

## 19. Recommended Next Work

### High priority (runtime integration)

1. ~~**Wire `AgentToolResult` into tool call pipeline**~~ — **Done in Phases 3 & 4.** The structured envelope is built in `handleToolExecutionEnd`, injected into the `tool_result` content block the model receives (Phase 4), and attached to `after_tool_call` hook events (Phase 3).

2. ~~**Wire `AgentTaskState` into subagent spawn**~~ — **Done in Phase 5.** `SpawnSubagentParams.taskState` propagates task context into the child prompt; `SpawnSubagentResult.taskStateAtDispatch` lets callers call `mergeSubagentResultIntoTask` / `completeTaskAfterSubagent` at completion.

3. ~~**Wire `formatCompactSummary` into compaction hooks**~~ — **Done in Phase 6.** `runAfterCompactionHooks` now accepts optional `taskState` + `taskSummaryExtra`; builds the formatted continuation prompt before hooks fire; includes it in the hook event context and returns it as `AfterCompactionHooksResult.compactionTaskSummary`.

4. ~~**Add `judgeMemoryWrite` call in `runPostCompactionSideEffects`**~~ — **Done in Phase 7.** `runPostCompactionSideEffects` now accepts optional `taskState` + `memorySignals`; calls `buildPostCompactionMemoryJudgment` after memory sync; returns `PostCompactionSideEffectsResult` with `memoryJudgment?`. No file write occurs — the decision is returned for a future writer path to consume.

### Medium priority (quality)

5. ~~**Add `max_tool_calls_per_turn` guard**~~ — **Done in Phase 8.** Soft limit in `pi-embedded-subscribe.handlers.tools.ts`; opt-in via `maxToolCallsPerTurn` on `SubscribeEmbeddedPiSessionParams`; disabled by default (`limit=0`); warning injected into model-visible tool result when exceeded.

6. ~~**Add `next_hint` to existing Lark/MCP tool outputs**~~ — **Done in Phase 10.** Generic `inferNextHint` helper pattern-matches tool names; bridge (`buildToolResultEnvelope`) attaches inferred hints to `AgentToolResultOk.next_hint` for search/list/create patterns; callers may override via `nextHint` param.

7. ~~**Source tagging for context fragments**~~ — **Done in Phase 9.** `ContextFragment` type added in `agent-context-fragment.ts`; optional `contextFragments?` field added to `ProviderSystemPromptContribution`; render helpers provided; prompt assembly pipeline unchanged (metadata-only field).

### Lower priority (tooling)

8. ~~**Add `output_schema` field to `ToolSpec`**~~ — **Done in Phase 11.** Tool descriptors now carry optional `outputSchema` metadata from tool definitions through the plugin descriptor cache; malformed values are ignored without throwing.

9. ~~**Integrate `renderMidTaskProgressLine` into heartbeat**~~ — **Done in Phase 12.** Heartbeat prompt build accepts optional `heartbeatTaskState`, passes it to heartbeat hooks, and appends a compact progress context only on heartbeat-triggered turns.

---

## 20. Architecture Notes

The five modules (four contract types + one bridge) are **pure TypeScript with no heavy runtime dependencies** — they can be imported by any layer (agent runner, compaction hooks, subagent spawn, memory plugin) without creating dependency cycles. They do not touch:

- Feishu channel code
- Gateway server methods
- Plugin SDK public API
- Auth profile management
- Existing session/compaction machinery

They should be considered a **contract layer** — the runtime integration work (items 1–4 above) will consume these types and helpers but live in the existing extension points.
