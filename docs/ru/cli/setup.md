---
summary: "Справочник CLI для `openclaw setup` (инициализация конфига + рабочего пространства)"
read_when:
  - Вы выполняете первичную настройку без полного мастера онбординга
  - Вы хотите задать путь к рабочему пространству по умолчанию
title: "настройка"
---

# `openclaw setup`

Инициализирует `~/.openclaw/openclaw.json` и рабочее пространство агента.

Связанное:

- Начало работы: [Начало работы](/start/getting-started)
- Мастер: [Онбординг](/start/onboarding)

## Примеры

```bash
openclaw setup
openclaw setup --workspace ~/.openclaw/workspace
```

Чтобы запустить мастер через setup:

```bash
openclaw setup --wizard
```
