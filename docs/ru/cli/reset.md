---
summary: "Справка CLI для `openclaw reset` (сброс локального состояния/конфига)"
read_when:
  - Вам нужно стереть локальное состояние, сохранив установленный CLI
  - Вы хотите запустить с хитом, что было бы удалено
title: "Сброс"
---

# `openclaw reset`

Сброс локального конфига/состояния (CLI остаётся установленным).

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
