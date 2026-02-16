# Runbook: Stuck Scheduling

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

Alert code: `STUCK_SCHEDULING`

## Signal

- `GET /ops/alerts` includes `STUCK_SCHEDULING`.
- `signals.stuck_scheduling_count >= thresholds.stuck_scheduling_count`.

## Triage

1. Confirm alert payload:
   - `curl -s http://127.0.0.1:8080/ops/alerts`
2. Inspect queue states:
   - query tickets in `READY_TO_SCHEDULE`, `SCHEDULE_PROPOSED`, `SCHEDULED`.
3. Validate transition recency:
   - inspect latest `ticket_state_transitions.created_at` for impacted tickets.

## Remediation

1. If assignment gap: execute `assignment.dispatch` on schedulable items.
2. If customer confirmation gap: execute `schedule.confirm` or reroute via follow-up workflow.
3. If policy blocking: review `FORBIDDEN`/`TOOL_NOT_ALLOWED` events in durable log sink.

## Exit Criteria

- `STUCK_SCHEDULING` alert no longer present.
- Follow-up mutation/audit events confirm queue drain.
