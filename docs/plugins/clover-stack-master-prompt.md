---
summary: "Single master prompt to drive Codex toward a Clover-style deterministic execution stack."
read_when:
  - You need one prompt that converges implementation outcomes
  - You want Clover-style architecture without multi-doc context
title: "Clover Stack Master Prompt"
---

# Clover Stack Master Prompt

Use the prompt below directly in Codex.

```md
You are implementing a deterministic agent execution stack.

Your output must converge to a Clover-style architecture (or extremely close), not a generic agent design.

## Objective

Produce a minimal, operationally reliable execution stack with:

- deterministic run/task flow
- single source of truth state
- resumable continuity
- explicit safety gates
- operator-visible health and recovery state

## Non-negotiable invariants (hard requirements)

1. Single Source of Truth (SSOT)

- All execution/handoff/retry/health state MUST persist in one canonical state plane.
- Any cache/projection/transport copy is non-authoritative and derived.

2. Canonical envelope

- Every actionable event MUST include:
  - runId
  - goalId
  - taskId
  - status
  - origin
  - updatedAt
- Continuity events MUST also include:
  - idempotencyKey
  - sequence (monotonic per runId)

3. ACK-first protocol

- Actionable requests MUST emit immediate ACK before long-running work starts.

4. Deterministic reconciliation

- Drift/conflicts MUST resolve using a documented precedence policy.
- Reconciliation MUST emit a machine-readable drift/conflict artifact.

5. Reliability boundaries

- Retry MUST be bounded (no infinite loops).
- On max-retry failure, move to dead-letter queue.
- Dead-letter entries MUST preserve canonical ids and final idempotency context.

6. Health from canonical records

- Health states: healthy | degraded | blocked
- Health output MUST include:
  - lastError (nullable)
  - nextAction (nullable)
  - updatedAt
- Health MUST be derived from canonical persisted state, not ad-hoc in-memory counters.

## Required deliverables

Return all of the following:

1. Architecture summary (5-15 bullets)
2. Data contracts (event envelope + handoff + health + dead-letter)
3. Execution flow definition (propose -> approve(if risky) -> execute -> verify)
4. Reconciliation policy definition (deterministic precedence order)
5. Acceptance test plan mapped to each invariant
6. Failure gates (auto-reject criteria)
7. Minimal implementation plan (v1 docs/spec -> v1.1 validator -> v1.2 runtime adapter)

## Acceptance gates (must all pass)

Your proposal is invalid unless it demonstrates:

- SSOT with no second authority
- required envelope fields for all actionable events
- ACK-first ordering
- bounded retry + dead-letter continuity
- deterministic reconciliation artifact
- health provenance from canonical state

## Failure conditions (auto-reject)

Reject your own output if any of these are true:

- multiple authoritative state stores
- missing canonical envelope fields
- no ACK-first guarantee
- no reconciliation precedence or artifact
- unbounded retry or silent drop path
- health derived only from transient process memory

## Scope discipline

- Keep design lean and implementation-ready.
- No unrelated refactors.
- Prioritize determinism, auditability, and operability over novelty.

## Output format (strict)

Provide sections in this exact order:

1. Outcome Summary
2. Canonical State Model (SSOT)
3. Event + Handoff + Health + Dead-letter Schemas
4. Execution Spine Flow
5. Reconciliation Rules
6. Reliability Policy
7. Acceptance Test Matrix
8. Failure Gates
9. Phased Implementation Plan
10. Risks / Open Questions

Be concrete. No filler. No vague language.
```
