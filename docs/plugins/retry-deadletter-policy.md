---
summary: "Plugin-scoped bounded retry and dead-letter policy to prevent silent task loss."
read_when:
  - You are implementing plugin retry behavior
  - You need dead-letter handling for failed plugin tasks
title: "Retry + Dead-letter Policy"
---

# Retry + Dead-letter Policy (v1)

Related: [Core retry policy](/concepts/retry)

## Retry

- Bounded retries only (no infinite loops)
- Explicit retry count + backoff

## Dead-letter

- Failed items after max retries move to dead-letter queue
- Must include failure reason + next operator action
- Must preserve canonical ids (`runId`, `goalId`, `taskId`) and the final `idempotencyKey`

## Reconciliation + SSOT

- Retry and dead-letter transitions MUST be written to the same canonical state plane used by execution/handoff.
- Reconciliation runs MUST emit a drift/conflict artifact and apply a documented precedence policy.

## Implementation Path

- **v1 (this PR):** docs/spec contract only.
- **v1.1:** add a validator to check conformance against these docs.
- **v1.2:** add an adapter/reference implementation for runtime emit/ingest.
- **v2:** optional deeper runtime integration, based on maintainer direction.
