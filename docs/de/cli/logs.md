---
summary: "CLI-Referenz für `openclaw logs` (Gateway-Logs per RPC verfolgen)"
read_when:
  - Sie müssen Gateway-Logs remote verfolgen (ohne SSH)
  - Sie möchten JSON-Logzeilen für Tools
title: "Logs"
x-i18n:
  source_path: cli/logs.md
  source_hash: 911a57f0f3b78412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:35:39Z
---

# `openclaw logs`

Gateway-Datei-Logs per RPC verfolgen (funktioniert im Remote-Modus).

Verwandt:

- Logging-Überblick: [Logging](/logging)

## Beispiele

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
