---
summary: "CLI-referentie voor `openclaw reset` (lokale status/configuratie resetten)"
read_when:
  - Je wilt de lokale status wissen terwijl de CLI geïnstalleerd blijft
  - Je wilt een dry-run van wat er zou worden verwijderd
title: "reset"
x-i18n:
  source_path: cli/reset.md
  source_hash: 08afed5830f892e0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:10Z
---

# `openclaw reset`

Lokale config/status resetten (houdt de CLI geïnstalleerd).

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
