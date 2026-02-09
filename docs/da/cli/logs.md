---
summary: "CLI-reference for `openclaw logs` (følg Gateway-logge via RPC)"
read_when:
  - Du har brug for at følge Gateway-logge eksternt (uden SSH)
  - Du vil have JSON-loglinjer til værktøjer
title: "logs"
---

# `openclaw logs`

Følg Gateways logfiler via RPC (virker i fjern-tilstand).

Relateret:

- Overblik over logning: [Logging](/logging)

## Eksempler

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
