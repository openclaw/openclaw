---
summary: "Canonical prompt-request template for deterministic Clover-style execution outcomes."
read_when:
  - You are writing a PR prompt request that must converge on Clover-style architecture
  - You need non-negotiable outcome constraints and acceptance gates
title: "Prompt Request Template: Clover Outcome (v1)"
---

# Prompt Request Template: Clover Outcome (v1)

## 1) Objective (Outcome, not implementation)

Produce an implementation that converges to the Clover execution model with deterministic behavior and operator-visible state continuity.

The objective is **not** “build something similar.”
The objective is to satisfy the required invariants and acceptance checks below.

## 2) Non-negotiable invariants

1. **Single Source of Truth (SSOT)**
   - All execution, handoff, retry/dead-letter, and health state MUST be persisted to one canonical state plane.
   - Any projections/caches are derived views and MUST NOT become authoritative.

2. **Canonical Event Envelope**
   - Every actionable event MUST include:
     - `runId`
     - `goalId`
     - `taskId`
     - `status`
     - `origin`
     - `updatedAt`
   - Handoff/replay paths MUST also include `idempotencyKey` and monotonic `sequence` per `runId`.

3. **ACK-first Discipline**
   - Actionable requests MUST emit immediate ACK before long-running execution.

4. **Deterministic Reconciliation**
   - Drift/conflicts MUST be reconciled using a documented precedence policy.
   - Reconciliation MUST emit a machine-readable drift/conflict artifact.

5. **Bounded Retry + Dead-letter**
   - No infinite retries.
   - Dead-letter transitions MUST preserve canonical identifiers and final idempotency context.

6. **Health Derived from Canonical State**
   - Health/status outputs MUST be computed from canonical state records.
   - Health output MUST include current status and next action.

## 3) Required deliverables/artifacts

- Contract/spec updates for execution spine, handoff packet, health schema, and retry/dead-letter policy.
- Validator/check output (or equivalent conformance proof) showing envelope and invariant compliance.
- Reconciliation artifact (drift/conflict report) with precedence policy reference.
- Operator-facing status artifact proving health + next action are sourced from canonical state.

## 4) Acceptance tests (must pass)

- SSOT conformance test: all relevant state transitions resolve to canonical state plane.
- Envelope conformance test: required fields present for all actionable events.
- ACK-first test: ACK emitted before long-running operation begins.
- Retry/dead-letter continuity test: identifiers preserved across failure path.
- Reconciliation test: deterministic conflict resolution + drift artifact generated.
- Health provenance test: health/next action derived from canonical state.

## 5) Failure conditions (auto-reject)

Reject the output if any of the following is true:

- Multiple authoritative state stores are introduced.
- Required envelope fields are missing/inconsistent.
- ACK-first behavior is absent.
- Retry policy is unbounded or dead-letter loses canonical ids.
- Reconciliation policy/artifact is missing.
- Health is derived from ad-hoc/transient state rather than canonical records.

## 6) Scope boundaries

- Keep changes scoped to requested contract/surface unless explicitly authorized.
- Avoid unrelated refactors.
- Preserve backward compatibility where required by maintainers.

## 7) Delivery format

Provide:

1. Concise change summary
2. Invariant mapping table (`invariant -> implementation evidence`)
3. Acceptance test results
4. Known risks/gaps (if any)
5. Next-step recommendations

---

## PR Prompt Request (copy/paste block)

Use this block directly in a PR comment or prompt-request:

```md
### Prompt Request: Deterministic Clover-Style Outcome

**Objective**
Converge on Clover execution behavior with deterministic state continuity and operator-visible health from canonical state.

**Non-negotiable invariants**

- SSOT for execution/handoff/retry/health state
- Canonical envelope (`runId`,`goalId`,`taskId`,`status`,`origin`,`updatedAt`) + (`idempotencyKey`,`sequence`) where applicable
- ACK-first on actionable requests
- Deterministic reconciliation + drift artifact
- Bounded retry + dead-letter with canonical id preservation
- Health/next-action derived from canonical state

**Required outputs**

- Updated contracts/specs
- Conformance evidence
- Reconciliation artifact
- Operator status proof

**Acceptance gates**
Output is accepted only if all invariant and acceptance tests pass.

**Failure gates (auto-reject)**
Any missing invariant, missing artifact, multi-authority state design, unbounded retry loop, or non-canonical health derivation.
```
