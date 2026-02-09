---
name: workqueue-worker
description: Run a simple workqueue worker loop (claim via clawnsole, execute via `openclaw agent`, report done/fail).
metadata:
  {
    "openclaw":
      {
        "emoji": "🧰",
        "requires": { "bins": ["clawnsole", "openclaw"] }
      }
  }
---

# workqueue-worker

This skill provides a CLI-based worker loop that:

1. Claims the next work item from a workqueue via `clawnsole workqueue claim-next`.
2. Executes the item’s `instructions` using `openclaw agent` in a dedicated session id.
3. Reports `progress`, then `done` or `fail` back to the workqueue.

## Requirements

- `clawnsole` CLI available on your PATH.
- `openclaw` CLI available on your PATH and able to reach your Gateway.

## Command

- Run one iteration (claim once, execute once, exit):

  - `openclaw workqueue-worker --agent dev --queues dev-team`

## Common flags

- `--leaseMs <ms>`: item lease duration (default 900000)
- `--idleMs <ms>`: if empty queue, sleep then exit (default 0)
- `--sessionPrefix <prefix>`: session id prefix for executions (default `workqueue:`)
- `--gateway-url <url>` / `--gateway-token <token>`: pass-through to `openclaw agent`
- `--thinking <level>` / `--timeoutSeconds <n>`: pass-through to `openclaw agent`
- `--dry-run --json`: claim and print what would run, without executing

## Notes

- This command is intentionally simple (single-iteration) so you can wrap it in `cron`, `launchd`, systemd timers, or a shell `while true` loop.
- The worker uses `openclaw agent --agent <id> --session-id <prefix><itemId>` so each work item gets an isolated conversation thread.
