---
summary: "Single master prompt to drive Codex toward a Clover-equivalent deterministic execution stack."
read_when:
  - You need one prompt that converges implementation output on deterministic execution
  - You want a reviewable Clover-equivalent runtime spec instead of a generic agent architecture
title: "Clover Stack Master Prompt"
---

# Clover Stack Master Prompt

Use the prompt below directly in Codex or another coding/design agent when you
want a concrete, implementation-ready Clover-equivalent execution stack spec.

This is a prompt artifact, not a description of current OpenClaw behavior.

```md
You are implementing a deterministic execution stack.

IMPORTANT:
Target the Clover execution model defined here. Do not infer “Clover” or “Clover-style” from prior knowledge.

## Clover model (authoritative definition)

Clover = a deterministic run orchestration system with:

1. one canonical persisted state authority,
2. strict event envelope + monotonic sequencing,
3. ACK-before-work,
4. bounded retry + DLQ continuity,
5. deterministic reconciliation with declared precedence,
6. operator health derived from canonical state only.

If any of the above is missing, output is invalid.

## Objective

Produce an implementation-ready design/spec that matches the Clover model exactly, or is functionally equivalent with explicit 1:1 mapping.

## Fixed implementation assumptions

- Canonical store: PostgreSQL only. This is the single authoritative state authority.
- Canonical event log table is append-only.
- Read models, projections, caches, queues, and transport payloads are allowed but are strictly derived and non-authoritative.
- Sequence is assigned inside the canonical Postgres writer transaction at persist time.
- `sequence` must be monotonic per `runId` and must never be client-assigned.
- All timestamps must be RFC3339 UTC.
- No in-memory state may be authoritative for execution, retry, reconciliation, or health.

## Canonical authority rule

PostgreSQL is the only source of truth.
If any other component appears to act as authority, call that invalid and reject it.
All execution, handoff, retry, reconciliation, approval, DLQ, and health decisions must be explainable from canonical persisted Postgres records.

## Required lifecycle states

### Run states

`proposed | approved | acked | executing | verifying | completed | failed | deadlettered`

### Goal states

`pending | active | blocked | completed | failed`

### Task states

`queued | acked | running | retry_wait | verified | failed | deadlettered`

## Canonical event envelope (required on every actionable event)

Every actionable event MUST include:

- `eventId`
- `runId`
- `goalId`
- `taskId`
- `status`
- `origin`
- `updatedAt`
- `idempotencyKey`
- `sequence`

Field rules:

- `eventId`: immutable unique identifier for the persisted event
- `runId`, `goalId`, `taskId`: canonical IDs, never null for actionable events
- `status`: must be a valid state transition target
- `origin`: producer identity such as `planner`, `approver`, `executor`, `verifier`, `reconciler`, `operator`
- `updatedAt`: persisted write time in RFC3339 UTC
- `idempotencyKey`: stable across retried delivery of the same logical action
- `sequence`: canonical monotonic integer per `runId`, assigned by Postgres writer transaction

## Canonical approval rule

Approval must be persisted in PostgreSQL before execution is allowed.
Approval must be represented as either:

- a canonical event with `status=approved`, or
- a canonical approval record linked by `runId` and `taskId`

If approval is required and missing, execution must be blocked.
Do not treat UI state, queue state, or worker memory as approval.

## ACK-first definition (strict)

ACK means a persisted canonical event with:

- `status=acked`
- assigned canonical `sequence`
- committed to PostgreSQL before any side-effectful execution starts
- visible to operators and consumers from canonical state

No execution may begin before ACK persistence succeeds.
If ACK persistence fails, execution must not start.

## Execution spine (strict order)

`propose -> approve(if risky) -> ack -> execute -> verify -> reconcile`

Required execution semantics:

- `propose`: create canonical proposed record/event
- `approve(if risky)`: require canonical approval for medium/high risk
- `ack`: persist canonical `acked` event before side effects
- `execute`: perform side-effectful work only after canonical ACK
- `verify`: persist verification result canonically
- `reconcile`: compare canonical truth against derived or competing views and emit artifact

## Risk approval rule (deterministic and required)

Define a deterministic risk classifier with explicit inputs and rules.

Required classifier inputs:

- sideEffectType
- externalSystemCount
- writesData boolean
- deletesData boolean
- permissionScope
- estimatedBlastRadius
- retryCount
- operatorRequestedOverride boolean

Required classifier rules:

- `low`: read-only or no-op actions, no approval required
- `medium`: writes to a single external system or moderate blast radius, approval required
- `high`: destructive action, broad permission scope, multiple external systems, or large blast radius, approval required
- if classifier inputs are incomplete, default to `medium`
- if approval is required and absent, block execution

## Idempotency rule

The design must explain:

- how `idempotencyKey` is generated,
- where uniqueness is enforced,
- how duplicate delivery is detected,
- how retries reuse the same `idempotencyKey`,
- how duplicate side effects are prevented.

## Retry/DLQ policy (strict)

Retry must be bounded and deterministic.

Required retry rules:

- maximum retry count must be explicit
- backoff formula must be explicit
- no infinite retry loops
- no silent drops

Use this required deterministic backoff formula unless there is a strong reason not to:

- `delaySeconds = min(baseDelaySeconds * 2^retryAttempt, maxDelaySeconds)`
- include concrete values for `baseDelaySeconds`, `maxDelaySeconds`, and `maxRetryCount`

On max retry exhaustion:

- persist terminal failure canonically
- move item to DLQ canonically
- set task status to `deadlettered`
- set run status to `deadlettered` if no forward progress remains

## DLQ record contract (required)

Each DLQ record must preserve:

- `runId`
- `goalId`
- `taskId`
- `idempotencyKey`
- `finalError`
- `nextAction`
- `lastSequence`
- `deadletteredAt`

`nextAction` must be explicit, for example:

- `operator_review`
- `manual_requeue`
- `discard`

## Reconciliation policy (strict)

Reconciliation must be deterministic and must emit an artifact with this exact shape:

- `reconciliationId`
- `runId`
- `detectedAt`
- `policyVersion`
- `conflicts[]`
- `appliedActions[]`
- `unresolved[]`

Each `conflicts[]` entry must contain:

- `field`
- `canonicalValue`
- `competingValue`
- `winner`
- `reason`

## Reconciliation precedence order (must be implemented exactly)

Use this precedence order, highest precedence first:

1. explicit operator override persisted canonically
2. canonical persisted event stream in PostgreSQL
3. highest valid monotonic `sequence` within the canonical event stream
4. retry worker input
5. transport payload copy
6. cache or projection copy

Interpretation rules:

- operator override only counts if persisted canonically in PostgreSQL
- `highest valid monotonic sequence` means the highest canonical sequence that also satisfies schema validity, idempotency rules, and legal state transition rules
- non-canonical sources may inform reconciliation but may never overrule canonical persisted records

## Health contract (strict)

Health status enum:
`healthy | degraded | blocked`

Health must be computed from canonical persisted PostgreSQL records only.

Required fields:

- `status`
- `lastError`
- `nextAction`
- `updatedAt`
- `runId`
- `goalId`
- `sourceOfTruth`

Field rules:

- `lastError`: nullable terminal or latest active error from canonical records
- `nextAction`: nullable operator or system recovery action derived from canonical records
- `updatedAt`: timestamp of the canonical records used to compute health
- `runId`, `goalId`: nullable when health is global rather than scoped
- `sourceOfTruth`: exact canonical identifier string, e.g. `postgres.public.events`

Health derivation rule:

- do not use worker-local counters, process memory, ephemeral queue depth, or transient UI state as health authority
- such signals may be observed, but final health must be derived from canonical persisted records only

## Required Postgres design detail

Your output must define:

- canonical tables
- primary keys
- foreign keys
- uniqueness constraints
- indexes needed for ACK lookup, sequence ordering, idempotency enforcement, retry scans, DLQ scans, and health queries

At minimum, specify schemas for:

- event log
- run state
- goal state
- task state
- approvals
- dead-letter records
- reconciliation artifacts

## Acceptance tests (must provide)

Map each Clover invariant to at least one concrete acceptance test.

Required tests:

1. SSOT authority test
2. envelope conformance test
3. ACK-before-execute ordering test
4. sequence monotonicity test
5. approval-blocking test
6. retry bound + DLQ continuity test
7. reconciliation precedence + artifact shape test
8. health provenance-from-canonical-state test
9. idempotency duplicate-delivery test
10. illegal-state-transition rejection test

Each test must include:

- setup
- action
- expected persisted records
- expected final state

## Auto-reject conditions

Reject your own output if any are true:

- more than one authoritative state store
- missing required envelope fields
- ACK not persisted before execute
- sequence assigned outside canonical writer transaction
- non-monotonic sequence semantics
- approval required but not canonically enforced
- unbounded retries or silent drops
- missing DLQ continuity fields
- missing reconciliation artifact or precedence rules
- operator override not persisted canonically
- health derived from in-memory or transient worker state
- projections or queues treated as authoritative

## Output format (strict order)

1. Clover Equivalence Statement
2. Canonical State Schema (Postgres tables, keys, constraints, indexes)
3. Event Envelope + State Machines
4. Execution Spine + Approval Gate Logic
5. Retry/DLQ + Idempotency Design
6. Reconciliation Rules + Artifact Schema
7. Health Computation Contract
8. Acceptance Test Matrix
9. Failure Gates
10. Minimal Implementation Plan (v1 spec -> v1.1 validator -> v1.2 runtime adapter)

## Writing constraints

- Be concrete.
- No filler.
- No vague language.
- Do not propose optional alternate architectures.
- Do not generalize beyond the fixed assumptions above.
- If a design choice is required, choose one and state it.
- If any required Clover property cannot be satisfied, say `INVALID AGAINST CLOVER` and explain exactly why.
```
