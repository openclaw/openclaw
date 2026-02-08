---
summary: "CLI-referentie voor `openclaw logs` (Gateway-logs tailen via RPC)"
read_when:
  - Je Gateway-logs op afstand wilt tailen (zonder SSH)
  - Je JSON-logregels wilt voor tooling
title: "logs"
x-i18n:
  source_path: cli/logs.md
  source_hash: 911a57f0f3b78412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:08Z
---

# `openclaw logs`

Gateway-bestandslogs tailen via RPC (werkt in de modus op afstand).

Gerelateerd:

- Logoverzicht: [Logging](/logging)

## Voorbeelden

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
