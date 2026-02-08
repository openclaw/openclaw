---
summary: "Sanggunian ng CLI para sa `openclaw reset` (pag-reset ng lokal na state/config)"
read_when:
  - Gusto mong burahin ang lokal na state habang nananatiling naka-install ang CLI
  - Gusto mo ng dry-run kung ano ang matatanggal
title: "reset"
x-i18n:
  source_path: cli/reset.md
  source_hash: 08afed5830f892e0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:17Z
---

# `openclaw reset`

I-reset ang lokal na config/state (mananatiling naka-install ang CLI).

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
