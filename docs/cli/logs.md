---
summary: "CLI reference for `smart-agent-neo logs` (tail gateway logs via RPC)"
read_when:
  - You need to tail Gateway logs remotely (without SSH)
  - You want JSON log lines for tooling
title: "logs"
---

# `smart-agent-neo logs`

Tail Gateway file logs over RPC (works in remote mode).

Related:

- Logging overview: [Logging](/logging)

## Examples

```bash
smart-agent-neo logs
smart-agent-neo logs --follow
smart-agent-neo logs --json
smart-agent-neo logs --limit 500
smart-agent-neo logs --local-time
smart-agent-neo logs --follow --local-time
```

Use `--local-time` to render timestamps in your local timezone.
