---
summary: "Plugin execution spine contract: propose → approve(if risky) → execute → verify."
read_when:
  - You are designing plugin execution flows
  - You need a shared safety/approval contract
title: "Plugin Execution Spine Contract"
---

# Plugin Execution Spine Contract (v1)

## Flow

`propose -> approve(if risky) -> execute -> verify`

## ACK-first

Actionable requests SHOULD emit immediate ACK before long-running work.

## Goals

- Lean core, stronger plugins
- Predictable safety behavior
- Auditable execution trail
- Deterministic convergence on one canonical execution flow

## Outcome non-negotiables (to match Clover-style flow)

1. **Single source of truth:** all run/task state MUST be written to one canonical state plane; side caches are read-only derivatives.
2. **Canonical envelope:** every execution event MUST include stable ids (`runId`, `goalId`, `taskId`), origin, status, and timestamp.
3. **ACK-first discipline:** actionable requests MUST emit immediate ACK before long work.
4. **Deterministic reconciliation:** conflicts/drift MUST resolve via a documented precedence order, with an explicit drift report artifact.
5. **Operator-visible health:** current health and next action MUST be exposed from the same canonical state.

## Prompt-request acceptance checklist

A prompt/implementation proposal should be considered complete only if it proves:

- one canonical state plane (single source of truth)
- envelope fidelity (`runId`,`goalId`,`taskId`,`status`,`origin`,`updatedAt`)
- ACK-first behavior on actionable requests
- bounded retry + dead-letter continuity with canonical ids
- deterministic reconciliation artifact with declared precedence
- health/status derived from canonical state, including clear next action

## Implementation Path

- **v1 (this PR):** docs/spec contract only.
- **v1.1:** add a validator to check conformance against these docs.
- **v1.2:** add an adapter/reference implementation for runtime emit/ingest.
- **v2:** optional deeper runtime integration, based on maintainer direction.
