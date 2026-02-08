---
summary: "Справочник CLI для `openclaw setup` (инициализация конфига + рабочего пространства)"
read_when:
  - Вы выполняете первичную настройку без полного мастера онбординга
  - Вы хотите задать путь к рабочему пространству по умолчанию
title: "настройка"
x-i18n:
  source_path: cli/setup.md
  source_hash: 7f3fc8b246924edf
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:21Z
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
