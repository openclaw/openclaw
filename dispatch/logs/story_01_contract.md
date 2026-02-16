# STORY-01 Implementation Contract

Timestamp baseline: 2026-02-13 PST
Story: `STORY-01: Implement command endpoints with idempotency`

## Acceptance Criteria Source Summary

Note: this contract file is retained as a legacy-story contract artifact and is included in Sprint 1 governance alignment to preserve decision context while moving to `E#-F#-S#` source-of-truth IDs.

From `dispatch/logs/current_work_item.md`, `dispatch/logs/next_story_recommendation.md` (current planning file of record), and v0 acceptance checklist:

- Every command endpoint must require `Idempotency-Key`.
- Replay with same key + same payload must return same response and must not duplicate mutation effects.
- Same key reused with different payload must return HTTP `409`.
- Invalid transitions must fail closed.
- Successful mutations must emit audit + transition rows.

## Endpoint Scope For This Cycle

Implemented in this cycle:

- `POST /tickets` (`ticket.create`)
- `POST /tickets/{ticketId}/triage` (`ticket.triage`)
- `POST /tickets/{ticketId}/schedule/confirm` (`schedule.confirm`)
- `POST /tickets/{ticketId}/assignment/dispatch` (`assignment.dispatch`)

Deferred from this cycle:

- `POST /tickets/{ticketId}/tech/check-in`
- `POST /tickets/{ticketId}/tech/complete`

Reason for deferral: maintain minimal scope to prove STORY-01 idempotency + mutation enforcement without overscoping beyond P0 acceptance intent.

## Concrete Idempotency Replay Semantics

For each command endpoint, the idempotency keyspace is:

- tuple: `(actor_id, endpoint_template, request_id)` where `request_id == Idempotency-Key`.

Request body hashing:

- canonical JSON (stable key-sorted object representation)
- SHA-256 hash over canonical JSON bytes

Replay behavior:

- If `(actor_id, endpoint_template, request_id)` exists and `request_hash` matches:
  - return exact stored `response_code`
  - return exact stored `response_body`
  - do not mutate ticket/audit/transition tables

Payload mismatch behavior:

- If key tuple exists but `request_hash` differs:
  - return HTTP `409`
  - deterministic error body includes `request_id`
  - message: `Idempotency key reuse with different payload`
  - no mutation side effects

Missing key behavior:

- Missing `Idempotency-Key` returns HTTP `400` with deterministic error body.

## Temporary Auth/Identity Contract (Deterministic Dev Headers)

Until real authn/authz middleware is implemented, command endpoints require:

- `X-Actor-Id`
- `X-Actor-Role`
- optional `X-Tool-Name` (defaults by endpoint)

Fail-closed rules:

- If actor headers are missing: HTTP `400` and no mutation.
- Actor identity values are always written into audit rows.

Isolation note:

- This header-based identity path is explicitly scoped to dev/testing for STORY-01 and must be replaced by authenticated claims in subsequent hardening.

## Emergency Bypass Contract Alignment

`TRIAGED -> DISPATCHED` is permitted only when request payload explicitly includes:

- `dispatch_mode: "EMERGENCY_BYPASS"`

Behavior:

- without explicit bypass reason, `TRIAGED -> DISPATCHED` is rejected.
- bypass reason is captured in audit payload.
- manager-confirmation enforcement is deferred and logged as risk/TODO.
