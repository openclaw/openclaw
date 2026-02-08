---
summary: "CLI-Referenz für `openclaw reset` (lokalen Status/Konfiguration zurücksetzen)"
read_when:
  - Sie möchten den lokalen Status löschen und die CLI installiert lassen
  - Sie möchten einen Probelauf (Dry-Run), um zu sehen, was entfernt würde
title: "zurücksetzen"
x-i18n:
  source_path: cli/reset.md
  source_hash: 08afed5830f892e0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:35:40Z
---

# `openclaw reset`

Lokale Konfiguration/Status zurücksetzen (die CLI bleibt installiert).

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
