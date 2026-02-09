---
summary: "CLI-referentie voor `openclaw health` (Gateway health-endpoint via RPC)"
read_when:
  - Je wilt snel de health van de draaiende Gateway controleren
title: "health"
---

# `openclaw health`

Haal de health op van de draaiende Gateway.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

Notities:

- `--verbose` voert live probes uit en print per account timinggegevens wanneer meerdere accounts zijn geconfigureerd.
- De uitvoer bevat per agent sessie-opslag wanneer meerdere agents zijn geconfigureerd.
