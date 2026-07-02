---
summary: "Durable team-operation routines backed by OpenClaw cron scheduling"
read_when:
  - You want repeatable digital-employee operating routines
  - You need named ownership, delivery, and status around scheduled work
  - You are choosing between routines, cron jobs, and background tasks
title: "Routines"
sidebarTitle: "Routines"
---

Routines are durable, named operating loops for OpenClaw teams. A routine stores
who owns the work, where the result should go, what trigger starts it, and what
the agent should do when it runs.

The first routine trigger is `schedule`. Schedule-triggered routines delegate
execution to the built-in [cron scheduler](/automation/cron-jobs); routines do
not create a second scheduler. Cron still owns timing, missed-run handling,
run history, and task creation. The routine registry adds a first-class product
record above cron so operators can manage repeatable team operations without
editing raw scheduler jobs.

## Quick start

```bash
openclaw routines create "0 9 * * 1-5" \
  --id "weekday-standup" \
  --name "Weekday standup" \
  --agent ops \
  --message "Review overnight updates and post the top priorities." \
  --announce \
  --channel telegram \
  --to "-1001234567890"
```

```bash
openclaw routines list --all
openclaw routines get weekday-standup
openclaw routines disable weekday-standup
openclaw routines enable weekday-standup
openclaw routines delete weekday-standup
```

## What routines add

| Field                                        | Why it matters                                              |
| -------------------------------------------- | ----------------------------------------------------------- |
| `id`                                         | Stable id for idempotent workflows in the active cron store |
| `name` and `description`                     | Human-readable operating intent                             |
| `owner.agentId` and `owner.sessionKey`       | Agent/session ownership for filtering and handoff           |
| `target.sessionTarget` and `target.delivery` | Where the work runs; completion delivery for message work   |
| `trigger`                                    | Starts the routine; currently `schedule` only               |
| `action`                                     | Cron payload to execute when the trigger fires              |
| `status`                                     | Live backing state: enabled, disabled, running, missing, or drifted |

Repeated `routines.create` calls with the same `id` and same routine intent in
the active cron store are idempotent: OpenClaw returns the existing routine
instead of creating another cron job. Reusing the same id with different intent
in that store is rejected so automation cannot accidentally fork a second
operating loop. When `id` is omitted, OpenClaw derives a stable id from the
normalized routine intent so retrying the same create request remains
idempotent.

## Relationship to cron and tasks

- **Routines** are durable product records for repeatable operating loops.
- **Cron jobs** are the scheduler and executor for `schedule` triggers.
- **Background tasks** are the run ledger created each time cron executes work.

Use `openclaw cron runs --id <cron-job-id>` when you need detailed run history
for the backing schedule. Use `openclaw tasks list --runtime cron` when you need
the cross-runtime task ledger.

## Status and missing backing jobs

Routine list and inspect output includes live cron-derived state:

- `enabled`: backing cron job is enabled.
- `disabled`: backing cron job is disabled.
- `running`: cron is currently executing the backing job.
- `missing`: the routine record exists, but the backing cron job is gone.
- `drifted`: the backing cron job exists but no longer matches the routine intent.

Routine JSON status also includes the backing cron job's last delivery outcome
when a run attempted completion delivery.

`missing` and `drifted` are visible on purpose. They let operators repair or
delete the routine instead of silently losing or changing a team operation.

## Current scope

This initial slice supports CLI and Gateway RPC operations:

- list routines
- inspect one routine
- create a schedule-triggered routine
- enable or disable a routine
- delete a routine and its backing cron job

Channel-watch, repository-event, and webhook triggers fit the same typed trigger
model but are not enabled yet. Control UI management is also deferred; use the
CLI or Gateway RPC methods for now.

## Related

- [Routines CLI](/cli/routines)
- [Scheduled Tasks](/automation/cron-jobs)
- [Background Tasks](/automation/tasks)
- [Automation overview](/automation)
