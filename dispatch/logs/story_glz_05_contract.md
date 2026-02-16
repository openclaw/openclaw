# GLZ-05 Contract: Assignment recommendation + capability/zone matching

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

Timestamp baseline: 2026-02-14 PST
Story: `GLZ-05: Assignment recommendation and assignment dispatch readiness`

## Goal

Provide deterministic, policy-safe assignment recommendation and selection using technician capability and zone constraints.

## Command contracts

### 1) Recommendation command

`POST /tickets/{ticketId}/assignment/recommend`

Required headers:

- `Idempotency-Key`
- actor headers used by command runtime (`X-Actor-Id`, `X-Actor-Role`)
- optional `X-Tool-Name` defaulting to `assignment.recommend`

Required payload:

- `service_type` (string)
- `preferred_window` with `{"start":"...","end":"..."}`

Response (`201`):

- `recommendations`: ordered array of candidates:
  - `tech_id`
  - `tech_name`
  - `score` (numeric deterministic)
  - `matches` (`capability`, `zone`, `active_load`, `distance_bucket`)
- `snapshot_id`
- `evaluated_at`

### 2) Dispatch command

`POST /tickets/{ticketId}/assignment/dispatch`

Required payload fields for GLZ-05:

- `tech_id`
- optional `recommendation_snapshot_id`

Dispatch remains `SCHEDULED -> DISPATCHED` only in Sprint G2.

## Recommendation ranking

Deterministic scoring components:

1. Incident capability fit
2. Zone/region fit
3. Open load score
4. Recent completion quality signal
5. deterministic UUID fallback (`tech_id` lexical)

No candidate passes are persisted as assignment unless `assignment.dispatch` succeeds.

## Failure contract

Expected policy failures:

- `ASSIGNMENT_NOT_FOUND`
- `ASSIGNMENT_CAPABILITY_MISMATCH`
- `ASSIGNMENT_ZONE_MISMATCH`
- `TECH_UNAVAILABLE`
- `INVALID_STATE_TRANSITION`

Every failure must include `correlation_id` and `recommendation_snapshot_id` where available.

## Audit/timeline requirements

- Recommendation call writes immutable audit event (`assignment.recommend`) with request context.
- Dispatch call writes immutable transition to `DISPATCHED` with chosen `tech_id` and source recommendation snapshot.
- No state writes occur in recommendation-only path.

## Tests to add

- `dispatch/tests/story_glz_05_assignment_recommendation.node.test.mjs`
  - deterministic candidate ordering
  - capability/zone rejection path
  - mismatch between selected tech and recommendation snapshot
  - blocked dispatch when state/role policy does not permit

## Observability hooks

- Add recommendation counters:
  - `dispatch_api_requests_total{route="/tickets/{ticketId}/assignment/recommend",status="200"}`
  - `dispatch_api_errors_total{code="ASSIGNMENT_NOT_FOUND"}`
  - `dispatch_api_errors_total{code="ASSIGNMENT_CAPABILITY_MISMATCH"}`
  - `dispatch_api_errors_total{code="ASSIGNMENT_ZONE_MISMATCH"}`
- Track dispatch success with recommendation provenance:
  - `dispatch_api_requests_total{route="/tickets/{ticketId}/assignment/dispatch",status="200"}`
  - `dispatch_assignments_with_snapshot_total`
  - `dispatch_assignments_without_snapshot_total`
