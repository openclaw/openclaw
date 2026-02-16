# GLZ-04 Contract: Dispatch queue prioritization

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

Timestamp baseline: 2026-02-14 PST
Story: `GLZ-04: Dispatch queue prioritization and ordering`

## Goal

Sort queue entries deterministically by urgency, SLA, and region while preserving immutable command history.

## Inputs

Each candidate row used by queue projection requires:

- `priority` (`EMERGENCY`, `URGENT`, `ROUTINE`)
- `scheduled_start` (if present)
- `state` (`READY_TO_SCHEDULE`, `SCHEDULE_PROPOSED`, `SCHEDULED`)
- `site.region`
- `created_at`, `updated_at`
- `ticket_id`

## Deterministic order

For each scheduling state set, sort with stable tie-breakers in this order:

1. `sla_status` (`breach` < `warning` < `healthy`)
2. `sla_timer_remaining_minutes` ascending
3. `priority` (`EMERGENCY` < `URGENT` < `ROUTINE`)
4. `region_weight` ascending (lower risk/geo-penalty first)
5. `last_update_at` descending
6. `ticket_id`

Emergency incidents always sort ahead due to SLA/priority precedence.

## State path and command guardrail

All dispatch progress in Sprint G2 must pass only these matrix transitions:

- `TRIAGED -> READY_TO_SCHEDULE`
- `READY_TO_SCHEDULE -> SCHEDULE_PROPOSED`
- `SCHEDULE_PROPOSED -> SCHEDULED`
- `SCHEDULED -> DISPATCHED`

Direct mutations to `TRIAGED -> DISPATCHED` are blocked by this sprint rule.

## API / commands in scope

- `POST /tickets/{ticketId}/schedule/propose` (`schedule.propose`)
- `POST /tickets/{ticketId}/schedule/confirm` (`schedule.confirm`)
- `POST /tickets/{ticketId}/assignment/dispatch` (`assignment.dispatch`)

## Failure contract (GLZ-04)

Blocked transitions must include:

- `error.code`:
  - `INVALID_STATE_TRANSITION`
  - `QUEUE_PRIORITY_UNRESOLVABLE`
  - `SLA_CALCULATION_ERROR`
- `error.message`
- `error.correlation_id`

## Audit/timeline requirements

- Reordered queue snapshots and recommendation ordering must not mutate ticket state.
- Any transition triggered in this chain writes both `audit_events` and `ticket_state_transitions` rows with actor, role, tool, correlation, and request id.

## Tests to add

- `dispatch/tests/story_glz_04_scheduling_queue.node.test.mjs` for:
  - deterministic sort across all tie-breakers,
  - stable tie on equal priorities,
  - emergency and SLA breach ordering,
  - explicit reason on blocked bypass attempts.

## Observability hooks

Ensure counters increment at least for:

- `dispatch_api_requests_total` for `schedule.propose` / `schedule.confirm`.
- `dispatch_api_errors_total{code="INVALID_STATE_TRANSITION"}` with `route="/tickets/{ticketId}/assignment/dispatch"`.
- `transitions_total{from_state="READY_TO_SCHEDULE",to_state="SCHEDULE_PROPOSED"}`
- `transitions_total{from_state="SCHEDULE_PROPOSED",to_state="SCHEDULED"}`
- `transitions_total{from_state="SCHEDULED",to_state="DISPATCHED"}`
