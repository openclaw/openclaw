---
summary: "CLI reference for `openclaw logs` (tail gateway logs via RPC)"
read_when:
  - You need to tail Gateway logs remotely (without SSH)
  - You want JSON log lines for tooling
title: "logs"
---

# `openclaw logs`

Tail Gateway file logs over RPC (works in remote mode).

Related:

- Logging overview: [Logging](/logging)

## Examples

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --follow --human
openclaw logs --follow --human-full
openclaw logs --limit 500
openclaw logs --local-time
openclaw logs --follow --local-time
```

Use `--local-time` to render timestamps in your local timezone.

Use `--human` for activity timeline output and `--human-full` to include
internal IDs/details (for deep debugging).

`--human` and `--human-full` are text render modes and cannot be combined with
`--json`.
