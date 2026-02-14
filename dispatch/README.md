# Dispatch Product Surface

This directory is the Real Dispatch product scaffold.

## Ownership boundary

- OpenClaw scaffold owns control-plane runtime in `/src`.
- Real Dispatch product logic belongs under `/dispatch`.

## Operator Lifecycle (Phase Model)

`new -> triaged -> schedulable -> scheduled -> dispatched -> onsite -> closeout_pending -> closed`

Detailed dispatch-api enforcement state mapping is defined in:

- `dispatch/contracts/case-lifecycle-v1.md`

## Closed dispatch action surface

- `ticket.create`
- `ticket.blind_intake`
- `ticket.triage`
- `schedule.propose`
- `schedule.confirm`
- `assignment.dispatch`
- `tech.check_in`
- `tech.request_change`
- `approval.decide`
- `closeout.add_evidence`
- `tech.complete`
- `qa.verify`
- `billing.generate_invoice`
- `ticket.get`
- `closeout.list_evidence`
- `ticket.timeline`
- `dispatcher.cockpit`
- `tech.job_packet`

## Directory map

- `contracts/` canonical lifecycle, schema, and event contracts
- `api/` dispatch-api service scaffold (source-of-truth case mutations)
- `tools-plugin/` OpenClaw plugin bridge exposing only closed dispatch actions
- `workflow-engine/` role and rules orchestration for intake/scheduling/liaison/closeout
- `worker/` timers, follow-ups, retries, packet/invoice jobs
- `policy/` autonomy ladder, role permissions, SOP lock-ins
- `analytics/` KPIs and autonomy promotion gates
- `e2e/` end-to-end lifecycle tests
- `ops/` deployment and local topology definitions
