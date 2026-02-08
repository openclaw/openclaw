---
summary: "CLI-reference for `openclaw reset` (nulstil lokal tilstand/konfiguration)"
read_when:
  - Du vil rydde lokal tilstand, mens CLI'en forbliver installeret
  - Du vil have en dry-run af, hvad der ville blive fjernet
title: "reset"
x-i18n:
  source_path: cli/reset.md
  source_hash: 08afed5830f892e0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:04Z
---

# `openclaw reset`

Nulstil lokal konfiguration/tilstand (beholder CLI'en installeret).

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
