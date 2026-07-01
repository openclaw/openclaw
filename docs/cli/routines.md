---
summary: "CLI reference for `openclaw routines` durable operating routines"
read_when:
  - You want to create or inspect a durable routine from the CLI
  - You need idempotent schedule-backed team operations
title: "`openclaw routines`"
---

# `openclaw routines`

Manage durable team-operation routines through the Gateway.

<Tip>
See [Routines](/automation/routines) for the conceptual guide. Schedule-triggered
routines use the same scheduler, delivery modes, and run history as
[cron jobs](/automation/cron-jobs).
</Tip>

## Usage

```bash
openclaw routines list [--all] [--agent <id>] [--query <text>] [--json]
openclaw routines get <id> [--json]
openclaw routines create <schedule> <message> --name <name> [options]
openclaw routines enable <id> [--json]
openclaw routines disable <id> [--json]
openclaw routines delete <id> [--json]
```

`create` is also available as `add`. `get` is also available as `show`.
`delete` is also available as `rm`.

## Create

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

Schedule flags match `openclaw cron create`:

```bash
openclaw routines create --at "+20m" \
  --name "Deployment follow-up" \
  --session main \
  --system-event "Check deployment status."

openclaw routines create --every "30m" \
  --name "Inbox triage" \
  --agent ops \
  --message "Review inbound items and flag blockers."

openclaw routines create --cron "0 18 * * 1-5" --tz America/Los_Angeles \
  --name "End-of-day digest" \
  --agent ops \
  --message "Summarize the day's completed and blocked work."
```

### Options

| Option                  | Description                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `--id <id>`             | Stable id for idempotent create                              |
| `--name <name>`         | Human-readable routine name                                  |
| `--description <text>`  | Optional description                                         |
| `--disabled`            | Create the routine disabled                                  |
| `--agent <id>`          | Owner agent id                                               |
| `--session-key <key>`   | Owner session key                                            |
| `--session <target>`    | Run target: `main`, `isolated`, `current`, or `session:<id>` |
| `--wake <mode>`         | `now` or `next-heartbeat`                                    |
| `--system-event <text>` | Main-session system event payload                            |
| `--message <text>`      | Isolated/current/custom-session agent message                |
| `--announce`            | Fallback-deliver final text to a chat                        |
| `--no-deliver`          | Disable runner fallback delivery                             |
| `--webhook <url>`       | POST the finished payload to a webhook URL                   |
| `--channel <channel>`   | Delivery channel                                             |
| `--to <dest>`           | Delivery destination                                         |
| `--thread-id <id>`      | Telegram forum topic thread id                               |
| `--account <id>`        | Channel account id for delivery                              |
| `--json`                | Output JSON                                                  |

Main-session routines require `--system-event`. Isolated, current, and custom
session routines require `--message`.

## Idempotency

Pass `--id` when scripts may retry creation:

```bash
openclaw routines create --id "weekday-standup" ...
```

If the same id and same routine intent already exist, OpenClaw returns the
existing routine and does not create another cron job. If the id exists with
different intent, creation fails.

## Inspect

```bash
openclaw routines list --all
openclaw routines get weekday-standup --json
```

List output shows the routine status, next run, last run, schedule, and name.
`get --json` includes the backing cron job id under `trigger.cronJobId`.

## Enable, disable, delete

```bash
openclaw routines disable weekday-standup
openclaw routines enable weekday-standup
openclaw routines delete weekday-standup
```

Enable and disable update the backing cron job. Delete removes the backing cron
job before removing the routine record; if cron removal fails, the routine stays
registered so the delete can be retried. Repeating delete on an absent routine
returns a successful no-op result in JSON.

## Related

- [Routines](/automation/routines)
- [Cron CLI](/cli/cron)
- [Tasks CLI](/cli/tasks)
