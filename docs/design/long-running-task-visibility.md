# Long-Running Task Visibility Design

## Overview

This document defines a user-visible feedback model for long-running or
high-complexity turns.

The problem is not only absolute latency. The larger issue is that some turns
spend a long time in orchestration, ACP session setup, tool routing, or model
work before the user sees any visible sign of progress. From the user's point
of view, these turns feel stuck even when the runtime is technically healthy.

The goal of this design is to make long tasks feel alive without faking
progress, without over-streaming every short answer, and without mixing
physical runtime state with model-specific workaround logic.

This document is intentionally presentation- and runtime-facing. It should
complement the task-control and orchestrator-specialist work rather than
replace it.

Implementation details for the first increment live in:

- `docs/design/long-running-task-visibility-technical.md`

## Problem Statement

Recent runtime behavior shows a recurring pattern:

- inbound delivery and dispatch are fast
- some turns still take 10s to 50s before any visible output appears
- once visible output begins, final completion may happen quickly

In other words, the largest user-experience gap is often:

- `dispatch -> first visible output`

rather than:

- `first visible output -> final`

This can happen for multiple reasons:

- ACP or subagent orchestration before any user-visible message
- tool routing or validation before reply delivery starts
- turns that do not qualify for card streaming and therefore stay silent until
  final output
- long-running final generation with no early status path

This creates a misleading user experience:

- the system is alive
- the message was received
- but the user sees nothing and infers the system is frozen

## Goals

- Provide reliable early visibility for long-running turns.
- Separate "the user should see something now" from "the full answer is ready."
- Avoid fake progress claims that outrun physical runtime state.
- Keep short turns lightweight and quiet.
- Reuse the existing supervisor and presentation seams where possible.
- Make the behavior measurable so it can be tuned and reviewed.

## Non-Goals

- This document does not require streaming for every reply.
- This document does not redefine specialist orchestration architecture.
- This document does not force a specific model provider.
- This document does not require milestone generation on every long task.

## Design Principles

### 1. First visible output is a runtime contract

The system should treat first visible output as an explicit contract, not an
accidental byproduct of whether a final reply happens to be long enough for
streaming.

### 2. Visibility should be truthful

The system should not claim:

- that a task has switched when runtime ownership has not moved
- that a specialist is running when ACP setup failed
- that meaningful progress exists when only queueing has happened

User-visible feedback should describe confirmed state, not optimistic intent.

### 3. Long-task visibility is different from final delivery

There are at least three distinct phases:

- accepted: the turn was received and is being worked on
- progressing: work is ongoing and a meaningful intermediate state exists
- completed: a final answer or artifact is ready

These phases should not depend on a single delivery primitive.

### 4. Do not over-stream simple turns

Many short replies are better as fast final messages. The system should not
turn every simple answer into a typing-showcase. Visibility effort should be
spent where silence would otherwise harm confidence.

### 5. Runtime invariants and model patching stay separate

This design should maintain the same split used elsewhere:

- physical/runtime behavior:
  when to emit an early visible signal, what it is allowed to claim, and what
  timers or guards apply
- model-owned wording:
  how a milestone or richer progress message is phrased, when worthwhile
- temporary guardrails:
  narrow protections for current model/runtime gaps

## Visibility Taxonomy

The existing conversation presentation layer already defines:

- `ack`
- `status`
- `milestone`
- `final`

This document keeps that vocabulary and adds a more explicit runtime reading:

### `ack`

Purpose:

- show that the turn has been accepted
- answer "did you receive me?"

Properties:

- ultra-fast
- deterministic
- minimal wording or channel-native equivalent
- should not imply task-switch or progress

### `status`

Purpose:

- show what the system is currently doing with the turn
- answer "what execution path am I on?"

Properties:

- deterministic or template-first
- can describe:
  - waiting on specialist startup
  - preparing a document
  - continuing current task
  - preserving current foreground task
- should only claim confirmed runtime state

### `milestone`

Purpose:

- surface meaningful intermediate progress
- answer "what useful progress has already happened?"

Properties:

- optional
- richer and more selective
- may use a model path
- should not be used to compensate for missing `ack` or `status`

### `final`

Purpose:

- deliver the actual answer or artifact

Properties:

- unchanged

## Key Latency Segments

The system should explicitly observe three latency segments:

1. `dispatch -> first_visible_output`
2. `first_visible_output -> final_visible_output`
3. `dispatch -> final_visible_output`

Today, the first segment is often the most important user-experience failure
mode.

The visibility layer should therefore optimize primarily for segment 1.

## Proposed Runtime Policy

### 1. Introduce a first-visible watchdog

Every externally routable turn should start a first-visible watchdog once
dispatch begins.

If no visible output has been emitted before the watchdog threshold, the system
should emit a minimal deterministic `ack` or `status`, depending on the known
execution state.

Suggested initial thresholds:

- `ack` watchdog target: 800ms
- `ack` watchdog hard ceiling: 1500ms
- long-task `status` watchdog target: 2500ms
- long-task `status` watchdog hard ceiling: 4000ms

These are intentionally slower than transport receipt, but much faster than a
10s to 50s silent gap.

### 2. Treat specialist startup as a first-class visible state

