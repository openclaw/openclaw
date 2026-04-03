# Long-Running Task Visibility Technical Design

## Overview

This document defines the phase-1 technical contract for long-running task
visibility.

The companion product/design document lives in:

- `docs/design/long-running-task-visibility.md`

The rollout and implementation sequencing note lives in:

- `docs/experiments/plans/long-running-task-visibility-rollout.md`

This technical note focuses on:

- where first-visible timing is measured
- which runtime seams own the behavior
- which outcome signals are added first
- what is intentionally deferred

The delivery layer also needs a first-class visible-delivery taxonomy. Even
before watchdog-triggered status sends are enabled, the reply dispatcher should
model `status` as a distinct visible kind rather than overloading `block` or
`final`.

## Context

The current runtime already has a conversation presentation seam:

- supervisor planning decides whether `status` or `milestone` is semantically
  allowed
- runtime scheduling decides whether those planned items are actually emitted
- channel delivery decides how they are rendered

This means long-running visibility should not create a parallel presentation
stack. It should reuse the existing supervisor and runtime delivery seams.

## Core Runtime Contract

Phase 1 introduces one explicit runtime concern:

- `first visible output`

For now, this is treated as a measurement and lifecycle signal, not a new
user-visible feature.

The contract is:

1. A turn may have a candidate first-visible signal.
2. That candidate is currently one of:
   - `status`
   - `milestone`
3. If the candidate is actually emitted, the runtime records when it happened.
4. If the turn completes before the candidate ever starts, the runtime records
   a fast-complete skip.

Phase 1 does **not** yet treat final reply delivery as a first-visible source.
That needs integration at the reply dispatch layer, not only inside
`get-reply-run`.

## Scope Boundaries

### In scope for phase 1

- add first-visible outcome signals
- record the earliest planned visibility kind
- record whether that planned signal actually emitted
- record whether it was skipped because the turn completed too quickly

### Explicitly out of scope for phase 1

- changing user-visible behavior
- adding a watchdog timer
- forcing `ack` emission
- measuring actual final-message visibility across all channels
- changing Feishu card streaming behavior

## Runtime Ownership

### Supervisor planner

Owned by:

- `src/auto-reply/reply/supervisor/presentation.ts`

Responsibilities:

- semantic eligibility
- presentation kind selection
- template/model mode selection

Not responsible for:

- watchdog timing
- first-visible timing enforcement
- final channel delivery timing

### Turn runtime

Owned by:

- `src/auto-reply/reply/get-reply-run.ts`

Responsibilities:

- start first-visible measurement for the turn
- identify the earliest candidate kind from the existing presentation plan
- record `first_visible_scheduled`
- record `first_visible_emitted`
- record `first_visible_skipped_fast_complete`

### Channel delivery

Examples:

- Feishu reply dispatcher
- channel-specific streaming implementations

Deferred responsibility:

- reporting when the final user-visible reply actually became visible

This is deferred because `get-reply-run.ts` can observe planning and scheduled
intermediate output, but it does not own all final delivery paths.

## Phase-1 Outcome Signals

The first increment adds:

- `first_visible_scheduled`
- `first_visible_emitted`
- `first_visible_skipped_fast_complete`

### `first_visible_scheduled`

Meaning:

- the runtime identified the earliest planned visibility candidate for this
  turn

Payload:

- `kind`

Notes:

- this is currently derived from the existing presentation plan and runtime
  scheduling posture
- it is not proof that anything became visible yet

### `first_visible_emitted`

Meaning:

- the earliest actually emitted intermediate visibility signal became visible

Payload:

- `kind`
- `dispatch_to_first_visible_ms`
- optional `templateId`
- optional `messageId`

Notes:

- phase 1 only emits this for successful intermediate visibility sends
- final reply visibility is deferred to a later phase

### `first_visible_skipped_fast_complete`

Meaning:

- a first-visible candidate existed, but the run completed before that
  candidate ever began sending

Payload:

- `kind`
- `dispatch_to_completion_ms`

Notes:

- this gives a clean explanation for "no early output happened because the turn
  completed quickly"

## Candidate Selection Rules

Phase 1 keeps candidate selection simple:

1. If runtime-scheduled `status` exists, candidate = `status`
2. Else if runtime-scheduled `milestone` exists, candidate = `milestone`
3. Else no candidate is recorded

This matches current behavior:

- `status` is the earliest deterministic path
- `milestone` is slower and optional
- `ack` does not yet have a runtime send path here

## Why Final Visibility Is Deferred

It would be tempting to record:

- `first_visible_emitted(kind=final)`

inside `get-reply-run.ts`, but that would be premature.

At this layer we only know:

- the agent run finished
- a final reply payload may exist

We do **not** yet know, for every channel and every delivery mode:

- when the final reply was actually routed
- when the user could first see it
- whether a channel-specific renderer delayed that visibility

That integration belongs in the reply dispatch and channel delivery layers.

## Future Phase: Watchdog

Once the phase-1 signals are in place, the next technical step is a watchdog.

The future watchdog should:

- start at turn dispatch
- resolve as soon as any valid first-visible signal is emitted
- emit an early `status` if already semantically allowed
- otherwise fall back to a lightweight `ack`

That phase should build on the same outcome signals rather than invent new
parallel tracking.

## Why This Is PR-Worthy

This is a shared runtime observability and UX concern, not a local preference.

The change improves the upstream codebase because it:

- makes silent latency measurable
- separates orchestration delay from visible-delivery delay
- creates a safe runway for later watchdog work
- does not yet force a controversial user-facing behavior change

This makes it a strong candidate for an incremental community PR:

- clear scope
- measurable value
- low behavior risk
