---
summary: "CLI reference for `evox logs` (tail gateway logs via RPC)"
read_when:
  - You need to tail Gateway logs remotely (without SSH)
  - You want JSON log lines for tooling
title: "logs"
---

# `evox logs`

Tail Gateway file logs over RPC (works in remote mode).

Related:

- Logging overview: [Logging](/logging)

## Examples

```bash
evox logs
evox logs --follow
evox logs --json
evox logs --limit 500
evox logs --local-time
evox logs --follow --local-time
```

Use `--local-time` to render timestamps in your local timezone.
