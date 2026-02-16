# Stories (Epics → Features → User Stories)

This backlog is sequenced to preserve invariants and ship incrementally.

---

## E1. Contracts & Observability

### Feature E1-F1: Shared contracts package

**Story E1-F1-S1:** Add `packages/dispatch-contracts` with canonical types + runtime validators.  
**Acceptance**

- `DispatchCommand`, `PolicyDecision`, `OutboxEvent`, `EvidenceRecord`, `CommsEnvelope` exported.
- Consumers compile without local duplicates.
- Validators reject unknown/invalid shapes.

**Tests**

- Typecheck pipeline
- Unit tests for validators

### Feature E1-F2: Trace propagation

**Story E1-F2-S1:** Standardize on W3C `traceparent`/`tracestate` fields in the command chain.  
**Acceptance**

- Trace context can be passed end-to-end (api → outbox → temporal activity).
- Backward compat: existing trace id header mapping preserved.

**Tests**

- Unit tests for header extraction/propagation

---

## E2. Data Plane: Command boundary

### Feature E2-F1: Internal normalization module

**Story E2-F1-S1:** Implement DispatchCommand normalization inside dispatch-api.  
**Acceptance**

- Every mutating route constructs a normalized command object.
- Audit/timeline entries link to requestId + correlationId.
- Fail closed on missing required fields.

**Tests**

- Regression: existing story tests pass
- New unit tests around normalization

### Feature E2-F2: Idempotency contract hardening

**Story E2-F2-S1:** Enforce idempotency key uniqueness and response replay semantics across all mutating commands.  
**Acceptance**

- Duplicate requestId returns exact prior response (or known-safe error) deterministically.
- Conflict mismatch produces explicit 409 with machine-readable mismatch info.

**Tests**

- Integration tests for idempotency replay + mismatch

---

## E3. Policy-as-data

### Feature E3-F1: Policy decision persistence

**Story E3-F1-S1:** Add policy decision table and persist decisions for every attempted command.  
**Acceptance**

- Decision is stored even when denied (with reasonCode, explanation, bundle hash).
- Audit/timeline links to decision record.

**Tests**

- Integration: denied command writes audit + decision

### Feature E3-F2: Bundle management v0

**Story E3-F2-S1:** Implement policy bundle loader with version + sha256 hash; fail closed on invalid bundle.  
**Acceptance**

- Only one active bundle at a time.
- Bundle hash is persisted with every decision.

**Tests**

- Unit: invalid bundle rejects
- Integration: bundle hash stamped

### Feature E3-F3: Starter policies

**Story E3-F3-S1:** Quiet hours gating for outbound comms and schedule confirmation.  
**Story E3-F3-S2:** NTE delta approvals gating.  
**Story E3-F3-S3:** Closeout evidence gating mapped to incident templates.  
**Acceptance**

- Decisions are deterministic, explainable, and consistent across retries.

**Tests**

- Unit tests for each policy rule + integration paths

---

## E4. Events: Outbox

### Feature E4-F1: Transactional outbox table

**Story E4-F1-S1:** Add outbox table + helpers; write an outbox row within same DB transaction as each state mutation.  
**Acceptance**

- State change and outbox row either both commit or both rollback.
- Events have stable taxonomy/version.

**Tests**

- DB integration tests for atomicity

### Feature E4-F2: Outbox relay v0

**Story E4-F2-S1:** Implement relay process (polling) to publish outbox events at-least-once; consumers are idempotent.  
**Acceptance**

- Duplicate publishes do not duplicate side effects.
- Relay supports log-only and deliver-to-temporal modes.

**Tests**

- Integration: duplicate publish scenarios
- Relay resume after crash

---

## E5. Evidence lifecycle

### Feature E5-F1: Evidence metadata schema

**Story E5-F1-S1:** Add retention class and redaction state columns; default values are safe.  
**Acceptance**

- Existing evidence gating continues to work.
- New fields present and populated.

**Tests**

- DB migration tests + regressions

