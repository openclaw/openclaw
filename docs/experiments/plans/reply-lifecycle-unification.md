---
summary: "Plan for unifying preflight work, aborts, and restart behavior under one reply lifecycle"
read_when:
  - You are fixing stuck sessions, drain behavior, or inconsistent /new UX
  - You want the long-term architecture behind the current targeted bugfixes
title: "Reply Lifecycle Unification"
---

# Reply lifecycle unification

This page describes the end-state fix for a class of reply lifecycle bugs where OpenClaw treats preflight work, active runs, restarts, and user-visible reset notices as separate flows instead of one session operation.

This is an engineering plan, not committed product behavior. The current production fix path can stay smaller. The design here is the cleaner long-term model.

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

That operation should own:

- lifecycle state
- cancellation
- user-visible outcome
- phase transitions
- restart and drain semantics

## Desired model

Each accepted inbound turn creates a `SessionOperation`.

The operation is registered immediately and stays active across all phases:

1. `queued`
2. `preflight_compacting`
3. `memory_flushing`
4. `running`
5. `completed` or `failed` or `aborted`

The operation owns one `AbortController` and one externally visible identity for the session. `/stop`, restart, and queue clear behavior all target that same operation.

## Exact placement

The `SessionOperation` abstraction should live in the auto-reply reply orchestration layer, not in the embedded runner and not in the generic command queue.

Recommended module:

- `src/auto-reply/reply/reply-operation.ts`

Recommended owners:

- `src/auto-reply/reply/get-reply-run.ts`
  Creates the operation before any eager reset UX or run admission side effects.
- `src/auto-reply/reply/agent-runner.ts`
  Advances the operation through phases and owns high-level orchestration.
- `src/auto-reply/reply/agent-runner-memory.ts`
  Runs preflight compaction and memory flush under the operation abort signal.
- `src/auto-reply/reply/agent-runner-execution.ts`
  Maps typed lifecycle failures to user-facing replies.

Supporting infrastructure should stay thin:

- `src/agents/pi-embedded-runner/runs.ts`
  Remains the shared active-run registry and abort primitive. It can store phase metadata or temporary handles, but it should not become the primary reply orchestrator.
- `src/process/command-queue.ts`
  Remains a generic queue and drain primitive. It may expose tiny helpers such as `isGatewayDraining()` or `isGatewayDrainingError()`, but it should not own session UX or reply lifecycle policy.

## Exact ownership boundaries

The split should be:

- auto-reply owns session operation lifecycle
- embedded runner owns model execution and active-run registration primitives
- command queue owns admission and drain mechanics

That means:

- auto-reply decides when a reply operation starts
- auto-reply decides which phase is active
- auto-reply decides which user-visible message corresponds to each lifecycle outcome
- embedded runner does not learn about `/new` UX semantics
- command queue does not learn about session reset semantics

## What should not move

Do not put the new abstraction in:

- `src/agents/pi-embedded-runner/run/attempt.ts`
  That would couple preflight auto-reply policy to the embedded runtime boundary.
- `src/process/command-queue.ts`
  That would leak reply-specific lifecycle policy into generic infrastructure.
- `src/auto-reply/reply/session.ts`
  That file is about persisted session state, not live in-flight operations.

## Concrete shape

The operation object should be small and explicit.

Suggested responsibilities:

- `sessionId`
- `sessionKey`
- `phase`
- `abortController`
- `registerActiveHandle()`
- `replaceWithEmbeddedRunHandle()`
- `complete()`
- `fail(code)`
- `abort(reason)`

Suggested phase union:

- `queued`
- `preflight_compacting`
- `memory_flushing`
- `running`
- `completed`
- `failed`
- `aborted`

Suggested failure code union:

- `gateway_draining`
- `lane_cleared`
- `aborted_by_user`
- `session_corruption_reset`
- `generic_run_failure`

## What changes

### 1. Register the operation before preflight work

Preflight compaction and memory flush should not run outside the active-run registry.

Instead:

