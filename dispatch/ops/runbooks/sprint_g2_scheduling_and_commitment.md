# Runbook: Sprint G2 Scheduling and Commitment (GLZ-04/05/06)

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

Scope of this run:

- GLZ-04 queue prioritization and dispatch ordering.
- GLZ-05 assignment recommendation and capability/zone match enforcement.
- GLZ-06 customer confirmation hold/release/rollback command chain.

Command-driven lifecycle rule for this sprint:

- `TRIAGED -> READY_TO_SCHEDULE -> SCHEDULE_PROPOSED -> SCHEDULED -> DISPATCHED`
- No DB patching outside command handlers for lifecycle transitions.
- Any policy block must return explicit `error.code`, `error.message`, and caller `correlation_id`.

## 1) State + command matrix

| From state                                              | Command                                        | To state                                     | Required role            | Required tool         |
| ------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------- | ------------------------ | --------------------- |
| `READY_TO_SCHEDULE`                                     | `POST /tickets/{ticketId}/schedule/propose`    | `SCHEDULE_PROPOSED`                          | `dispatcher`, `agent`    | `schedule.propose`    |
| `SCHEDULE_PROPOSED`                                     | `POST /tickets/{ticketId}/schedule/confirm`    | `SCHEDULED`                                  | `dispatcher`, `customer` | `schedule.confirm`    |
| `SCHEDULED`                                             | `POST /tickets/{ticketId}/assignment/dispatch` | `DISPATCHED`                                 | `dispatcher`             | `assignment.dispatch` |
| `READY_TO_SCHEDULE` / `SCHEDULE_PROPOSED` / `SCHEDULED` | `POST /tickets/{ticketId}/schedule/hold`       | `PENDING_CUSTOMER_CONFIRMATION` (hold state) | `dispatcher`             | `schedule.hold`       |
| `PENDING_CUSTOMER_CONFIRMATION`                         | `POST /tickets/{ticketId}/schedule/release`    | prior committed schedule state               | `dispatcher`             | `schedule.release`    |
| `PENDING_CUSTOMER_CONFIRMATION`                         | `POST /tickets/{ticketId}/schedule/rollback`   | prior committed schedule state               | `dispatcher`             | `schedule.rollback`   |

### GLZ-05 recommendation contract (command only)

- `POST /tickets/{ticketId}/assignment/recommend` -> `201` with deterministic ranking snapshot.
- `assignment.dispatch` payload requires immutable recommendation pointer when recommendation was requested in same command sequence.

## 2) Day 1: capacity + policy alignment checklist

- Confirm actor count, command queue throughput, and DB capacity for queue sort + recommendation calls.
- Verify all four tool profiles in policy mapping are synchronized:
  - `dispatch/shared/authorization-policy.mjs`
  - tool bridge bridge policy map
  - `/tickets/{ticketId}` route handlers
  - route-to-policy docs
- Lock failure dimensions and correlation fields in a single incident schema for this sprint:
  - `policy_code`
  - `policy_dimension`
  - `correlation_id`
  - `request_id`
  - `ticket_id`
- Capture risks for:
  - missing technician capability source of truth,
  - region adjacency ambiguity,
  - stale confirmation hold snapshots.

## 3) 15-min cadence (daily)

Use this sequence in every sprint check-in:

1. Blocker list (open command failures, schema conflicts, scheduler drift).
2. Dependency status (`GLZ-04` -> `GLZ-05` -> `GLZ-06`).
3. Evidence captured (new/updated correlation IDs, audit payload samples, transition tables).
4. Alert behavior validation.

Record owner, timestamp, and mitigation owner in `progress_log.md`.

## 4) Mid-sprint sequencing guard

Do not begin GLZ-05 until GLZ-04 proves:

- deterministic queue ordering on equal-priority ties,
- explicit policy failures with reason + `correlation_id`,
- no transition outside matrix.

## 5) Test and observability mapping

### Test cases to map

- `dispatch/tests/story_01_idempotency.node.test.mjs` (assignment path and idempotency)
- `dispatch/tests/mvp_01_api_parity.node.test.mjs` (command lifecycle progression)
- `dispatch/tests/story_05_authorization.node.test.mjs` (policy/permission matrix)
- `dispatch/tests/mvp_06_operability.node.test.mjs` (alerts and sinks)
- `dispatch/tests/story_glz_01_blind_intake.node.test.mjs` for triage->ready transitions feeding scheduling

Additional contracts to add in this sprint:

- `dispatch/tests/story_glz_04_scheduling_queue.node.test.mjs`
- `dispatch/tests/story_glz_05_assignment_recommendation.node.test.mjs`
- `dispatch/tests/story_glz_06_confirmation_hold_chain.node.test.mjs`

### Observability counters

Add/verify following counters on each command path:

- `dispatch_api_errors_total{code="INVALID_STATE_TRANSITION"}`
- `dispatch_api_errors_total{code="TECH_UNAVAILABLE"}`
- `dispatch_api_errors_total{code="ASSIGNMENT_CAPABILITY_MISMATCH"}`
- `dispatch_api_errors_total{code="ASSIGNMENT_ZONE_MISMATCH"}`
- `dispatch_api_errors_total{code="CUSTOMER_CONFIRMATION_STALE"}`
- `dispatch_api_errors_total{code="SCHEDULE_HOLD_STATE_CONFLICT"}`
- `dispatch_api_requests_total{route="/tickets/{ticketId}/assignment/recommend",status="201"}`
- `dispatch_api_requests_total{route="/tickets/{ticketId}/schedule/hold",status="201"}`
- `dispatch_api_requests_total{route="/tickets/{ticketId}/schedule/release",status="200"}`
- `dispatch_api_requests_total{route="/tickets/{ticketId}/schedule/rollback",status="200"}`

Failure thresholds should alert when these codes cross sprint-owned thresholds and map to runbook `Alert` references.

## 6) End-sprint go/no-go

Go if all of the following are true:

- GLZ-04 deterministic queue ordering is proven by contract tests.
- GLZ-05 recommendation and dispatch commands include rejection reason and traceability fields.
- GLZ-06 hold/release/rollback returns explicit failure reason + `correlation_id` for stale/invalid transitions.
- Every successful and blocked lifecycle transition is present in timeline + audit.
- Runbook and alert actions are documented and validated in on-call drill.

No-go if any test gaps are unresolved or counter thresholds are blind spots by day 10 of Sprint G2.