### Feature E5-F2: Presigned upload + finalize

**Story E5-F2-S1:** Add presigned upload flow with expected sha256 and max size.  
**Acceptance**

- Finalize validates size/hash and fails closed on mismatch.
- EvidenceRecord is immutable and linked to ticket + command chain.

**Tests**

- Integration tests using MinIO in compose

---

## E6. Control Plane: Temporal

### Feature E6-F1: Temporal scaffold

**Story E6-F1-S1:** Add Temporal dev environment + worker skeleton.  
**Acceptance**

- Worker starts in dev; does no mutations.

**Tests**

- Smoke test in CI

### Feature E6-F2: Workflow-per-ticket (shadow mode)

**Story E6-F2-S1:** Create ticket workflow that reacts to outbox events and produces proposals only.  
**Acceptance**

- No automatic mutations.
- Deterministic and replay-safe.

**Tests**

- Temporal tests for determinism
- Integration: outbox → signal

---

## E7. Approvals & autonomy tiers

### Feature E7-F1: Approval signals

**Story E7-F1-S1:** Implement approval request/decision signals and “wait” states in workflow.  
**Acceptance**

- REQUIRE_APPROVAL pauses workflow until decision signal.
- Decision is logged and linked.

**Tests**

- Temporal integration tests with time skipping

### Feature E7-F2: Kill switch

**Story E7-F2-S1:** Enforce autonomy pause at both data plane (command denial) and control plane (pre-activity checks).  
**Acceptance**

- Any paused scope stops auto-actions immediately.
- Manual overrides are explicit and audited.

**Tests**

- Integration tests: paused scope blocks activity

---

## E8. Multi-tenancy & RLS

### Feature E8-F1: Tenant columns + default tenant

**Story E8-F1-S1:** Add `tenants` table and `tenant_id` columns (nullable), backfill default.  
**Acceptance**

- No behavior change until RLS is enabled.

**Tests**

- DB migrations + backfill tests

### Feature E8-F2: RLS policies

**Story E8-F2-S1:** Add RLS policies behind a flag; request context sets tenant via `SET LOCAL`.  
**Acceptance**

- Cross-tenant reads/writes are blocked when enabled.
- Force RLS prevents owner bypass.

**Tests**

- Integration tests for tenant isolation

---

## E9. Edge: Comms (Twilio)

### Feature E9-F1: CommsEnvelope persistence

**Story E9-F1-S1:** Persist normalized comms envelopes and link them into ticket timeline/evidence.  
**Acceptance**

- Every inbound/outbound is stored with correlationId.
- Provider raw payload preserved.

**Tests**

- Integration tests

### Feature E9-F2: Twilio inbound MVP

**Story E9-F2-S1:** Twilio inbound SMS webhook validates signature and persists CommsEnvelope.  
**Acceptance**

- Signature validation enforced.
- Messages become evidence/timeline entries.

**Tests**

- Security tests + integration tests

---

## E10. Edge: Optimizer (recommend-only)

### Feature E10-F1: Optimization contract

**Story E10-F1-S1:** Define OptimizationInput/Output and implement a stub scorer.  
**Acceptance**

- Produces ranked proposals + explanations.
- No DB writes; results recorded via dispatch-api snapshot tool.

**Tests**

- Unit tests for contract and scoring

---

## E11. Simulation & replay

### Feature E11-F1: Shadow autonomy replay tool

**Story E11-F1-S1:** CLI to replay ticket history and generate “would-do” proposals under current policies.  
**Acceptance**

- No mutations.
- Outputs are stored as artifacts with policy bundle hash.

**Tests**

- Integration tests over seeded ticket timeline

---

## E12. Ops readiness

### Feature E12-F1: Runbooks + dashboards

**Story E12-F1-S1:** Publish runbooks (outbox lag, temporal backlog, webhook failures, evidence failures) and add dashboards.  
**Acceptance**

- On-call can detect and mitigate incidents with clear steps.

**Tests**

- N/A (documentation), but runbooks are reviewed.
