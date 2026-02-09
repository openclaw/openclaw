---
summary: "CLI-referens för `openclaw logs` (följa Gateway-loggar via RPC)"
read_when:
  - Du behöver följa Gateway-loggar på distans (utan SSH)
  - Du vill ha JSON-loggrader för verktyg
title: "loggar"
---

# `openclaw logs`

Följ Gateway-fil-loggar via RPC (fungerar i fjärrläge).

Relaterat:

- Loggningsöversikt: [Logging](/logging)

## Exempel

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
