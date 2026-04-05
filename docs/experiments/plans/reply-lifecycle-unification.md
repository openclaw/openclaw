---
summary: "Plan for unifying preflight work, aborts, and restart behavior under one reply lifecycle"
read_when:
  - You are fixing stuck sessions, drain behavior, or inconsistent /new UX
  - You want the long-term architecture behind the reply lifecycle refactor
title: "Reply Lifecycle Unification"
---

# Reply lifecycle unification

This page describes the end-state fix for a class of reply lifecycle bugs where OpenClaw treats preflight work, active runs, restarts, and user-visible reset notices as separate flows instead of one session operation.

This is an engineering plan for the full refactor, not committed product behavior.

## Problem statement

Today, a single user reply can pass through multiple phases that do not share one lifecycle handle:

- queue admission
- preflight compaction
- memory flush
- model execution
- restart or drain rejection
- `/stop` and `/new` control messages

That split creates inconsistent control behavior:

- preflight compaction can run before the session is registered as an active run, so `/stop` cannot interrupt it
- `/new` can emit a success-style notice before the first turn is actually accepted
- restart and drain failures can be surfaced as generic run failures instead of lifecycle-specific replies

The immediate bugs are symptoms of the same design gap: there is no single abortable session operation covering the full reply path.

## Goal

Treat the entire reply path as one session operation from the moment work is admitted until it completes, fails, or is canceled.

This page is normative for the refactor. If the implementation diverges from this document, update the document in the same change or align the code to it.

The operation owns:

- lifecycle state
- cancellation
- user-visible outcome
- phase transitions
- restart and drain semantics

## Non-negotiable invariants

The refactor must satisfy all of the following:

- each reply-producing inbound turn creates exactly one `ReplyOperation`
- the operation is created before any eager reset-success notice or preflight work
- the operation is registered in the active-run registry immediately and stays registered until the turn reaches a terminal outcome
- `/stop` targets that same operation in every phase
- preflight compaction, memory flush, and main reply execution all run under the same operation-owned `AbortController`
- there is never a window where reply work exists for a session but `abortEmbeddedPiRun(sessionId)` cannot see it
- reply-producing `/new` and `/reset` turns never emit a standalone success notice before the turn is admitted and reaches the normal reply path
- restart and drain rejections are represented as typed lifecycle outcomes, not generic run failures

## Exact operation model

Each reply-producing inbound turn creates exactly one `ReplyOperation`.

`ReplyOperation` has exactly these phases:

- `queued`
- `preflight_compacting`
- `memory_flushing`
- `running`
- `completed`
- `failed`
- `aborted`

`ReplyOperation` owns exactly one `AbortController`, exactly one active-run registry entry, and exactly one terminal result.

`ReplyOperation` exposes exactly these failure codes:

- `gateway_draining`
- `command_lane_cleared`
- `aborted_by_user`
- `session_corruption_reset`
- `run_failed`

The exact result shape is:

```ts
type ReplyOperationPhase =
  | "queued"
  | "preflight_compacting"
  | "memory_flushing"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

type ReplyOperationFailureCode =
  | "gateway_draining"
  | "command_lane_cleared"
  | "aborted_by_user"
  | "session_corruption_reset"
  | "run_failed";

type ReplyOperationResult =
  | { kind: "completed" }
  | { kind: "failed"; code: ReplyOperationFailureCode; cause?: unknown }
  | { kind: "aborted"; code: "aborted_by_user" };
```

`reply-operation.ts` exports exactly one factory and exactly these operation members:

```ts
type ReplyOperation = {
  readonly sessionId: string;
  readonly sessionKey?: string;
  readonly abortSignal: AbortSignal;
  readonly resetTriggered: boolean;
  readonly phase: ReplyOperationPhase;
  readonly result: ReplyOperationResult | null;
  readonly registryHandle: EmbeddedPiQueueHandle;
  setPhase(next: "queued" | "preflight_compacting" | "memory_flushing" | "running"): void;
  attachEmbeddedHandle(handle: EmbeddedPiQueueHandle): void;
  detachEmbeddedHandle(handle: EmbeddedPiQueueHandle): void;
  complete(): void;
  fail(code: Exclude<ReplyOperationFailureCode, "aborted_by_user">, cause?: unknown): void;
  abortByUser(): void;
};
```

No second lifecycle object is introduced for reply turns.

## Exact placement

The new lifecycle abstraction lives in exactly one new module:

- `src/auto-reply/reply/reply-operation.ts`

No other module becomes a second lifecycle owner.

## Exact ownership boundaries

The split is fixed:

