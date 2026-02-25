---
summary: "CLI reference for `activi logs` (tail gateway logs via RPC)"
read_when:
  - You need to tail Gateway logs remotely (without SSH)
  - You want JSON log lines for tooling
title: "logs"
---

# `activi logs`

Tail Gateway file logs over RPC (works in remote mode).

Related:

- Logging overview: [Logging](/logging)

## Examples

```bash
activi logs
activi logs --follow
activi logs --json
activi logs --limit 500
activi logs --local-time
activi logs --follow --local-time
```

Use `--local-time` to render timestamps in your local timezone.
