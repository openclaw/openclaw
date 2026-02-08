---
summary: "CLI-Referenz für `openclaw health` (Gateway-Gesundheitsendpunkt über RPC)"
read_when:
  - Sie möchten die Gesundheit des laufenden Gateways schnell prüfen
title: "Gesundheit"
x-i18n:
  source_path: cli/health.md
  source_hash: 82a78a5a97123f7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:35:35Z
---

# `openclaw health`

Ruft den Gesundheitsstatus vom laufenden Gateway ab.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

Hinweise:

- `--verbose` führt Live-Probes aus und gibt bei mehreren konfigurierten Konten zeitliche Messwerte pro Konto aus.
- Die Ausgabe enthält Sitzungsspeicher pro Agent, wenn mehrere Agenten konfiguriert sind.
