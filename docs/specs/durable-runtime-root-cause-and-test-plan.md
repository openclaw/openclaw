---
title: Durable Runtime Root Cause and Validation Plan
summary: "Root-cause classes and staged validation plan for the durable runtime recovery stack."
read_when:
  - Planning durable runtime validation
  - Reviewing recovery risks before implementation PRs
  - Auditing which runtime proof is deferred from the docs-only RFC
---

# Durable Runtime Root Cause and Validation Plan

## Stack context

This document accompanies the durable core RFC as **PR 1/5** in a sequential
review stack. It is **docs/RFC/root-cause/test-plan only** and intentionally
contains no implementation code.

## Root-cause classes

Current non-durable runtime behavior can lose operator confidence in these
classes of failure:

1. **Volatile in-memory progress**: process exit or gateway restart can erase
   knowledge of accepted work, intermediate progress, or pending completion.
2. **Ambiguous terminal state**: callers and operators may not be able to tell
   whether work completed, failed, was cancelled, or is still recoverable.
3. **Weak recovery contract**: restart code may not have enough persisted state
   to safely resume, reconcile, or mark abandoned work.
4. **Insufficient audit trail**: debugging depends on transient logs rather than
   structured lifecycle events tied to stable runtime identifiers.
5. **Product/runtime coupling risk**: durable primitives can become entangled
   with product-specific behavior if the core boundary is not defined first.

## Issue classes the implementation must address

- stable runtime identifiers for each accepted unit of runtime work;
- append-only or otherwise auditable lifecycle events;
- durable checkpoints/steps sufficient for idempotent recovery decisions;
- explicit terminal states and cancellation handling;
- recovery worker behavior that is bounded, observable, and safe to retry;
- operator inspection that does not mutate runtime state;
- disabled-mode compatibility for installations that do not enable the feature.

## Validation plan for later PRs

Implementation PRs should provide evidence for the smallest relevant shard at
each layer:

- storage/schema: migration tests, generated schema/type checks, guardrail lint,
  and downgrade/disabled-mode expectations;
- runtime foundation: unit tests for intake, lifecycle events, terminal states,
  retry limits, cancellation, and idempotency;
- gateway/agent wiring: compatibility tests proving existing synchronous paths
  still work and durable paths record the required context;
- recovery: restart/recovery unit tests plus local smoke that proves incomplete
  work is detected and reconciled safely;
- operator surfaces: read-only listing/stats tests and error-shape checks;
- full hygiene: typecheck, lint, targeted unit shards, and `git diff --check`.

## Not tested in this PR

No live runtime proof, restart smoke, database migration, CLI command, gateway
method, or agent integration has been run for this PR because this PR is
docs-only. Those checks are deferred to the implementation PRs that introduce
code.

## Non-goals and exclusions

- Workboard is out of scope except as a future consumer that must not define the
  durable core boundary.
- TaskFlow is out of scope except as a future consumer that must not define the
  durable core boundary.
- Product UI, plugin behavior, external provider behavior, and workflow planning
  semantics are not validated by this document.

## Rollout and rollback expectations

The implementation should be introduced behind an explicit feature flag, with
observable state and a documented disabled path. Rollback should consist of
turning off durable runtime behavior while preserving existing non-durable paths;
any persisted durable data should remain inert until the feature is re-enabled or
migrated by a reviewed follow-up.
