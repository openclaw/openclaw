---
summary: "Task Flow flow orchestration layer above background tasks"
read_when:
  - You want to understand how Task Flow relates to background tasks
  - You encounter Task Flow or openclaw tasks flow in release notes or docs
  - You want to inspect or manage durable flow state
title: "Task Flow"
---

# Task Flow

Task Flow is the flow orchestration substrate that sits above [background tasks](/automation/tasks). It manages durable multi-step flows with their own state, revision tracking, and sync semantics while individual tasks remain the unit of detached work.

## Sync modes

Task Flow supports two sync modes:

- **Managed** — Task Flow owns the lifecycle end-to-end, creating and driving tasks as flow steps progress.
- **Mirrored** — Task Flow observes externally created tasks and keeps flow state in sync without taking ownership of task creation.

## Durable state and revision tracking

Each flow persists its own state and tracks revisions so progress survives gateway restarts. Revision tracking enables conflict detection when multiple sources attempt to advance the same flow.

## CLI commands

```bash
# List active and recent flows
openclaw tasks flow list

# Show details for a specific flow
openclaw tasks flow show <lookup>

# Cancel a running flow
openclaw tasks flow cancel <lookup>
```

- `openclaw tasks flow list` — shows tracked flows with status and sync mode
- `openclaw tasks flow show <lookup>` — inspect one flow by flow id or lookup key
- `openclaw tasks flow cancel <lookup>` — cancel a running flow and its active tasks

## How flows relate to tasks

Flows coordinate tasks, not replace them. A single flow may drive multiple background tasks over its lifetime. Use `openclaw tasks` to inspect individual task records and `openclaw tasks flow` to inspect the orchestrating flow.

## Related

- [Background Tasks](/automation/tasks) — the detached work ledger that flows coordinate
- [CLI: tasks](/cli/index#tasks) — CLI command reference for `openclaw tasks flow`
- [Automation Overview](/automation) — all automation mechanisms at a glance
- [Cron Jobs](/automation/cron-jobs) — scheduled jobs that may feed into flows
