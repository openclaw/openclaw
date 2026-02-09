---
summary: "CLI reference for `EasyHub logs` (tail gateway logs via RPC)"
read_when:
  - You need to tail Gateway logs remotely (without SSH)
  - You want JSON log lines for tooling
title: "logs"
---

# `EasyHub logs`

Tail Gateway file logs over RPC (works in remote mode).

Related:

- Logging overview: [Logging](/logging)

## Examples

```bash
EasyHub logs
EasyHub logs --follow
EasyHub logs --json
EasyHub logs --limit 500
```