- create the operation before preflight work starts
- register it as the active handler for the session immediately
- mark the phase as `preflight_compacting` or `memory_flushing`
- pass the operation abort signal into those phases
- clear the operation only after the full turn exits

This removes the window where session work exists but `/stop` cannot see it.

### 2. Make every phase abortable through one handle

All long-running phases should honor the same abort signal:

- queue wait
- preflight compaction
- memory flush
- main model run
- post-run cleanup that must be cancel-safe

The system should not need special-case abort code for “real run” versus “preflight work”. If the operation is active, it is abortable.

### 3. Move user-visible reset success to the operation outcome

`/new` should not send a success-style notice just because session state was reset locally.

Instead:

- if the new session turn is accepted and reaches reply execution, the response path may include the reset UX
- if the gateway is draining or the turn is rejected before execution, the user should receive a restart-specific failure, not `✅ New session started`

This ties user-facing status to admitted work, not optimistic local state changes.

### 4. Surface lifecycle-specific failures

External chat should distinguish lifecycle failures from generic model failures.

Examples:

- gateway draining or restarting
- command lane cleared during restart
- operation aborted by `/stop`
- operation reset due to session corruption

These are not “something went wrong” cases. They are known lifecycle outcomes and should be presented as such.

## Why this fixes the current bugs

### Stuck large-session compaction

The bug happens because preflight compaction begins before the session is visible as an active run. Under the unified model, compaction is already part of the active session operation, so `/stop` cancels the same operation that owns compaction.

### Misleading `/new` during restart or drain

The bug happens because reset UX is emitted before admission and execution outcome are known. Under the unified model, `/new` success UX is emitted only from the accepted operation path, while drain rejection returns a restart-specific lifecycle reply.

## Non-goals

This plan does not require:

- changing user-facing `/new` semantics beyond tying success notices to accepted work
- redesigning queue strategy for all channels
- rewriting the embedded runner or compaction engine
- changing session storage format as a prerequisite

## Incremental delivery plan

This architecture can be reached in stages.

### Stage 1

Land the narrow bugfixes:

- make preflight compaction abortable through the existing active-run path
- return a restart-specific external-chat message for drain rejection
- suppress eager reset success notices while draining

This fixes the current user-visible bugs with low risk.

### Stage 2

Introduce an internal session operation wrapper around:

- preflight compaction
- memory flush
- main run

This can initially be a thin orchestration layer that reuses existing run registry and abort semantics.

The preferred implementation path is:

1. add `reply-operation.ts` in `src/auto-reply/reply`
2. create the operation in `get-reply-run.ts` before eager reset notice logic
3. thread the operation through `agent-runner.ts`
4. run preflight compaction and memory flush under `operation.abortSignal`
5. register a temporary active handle in `runs.ts` immediately
6. replace that temporary handle with the real embedded run handle when model execution starts
7. emit lifecycle-specific user-facing outcomes from operation result codes

### Stage 3

Move lifecycle-specific user-visible replies onto operation outcomes instead of early side effects.

At that point:

- `/new` success UX is outcome-driven
- drain and restart replies are typed lifecycle results
- `/stop` has one target across all phases

## Tradeoffs

### Benefits

- one control surface for `/stop`, restart, and queue lifecycle
- fewer phase-specific exceptions
- better user-visible messaging
- easier reasoning about session state

### Costs

- reply runner control flow becomes more explicit and stateful
- tests need to cover operation phases, not just final run behavior
- temporary overlap may exist while old and new lifecycle hooks coexist

## Recommended implementation shape

Prefer a small internal `SessionOperation` abstraction owned by auto-reply rather than adding more special-case flags to the existing embedded-run registry.

The registry can remain the backing mechanism for “is active / abort / wait”, but the reply runner should become phase-aware and operation-driven.

Best design summary:

- `SessionOperation` lives in `src/auto-reply/reply`
- `runs.ts` stays a registry, not the orchestrator
- `command-queue.ts` stays generic infrastructure
- user-visible `/new` and restart behavior is derived from operation outcomes, not eager side effects

That keeps the production bugfix path small while still pointing toward a coherent long-term architecture.
