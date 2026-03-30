---
summary: "Background task tracking for ACP runs, subagents, isolated cron jobs, and CLI operations"
read_when:
  - Inspecting background work in progress or recently completed
  - Debugging delivery failures for detached agent runs
  - Understanding how background runs relate to sessions, cron, and heartbeat
title: "Background Tasks"
---

# Background Tasks

Background tasks track work that runs **outside your main conversation session**: ACP runs, subagent spawns, isolated cron job executions, and CLI-initiated operations.

<Note>
Not every agent run creates a task. Heartbeat turns and main-session cron reminders stay in main-session history. Only **detached** work (isolated cron, ACP, subagents, CLI operations) appears in the task ledger.
</Note>

## Quick start

```bash
# List all tasks (newest first)
openclaw tasks list

# Show details for a specific task
openclaw tasks show <task-id>

# Cancel a running task
openclaw tasks cancel <task-id>

# Change notification policy
openclaw tasks notify <task-id> state_changes

# Run a health audit
openclaw tasks audit
```

## What creates a task

| Source                 | Runtime    | When a task is created                                                     |
| ---------------------- | ---------- | -------------------------------------------------------------------------- |
| ACP background runs    | `acp`      | Spawning a child ACP session                                               |
| Subagent orchestration | `subagent` | Spawning a subagent via `sessions_spawn`                                   |
| Isolated cron jobs     | `cron`     | Each execution of a `sessionTarget: "isolated"` or custom-session cron job |
| CLI operations         | `cli`      | Background CLI commands that run through the gateway                       |

**Not tracked as tasks:**

- Heartbeat turns (main-session; see [Heartbeat](/gateway/heartbeat))
- Main-session cron reminders (`sessionTarget: "main"`; see [Cron Jobs](/automation/cron-jobs))
- Normal interactive chat turns

## Task lifecycle

```
queued ──→ running ──→ succeeded
                   ├──→ failed
                   ├──→ timed_out
                   └──→ cancelled

           (any active state) ──→ lost
```

| Status      | Meaning                                                              |
| ----------- | -------------------------------------------------------------------- |
| `queued`    | Created, waiting to start                                            |
| `running`   | Actively executing                                                   |
| `succeeded` | Completed successfully                                               |
| `failed`    | Completed with an error                                              |
| `timed_out` | Exceeded the configured timeout                                      |
| `cancelled` | Cancelled by the operator (`openclaw tasks cancel`)                  |
| `lost`      | Backing session disappeared (detected after a 5-minute grace period) |

Tasks automatically transition from `running` to their terminal state when the associated agent run ends.

## Delivery and notifications

When a task finishes, OpenClaw can notify you through two mechanisms:

### Direct delivery

If the task has a `requesterOrigin` (channel target), the completion message is delivered directly to that channel (Telegram, Discord, Slack, etc.).

### Session-queued delivery

If direct delivery fails or no origin is set, the update is queued as a system event in the requester session and delivered on the next heartbeat.

### Notification policies

Control how much you hear about a task:

| Policy                | Behavior                                             |
| --------------------- | ---------------------------------------------------- |
| `done_only` (default) | Notify only when the task reaches a terminal state   |
| `state_changes`       | Notify on every state transition and progress update |
| `silent`              | No notifications at all                              |

Change the policy for a running task:

```bash
openclaw tasks notify <task-id> state_changes
```

## Inspecting tasks

### List all tasks

```bash
openclaw tasks list
```

Output columns: Task ID, Kind (runtime), Status, Delivery status, Run ID, Child Session, Summary.

Filter by runtime or status:

```bash
openclaw tasks list --runtime acp
openclaw tasks list --status running
openclaw tasks list --json
```

### Show task details

```bash
openclaw tasks show <lookup>
```

The lookup token can be a task ID, run ID, or session key. Shows full task record including timing, delivery state, and terminal summary.

### Cancel a task

```bash
openclaw tasks cancel <lookup>
```

For ACP and subagent tasks, this kills the child session. The task status transitions to `cancelled`.

## Task audit

The audit surfaces operational issues with background tasks:

```bash
openclaw tasks audit
openclaw tasks audit --json
```

| Finding                   | Severity | Condition                                         |
| ------------------------- | -------- | ------------------------------------------------- |
| `stale_queued`            | warn     | Queued for more than 10 minutes                   |
| `stale_running`           | error    | Running for more than 30 minutes                  |
| `lost`                    | error    | Status is `lost` (backing session gone)           |
| `delivery_failed`         | warn     | Delivery failed and notify policy is not `silent` |
| `missing_cleanup`         | warn     | Terminal but no cleanup timestamp set             |
| `inconsistent_timestamps` | warn     | Timeline violations (ended before started, etc.)  |

Task audit findings also appear in `openclaw status` output when issues are detected.

## Task pressure (status integration)

The task system reports an "at a glance" summary in `openclaw status`:

```
Tasks: 3 queued · 2 running · 1 issues
```

This includes:

- **active**: count of `queued` + `running` tasks
- **failures**: count of `failed` + `timed_out` + `lost` tasks
- **byRuntime**: breakdown by `acp`, `subagent`, `cron`, `cli`

## Storage and maintenance

### Where tasks are stored

Task records persist in SQLite at `$OPENCLAW_STATE_DIR/tasks/runs.sqlite`. The registry loads into memory at gateway start and syncs writes to SQLite for durability across restarts.

### Automatic cleanup

A maintenance sweeper runs every 60 seconds:

1. **Reconciliation**: checks if active tasks' backing sessions still exist. If a session is gone for more than 5 minutes, the task is marked `lost`.
2. **Cleanup stamping**: terminal tasks get a `cleanupAfter` timestamp set to 7 days after completion.
3. **Pruning**: records past their `cleanupAfter` are deleted.

**Retention**: terminal task records are kept for **7 days** for historical inspection, then automatically pruned.

## How tasks relate to other systems

### Tasks and cron

- A cron job **definition** lives in `~/.openclaw/cron/jobs.json`.
- Each **execution** of an isolated cron job creates a task record.
- Main-session cron jobs (`sessionTarget: "main"`) do **not** create task records.
- See [Cron Jobs](/automation/cron-jobs) for scheduling and [Cron vs Heartbeat](/automation/cron-vs-heartbeat) for choosing the right mechanism.

### Tasks and heartbeat

- Heartbeat runs are main-session turns — they do **not** create task records.
- When a detached task completes, it can enqueue a system event and trigger an immediate heartbeat wake so you see the result quickly.
- See [Heartbeat](/gateway/heartbeat) for configuration.

### Tasks and sessions

- A task may have an associated `childSessionKey` (the session where work happens).
- The `requesterSessionKey` identifies who initiated the task (the parent session).
- Sessions are conversation context; tasks are activity tracking records.

### Tasks and agent runs

- A task's `runId` links to the agent run executing the work.
- Agent lifecycle events (start, end, error) automatically update task status.

## Related

- [Cron Jobs](/automation/cron-jobs) — scheduling background work
- [Cron vs Heartbeat](/automation/cron-vs-heartbeat) — choosing the right mechanism
- [Heartbeat](/gateway/heartbeat) — periodic main-session turns
- [CLI: Tasks](/cli/index#tasks) — CLI command reference
