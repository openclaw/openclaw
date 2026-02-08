---
summary: "CLI-reference for `openclaw logs` (følg Gateway-logge via RPC)"
read_when:
  - Du har brug for at følge Gateway-logge eksternt (uden SSH)
  - Du vil have JSON-loglinjer til værktøjer
title: "logs"
x-i18n:
  source_path: cli/logs.md
  source_hash: 911a57f0f3b78412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:03Z
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
