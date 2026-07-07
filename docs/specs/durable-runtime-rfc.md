---
title: Durable Core Runtime Boundary
summary: "RFC for the generic durable runtime boundary, recovery semantics, and operator inspection surface."
read_when:
  - Designing durable runtime recovery for OpenClaw
  - Reviewing the durable core architecture boundary
  - Separating runtime primitives from Workboard or TaskFlow product behavior
---

# RFC: Durable Core Runtime Boundary

## Status and stack context

This is proposal **1/5** for a sequential durable-core stack. This first PR is
**documentation only**: it defines the core runtime boundary, root-cause model,
and validation plan before any implementation is reviewed.

The durable core is the lowest-level runtime layer responsible for recording and
recovering OpenClaw runtime work. It should be reusable by gateway, agent, and
future product surfaces without depending on those products.

## Goals

- Give runtime work a durable identity that survives process restarts.
- Persist lifecycle events, step progress, errors, retry decisions, and terminal
  outcomes in OpenClaw state.
- Make recovery explicit: after restart, the runtime can distinguish complete,
  failed, cancelled, and resumable/incomplete work.
- Expose a small operator/read API for inspecting runtime state and health.
- Preserve current synchronous behavior unless the durable runtime feature is
  enabled and validated.

## Non-goals

- Workboard behavior, UI, plugin storage, and product-specific review flows are
  out of scope for this core runtime RFC.
- TaskFlow orchestration, task planning semantics, and task product UX are out
  of scope for this core runtime RFC.
- This PR does not add implementation code, migrations, CLI commands, gateway
  methods, or tests; those belong in later PRs in the stack.
- This RFC does not claim live proof of the proposed implementation.

## Proposed boundary

The durable core should own these generic runtime primitives:

- runtime run identity and operation kind;
- durable lifecycle/event recording;
- step/checkpoint recording for recovery decisions;
- retry, cancellation, and terminal-state semantics;
- recovery scanning and safe resumption hooks;
- operator inspection surfaces that report state without mutating work.

The durable core should not import product-level concepts. Product layers may
attach metadata or references to a run, but the core must remain meaningful
without knowing about product-specific UX, channel behavior, or provider
plugins.

## Rollout and rollback

Rollout should be gated behind an explicit durable-runtime feature flag until
migration, recovery, and operator surfaces have passed review. A safe rollout
sequence is:

1. land this docs-only boundary and test plan;
2. add the storage/runtime foundation behind a disabled-by-default flag;
3. wire one narrow runtime path with compatibility checks;
4. add recovery/operator hardening;
5. expand consumers only after core behavior is observable and reversible.

Rollback must leave existing non-durable execution paths available. If durable
runtime behavior is disabled, startup and core commands should continue using
current behavior, and persisted durable rows should be ignored rather than
partially interpreted by product layers.

## Deferred proof

Implementation proof is intentionally deferred. Later implementation PRs should
include unit/type/lint gates, schema compatibility checks, disabled-mode startup
checks, restart/recovery smoke, and a documented live proof before broadening
consumer scope.
