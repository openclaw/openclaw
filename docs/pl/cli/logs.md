---
summary: "Dokumentacja referencyjna CLI dla `openclaw logs` (śledzenie logów Gateway przez RPC)"
read_when:
  - Musisz śledzić logi Gateway zdalnie (bez SSH)
  - Chcesz otrzymywać linie logów w formacie JSON do narzędzi
title: "logs"
---

# `openclaw logs`

Śledzenie logów plików Gateway przez RPC (działa w trybie zdalnym).

Powiązane:

- Przegląd logowania: [Logging](/logging)

## Przykłady

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
