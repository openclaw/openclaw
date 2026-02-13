# Test Strategy + E2E Harness (Contract → Integration → E2E)

## 1) Why tests are the product
This system is an operational authority. The most important tests are:
- policy violations fail closed
- idempotency is correct under retries
- one real scenario chain works end-to-end deterministically

## 2) Test layers
### A) Contract/unit tests
- validate incident type templates (required evidence)
- validate state transition matrix
- validate authz matrix (role/tool/state)

### B) DB/migration tests
- migrations apply cleanly from scratch
- constraints enforce invariants

### C) Integration tests (dispatch-api)
- each command endpoint returns expected state + audit events
- idempotency replay returns same response
- idempotency conflict returns 409

### D) E2E tests (canonical scenario)
Simulate:
Inbound message → agent plan → tool calls → dispatch-api → DB → outbox → worker actions.

Deterministic requirements:
- fake clock for SLA timers
- deterministic UUIDs in fixtures
- stable test DB reset

## 3) Canonical E2E scenario (must pass)
**Scenario: Emergency — cannot secure storefront**
1) `ticket.create` (NEW)
2) `ticket.triage` sets priority EMERGENCY + incident type + NTE (TRIAGED)
3) Emergency policy triggers immediate schedule confirm (SCHEDULED)
4) `assignment.dispatch` (DISPATCHED)
5) `tech.check_in` (ON_SITE / IN_PROGRESS)
6) Tech discovers replacement part needed; `tech.request_change` (+$) → APPROVAL_REQUIRED
7) `approval.decide(approved)` → returns to IN_PROGRESS
8) Tech uploads required evidence (before/after photos, notes, signature)
9) `tech.complete` → COMPLETED_PENDING_VERIFICATION
10) `qa.verify(PASS)` → VERIFIED
11) `billing.generate_invoice` → INVOICED → CLOSED

Assertions:
- every mutation has audit event
- audit events share correlation_id chain
- completion fails if evidence missing
- retries do not duplicate transitions (idempotent)

## 4) Tool bridge tests
- tool calls map to correct endpoint
- allowlist denies unauthorized tools
- role restrictions enforced

