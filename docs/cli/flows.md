---
summary: "Compatibility note for the mistakenly documented `openclaw flows` command"
read_when:
  - You want to inspect or cancel a flow
  - You want to see how background tasks roll up into a higher-level job
title: "flows"
---

# `openclaw flows`

`openclaw flows` is **not** a current OpenClaw CLI command.

Some older release notes and docs mistakenly documented a `flows` command surface. The supported operator surface is [`openclaw tasks`](/automation/tasks).

```bash
openclaw tasks list
openclaw tasks show <lookup>
openclaw tasks cancel <lookup>
```

## Use instead

- `openclaw tasks list` — list tracked background tasks
- `openclaw tasks show <lookup>` — inspect one task by task id, run id, or session key
- `openclaw tasks cancel <lookup>` — cancel a running background task
- `openclaw tasks notify <lookup> <policy>` — change task notification behavior
- `openclaw tasks audit` — surface stale or broken task runs

## Why this page exists

This page stays in place so existing links from older changelog entries, issue threads, and search results have a clear correction instead of a dead end.

## Related

- [Background Tasks](/automation/tasks) — detached work ledger
- [CLI reference](/cli/index) — full command tree
