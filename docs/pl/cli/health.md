---
summary: "Dokumentacja referencyjna CLI dla `openclaw health` (punkt końcowy zdrowia Gateway przez RPC)"
read_when:
  - Chcesz szybko sprawdzić stan działającej Gateway
title: "health"
---

# `openclaw health`

Pobiera informacje o stanie zdrowia z działającej Gateway.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

Uwagi:

- `--verbose` uruchamia sondy na żywo i wyświetla czasy dla poszczególnych kont, gdy skonfigurowano wiele kont.
- Wyjście zawiera magazyny sesji na agenta, gdy skonfigurowano wielu agentów.