- `src/auto-reply/reply/get-reply-run.ts`
  Creates the `ReplyOperation` before any eager reset-success side effect and passes it through the full reply flow.
- `src/auto-reply/reply/agent-runner.ts`
  Advances the phase and owns the lifetime of the operation.
- `src/auto-reply/reply/agent-runner-memory.ts`
  Runs preflight compaction and memory flush under `operation.abortSignal` and updates the phase before invoking each phase.
- `src/auto-reply/reply/agent-runner-execution.ts`
  Converts thrown errors into `ReplyOperationFailureCode` and maps result codes to user-facing reply classes.
- `src/agents/pi-embedded-runner/runs.ts`
  Remains only the shared active-run registry and abort primitive.
- `src/process/command-queue.ts`
  Remains only queue and drain infrastructure.

The responsibility split is also fixed:

- auto-reply owns lifecycle state and user-visible outcome
- the embedded runner owns actual model execution
- the command queue owns generic lane mechanics only

## What will not move

The refactor will not put lifecycle ownership in:

- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/process/command-queue.ts`
- `src/auto-reply/reply/session.ts`

The embedded runner and command queue keep their generic responsibilities. They do not become reply-lifecycle coordinators.

## Exact registry design

`ReplyOperation` owns one stable registry handle for the entire lifetime of the turn.

That handle is created in `reply-operation.ts`, registered once through `setActiveEmbeddedRun(sessionId, handle, sessionKey)`, and cleared once when the operation reaches a terminal state.

`run/attempt.ts` does not become the registry owner for reply-driven turns. When a `ReplyOperation` is present, the embedded runner attaches its transient streaming handle to the already-registered operation handle instead of registering a second lifecycle in `runs.ts`.

The embedded-runner seam is fixed:

- `RunEmbeddedPiAgentParams` gains `replyOperation?: ReplyOperation`
- reply-driven calls from auto-reply pass that field through
- when `replyOperation` is present, `run/attempt.ts` calls `replyOperation.attachEmbeddedHandle(queueHandle)` when the transient runner handle becomes available
- when `replyOperation` is present, `run/attempt.ts` calls `replyOperation.detachEmbeddedHandle(queueHandle)` in its terminal cleanup path
- when `replyOperation` is present, `run/attempt.ts` does not call `setActiveEmbeddedRun()` or `clearActiveEmbeddedRun()` directly for that turn

The stable registry handle follows these exact rules:

- `queueMessage()` delegates to the attached embedded-run handle only when one is attached and the operation phase is `running`
- `isStreaming()` returns `true` only when an embedded-run handle is attached and actively streaming
- `isCompacting()` returns `true` in phases `preflight_compacting` and `memory_flushing`; during `running` it delegates to the attached embedded-run handle
- `abort()` aborts the operation-owned `AbortController` and also aborts the attached embedded-run handle when one is present

This design means `abortEmbeddedPiRun(sessionId)` always targets the same registry entry for the full turn.

## Exact queue behavior

The command queue is not getting a reply-specific API in this refactor.

Queue behavior is fixed as follows:

- `ReplyOperation` is created before queue admission and enters phase `queued`
- if queue admission rejects immediately with `GatewayDrainingError`, the operation fails with `gateway_draining`
- if the lane later rejects the task with `CommandLaneClearedError`, the operation fails with `command_lane_cleared`
- if `/stop` aborts the operation while it is still queued, the operation transitions to `aborted`, clears its registry handle immediately, and the queued closure becomes a no-op when it is eventually dequeued

The queue continues to be generic infrastructure. No reply-specific state or UX logic moves into `command-queue.ts`.

## What changes

### 1. Register the operation before preflight work

Preflight compaction and memory flush do not run outside the active-run registry.

The exact flow is:

- `get-reply-run.ts` creates `ReplyOperation`
- `ReplyOperation` registers its stable handle immediately
- `agent-runner.ts` moves the phase from `queued` to `preflight_compacting`
- `agent-runner-memory.ts` passes `operation.abortSignal` into preflight compaction
- if memory flush is needed, `agent-runner-memory.ts` moves the phase to `memory_flushing` before starting it
- before the main assistant turn begins, `agent-runner.ts` moves the phase to `running`
- only terminal completion clears the stable handle

There is no allowed preflight window outside the registry.

### 2. Use the same operation for preflight, memory flush, and main run

Every abortable phase uses `operation.abortSignal`.

That includes:

- preflight compaction
- memory flush
- main assistant run
- any cleanup in auto-reply that must not outlive the session operation

There is no phase-specific abort path for “real run” versus “preflight work”.

### 3. Remove eager reset-success notices from reply-producing turns

Reply-producing `/new` and `/reset` turns do not emit a standalone `✅ New session started ...` notice before execution.

The exact rule is:

- bare command-only `/new` and `/reset` acknowledgments are unchanged and are outside this refactor
- `/new` or `/reset` turns that also produce a reply do not call `sendResetSessionNotice()` before the reply operation runs
- any reset-specific UX for reply-producing turns is delivered only through the normal assistant reply path after the operation has been admitted

This removes optimistic success UI from turns that later fail admission or execution.

### 4. Use typed lifecycle outcomes

`agent-runner-execution.ts` maps errors to `ReplyOperationFailureCode` exactly as follows:

- `GatewayDrainingError` -> `gateway_draining`
- `CommandLaneClearedError` -> `command_lane_cleared`
- user-triggered operation abort -> `aborted_by_user`
- session corruption reset path -> `session_corruption_reset`
- everything else -> `run_failed`

User-visible mapping is fixed as follows:

- `gateway_draining` and `command_lane_cleared` map to the restart-specific external reply class
- `aborted_by_user` does not produce a generic assistant failure reply
- `session_corruption_reset` does not fall through the generic failure text
- only `run_failed` uses the generic assistant failure path

## Why this fixes the current bugs

### Stuck large-session compaction

The bug happens because preflight compaction begins before the session is visible as an active run. Under this design, the operation registers its stable handle before preflight starts, so `/stop` hits the same operation that owns compaction.

### Misleading `/new` during restart or drain

The bug happens because reset UX is emitted before admission and execution outcome are known. Under this design, reply-producing `/new` does not emit a standalone success notice before the operation runs, and drain rejection returns the restart-specific lifecycle reply class instead of the generic failure.

## Non-goals

This refactor does not do any of the following:

- redesign the generic command queue
- introduce a second active-run registry
- rewrite the embedded runner or compaction engine
- change session storage format
- define final copy for every user-visible string; this plan fixes outcome classes and ownership, not wording

## Implementation plan

This is implemented in one coherent refactor.

The implementation order is fixed:

1. add `reply-operation.ts` in `src/auto-reply/reply`
2. create the operation in `get-reply-run.ts` before any eager reset-success side effect
3. register the stable operation handle immediately
4. thread the operation through `agent-runner.ts`, `agent-runner-memory.ts`, and `agent-runner-execution.ts`
5. pass `operation.abortSignal` into preflight compaction and memory flush
6. add `replyOperation?: ReplyOperation` to `RunEmbeddedPiAgentParams` and thread it through reply-driven embedded-runner calls
7. update `run/attempt.ts` so reply-driven turns attach transient streaming handles to the existing operation handle instead of registering a second lifecycle
8. remove eager `sendResetSessionNotice()` from reply-producing `/new` and `/reset` turns
9. normalize drain, lane-clear, abort, reset-corruption, and generic-run failures into `ReplyOperationFailureCode`
10. map lifecycle result codes to the correct reply class in `agent-runner-execution.ts`
11. keep bare command-only `/new` and `/reset` acknowledgments unchanged

The refactor is not done until all of the following are true:

- `/stop` aborts the same operation during `queued`, `preflight_compacting`, `memory_flushing`, and `running`
- `abortEmbeddedPiRun(sessionId)` never returns `no_active_run` for a turn that is already inside the reply lifecycle
- reply-producing `/new` does not emit a standalone success notice before execution
- drain and lane-clear failures do not use the generic external failure message
- only one stable registry handle exists per reply turn
- the registry handle is registered once and cleared once

## Tradeoffs

### Benefits

- one control surface for `/stop`, restart, and queue lifecycle
- fewer phase-specific exceptions
- better user-visible messaging
- easier reasoning about session state

### Costs

- reply runner control flow becomes more explicit and stateful
- tests need to cover phase transitions and stable-handle behavior
- `run/attempt.ts` needs a new attach/detach seam for reply-driven turns

## Exact implementation shape

The implementation uses a small internal `ReplyOperation` abstraction owned by auto-reply and backed by the existing `runs.ts` registry.

The registry remains the single source of truth for “is active / abort / wait”, but auto-reply becomes the single source of truth for reply lifecycle phase and terminal outcome.

The architecture is locked to these decisions:

- `ReplyOperation` lives in `src/auto-reply/reply`
- `runs.ts` stays a registry, not the orchestrator
- `command-queue.ts` stays generic infrastructure
- user-visible `/new` and restart behavior is derived from operation outcomes, not eager side effects
