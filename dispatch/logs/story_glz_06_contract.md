# GLZ-06 Contract: Customer confirmation hold/release rollback command chain

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

Timestamp baseline: 2026-02-14 PST
Story: `GLZ-06: Customer confirmation hold/release/rollback`

## Goal

Introduce a command-driven hold layer for customer confirmation with deterministic release and rollback semantics.

## Command contracts

### 1) Hold

`POST /tickets/{ticketId}/schedule/hold`

Required payload:

- `hold_reason` (`CUSTOMER_PENDING`, `CUSTOMER_UNREACHABLE`, `CUSTOMER_CONFIRMATION_STALE`)
- `confirmation_window` (`{ "start": "", "end": "" }`)

Behavior:

- Ticket is moved into hold control (`SCHEDULE_PROPOSED` / `SCHEDULED` frozen with hold metadata).
- `hold_snapshot` captures prior state, payload, and schedule window.

### 2) Release

`POST /tickets/{ticketId}/schedule/release`

Required payload:

- `customer_confirmation_log` (string)

Behavior:

- If hold is active and confirmation is valid, restore committed schedule state from snapshot and allow normal confirmation path.

### 3) Rollback

`POST /tickets/{ticketId}/schedule/rollback`

Required payload:

- `confirmation_id`
- `reason`

Behavior:

- Returns ticket and schedule to most recent hold snapshot.
- Adds immutable hold lineage entry.

## Command chain requirement

Sprint G2 requires:

- `TRIAGED -> READY_TO_SCHEDULE -> SCHEDULE_PROPOSED -> SCHEDULED -> DISPATCHED`
- Hold/release/rollback are scheduling control commands and do not bypass lifecycle transitions.

## Failure contract

Expected blocked commands return explicit, correlated errors:

- `CUSTOMER_CONFIRMATION_STALE`
- `SCHEDULE_HOLD_STATE_CONFLICT`
- `HOLD_CONFIRMATION_MISSING`
- `HOLD_SNAPSHOT_MISSING`
- `INVALID_STATE_TRANSITION`

Error payload must include:

- `correlation_id`
- `hold_id`
- `snapshot_id`

## Audit/timeline requirements

- Every hold/release/rollback command writes one `audit_events` row and one timeline-compatible transition record.
- Hold snapshots are immutable and referenced by rollback/release command payloads.
- Repeated hold operations for the same ticket must be idempotent under same `Idempotency-Key` and return the same `hold_id`.

## Tests to add

- `dispatch/tests/story_glz_06_confirmation_hold_chain.node.test.mjs`
  - successful hold + release flow
  - stale hold rejection with explicit reason
  - rollback replays hold snapshot deterministically
  - blocked transitions when in wrong state

## Observability hooks

- `dispatch_api_requests_total{route="/tickets/{ticketId}/schedule/hold",status="200"}`
- `dispatch_api_requests_total{route="/tickets/{ticketId}/schedule/release",status="200"}`
- `dispatch_api_requests_total{route="/tickets/{ticketId}/schedule/rollback",status="200"}`
- `dispatch_api_errors_total{code="CUSTOMER_CONFIRMATION_STALE"}`
- `dispatch_api_errors_total{code="SCHEDULE_HOLD_STATE_CONFLICT"}`
- `dispatch_api_errors_total{code="HOLD_SNAPSHOT_MISSING"}`