If the turn enters ACP or specialist orchestration before any user-visible
content exists, the visibility layer should be allowed to emit a status like:

- preparing Codex
- starting specialist analysis
- waiting for specialist session

However, these statuses must be gated by confirmed runtime state:

- allowed:
  specialist startup was actually attempted
- not allowed:
  the model merely intended to use Codex but never reached runtime spawn

### 3. Fail fast on unavailable specialist paths

If a requested specialist path fails, the system should not spend a long silent
interval before reporting it.

Instead:

- failure should become visible quickly
- the user should be told the requested backend could not be started
- fallback to ordinary tools or ordinary agent work still requires explicit
  user confirmation

This aligns with the ACP failure contract already being established elsewhere.

### 4. Decouple early visibility from card streaming

Feishu card streaming is useful, but it should not be the only source of first
visible output.

Some turns do not qualify for card streaming because they are:

- short
- plain text
- structurally unsuitable for card rendering

Long-task visibility should therefore be able to emit a lightweight message
even when final reply rendering does not use card streaming.

### 5. Suppress noise on genuinely short turns

If a turn completes before the watchdog threshold, no extra visibility message
should be emitted.

This prevents:

- duplicate acknowledgements
- "thinking..." noise for trivial answers
- extra channel churn

## Visibility State Machine

The minimal state machine for an external turn should be:

1. `received`
2. `visible_pending`
3. one of:
   - `ack_emitted`
   - `status_emitted`
   - `milestone_emitted`
   - `final_emitted`
4. `completed`

Important rules:

- `final_emitted` satisfies the first-visible requirement
- `ack_emitted` does not suppress later `status` or `milestone` if the turn
  stays long-running
- `status_emitted` should normally suppress a redundant late `ack`
- `milestone_emitted` should not be the first visible output unless a valid
  earlier visibility stage was intentionally skipped

## Integration With Existing Supervisor Presentation

This design should build on the existing supervisor presentation seam rather
than create a parallel one.

Recommended split:

- supervisor planner:
  decides whether `status` or `milestone` is semantically appropriate
- long-task visibility watchdog:
  decides when silence has lasted too long and a visible signal is now needed
- channel delivery:
  decides how that signal is rendered on Feishu and other channels

In practice:

- `status` templates remain deterministic
- `milestone` remains selective and optional
- first-visible watchdog can elevate an allowed `status` sooner when silence
  exceeds target

## Measurement and Outcome Signals

This behavior should be observable in outcome records.

Recommended additions or clarifications:

- `first_visible_scheduled`
- `first_visible_emitted`
- `first_visible_skipped_fast_complete`
- `first_visible_kind`
  - `ack`
  - `status`
  - `milestone`
  - `final`
- `dispatch_to_first_visible_ms`
- `first_visible_to_final_ms`

This should make it easy to answer:

- which turns stayed silent too long
- whether silence was due to no eligible visibility path or due to a bug
- whether specialist startup or tool routing dominated the silent interval

## Initial Heuristics

The first increment should stay simple.

### Emit early `status` when:

- the turn is externally routable
- no visible output has happened within the watchdog threshold
- a deterministic `status` is already allowed by the supervisor plan

### Emit early `ack` when:

- the turn is externally routable
- no visible output has happened within the watchdog threshold
- no semantically valid `status` is available yet

### Prefer no extra message when:

- final reply arrives before the watchdog threshold
- the channel is internal-only
- the turn was intentionally silent

## Risks

### 1. Over-signaling

If thresholds are too aggressive, users may see too many low-value intermediate
messages.

### 2. False confidence

If wording is not tightly gated to runtime state, the system may sound more
certain than it really is.

### 3. Channel inconsistency

Different channels may render early visibility differently. The semantic layer
should stay shared even if rendering diverges.

### 4. More lifecycle complexity

Tracking first visible output as an explicit runtime concern adds state and
timers. This is acceptable only if outcome signals and tests keep the behavior
under control.

## Rollout Plan

### Phase 1

- document the contract
- measure current `dispatch -> first_visible_output`
- add outcome signals for first visible output

### Phase 2

- add a minimal first-visible watchdog
- allow deterministic `status` to satisfy the watchdog when already planned
- fall back to a lightweight `ack` when no `status` is eligible

### Phase 3

- refine specialist-startup statuses
- tune thresholds by channel and task class
- fold milestone eligibility into the same visibility timeline where useful

## Why This Is PR-Worthy

This is not just a local preference. It addresses a general OpenClaw product
problem:

- a turn can be healthy internally while feeling frozen externally
- complex orchestration can create long silent gaps before any visible output
- current visibility often depends too much on whether final rendering happens
  to use streaming

Improving long-task visibility therefore has clear upstream value:

- better perceived responsiveness
- clearer runtime observability
- cleaner separation between orchestration latency and delivery latency
- fewer false "gateway is stuck" diagnoses

## Summary

Long-task visibility should be treated as a first-class runtime and
presentation concern.

The core design move is simple:

- do not wait for final streaming behavior to decide whether the user sees
  anything
- explicitly measure and govern the time from dispatch to first visible output
- use truthful, lightweight visibility signals when silence exceeds acceptable
  limits

This should make long-running turns feel alive without turning every reply into
noise or pretending progress exists when it does not.
