---
summary: "Dokumentacja referencyjna CLI dla `openclaw logs` (śledzenie logów Gateway przez RPC)"
read_when:
  - Musisz śledzić logi Gateway zdalnie (bez SSH)
  - Chcesz otrzymywać linie logów w formacie JSON do narzędzi
title: "logs"
x-i18n:
  source_path: cli/logs.md
  source_hash: 911a57f0f3b78412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:51Z
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
