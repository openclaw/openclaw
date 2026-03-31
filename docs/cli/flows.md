---
summary: "CLI reference for `openclaw flows` (list, inspect, cancel)"
read_when:
  - You want to inspect or cancel a flow
  - You want to see how background tasks roll up into a higher-level job
title: "flows"
---

# `openclaw flows`

Inspect and manage [ClawFlow](/automation/clawflow) jobs.

```bash
openclaw flows list
openclaw flows show <lookup>
openclaw flows cancel <lookup>
```

## Commands

### `flows list`

List tracked flows and their task counts.

```bash
openclaw flows list
openclaw flows list --status blocked
openclaw flows list --json
```

### `flows show`

Show one flow by flow id or owner session key.

```bash
openclaw flows show <lookup>
openclaw flows show <lookup> --json
```

The output includes the flow status, current step, blocked summary when present, and linked tasks.

### `flows cancel`

Cancel a flow and any active child tasks.

```bash
openclaw flows cancel <lookup>
```

## Related

- [ClawFlow](/automation/clawflow) — job-level orchestration above tasks
- [Background Tasks](/automation/tasks) — detached work ledger
- [CLI reference](/cli/index) — full command tree
