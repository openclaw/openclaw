---
summary: "CLI-referens för `openclaw logs` (följa Gateway-loggar via RPC)"
read_when:
  - Du behöver följa Gateway-loggar på distans (utan SSH)
  - Du vill ha JSON-loggrader för verktyg
title: "loggar"
x-i18n:
  source_path: cli/logs.md
  source_hash: 911a57f0f3b78412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:39Z
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
