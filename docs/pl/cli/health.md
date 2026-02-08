---
summary: "Dokumentacja referencyjna CLI dla `openclaw health` (punkt końcowy zdrowia Gateway przez RPC)"
read_when:
  - Chcesz szybko sprawdzić stan działającej Gateway
title: "health"
x-i18n:
  source_path: cli/health.md
  source_hash: 82a78a5a97123f7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:52Z
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
