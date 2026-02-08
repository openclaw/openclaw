---
summary: "Справка CLI для `openclaw reset` (сброс локального состояния/конфига)"
read_when:
  - "Вам нужно стереть локальное состояние, сохранив установленный CLI"
  - "Вам нужен пробный запуск (dry-run) того, что будет удалено"
title: "Сброс"
x-i18n:
  source_path: cli/reset.md
  source_hash: 08afed5830f892e0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:19Z
---

# `openclaw reset`

Сброс локального конфига/состояния (CLI остаётся установленным).

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
