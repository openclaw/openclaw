---
summary: "Compatibility note for older ClawFlow references in release notes and docs"
read_when:
  - You encounter ClawFlow or openclaw flows in older release notes or docs
  - You want to understand what ClawFlow terminology maps to in the current CLI
  - You want to translate older flow references into the supported task commands
title: "ClawFlow"
---

# ClawFlow

`ClawFlow` appears in some older OpenClaw release notes and documentation as if it were a user-facing runtime with its own `openclaw flows` command surface.

That is not the current operator-facing surface in this repository.

Today, the supported CLI surface for inspecting and managing detached work is [`openclaw tasks`](/automation/tasks).

## What to use today

- `openclaw tasks list` shows tracked detached runs
- `openclaw tasks show <lookup>` shows one task by task id, run id, or session key
- `openclaw tasks cancel <lookup>` cancels a running task
- `openclaw tasks audit` surfaces stale or broken task runs

```bash
openclaw tasks list
openclaw tasks show <lookup>
openclaw tasks cancel <lookup>
```

## What this means for older references

If you see `ClawFlow` or `openclaw flows` in:

- old release notes
- issue threads
- stale search results
- outdated local notes

translate those instructions to the current task CLI:

- `openclaw flows list` -> `openclaw tasks list`
- `openclaw flows show <lookup>` -> `openclaw tasks show <lookup>`
- `openclaw flows cancel <lookup>` -> `openclaw tasks cancel <lookup>`

## Related

- [Background Tasks](/automation/tasks) — detached work ledger
- [CLI: flows](/cli/flows) — compatibility note for the mistaken command name
- [Cron Jobs](/automation/cron-jobs) — scheduled jobs that may create tasks
