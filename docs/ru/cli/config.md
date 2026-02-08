---
summary: "Справка по CLI для `openclaw config` (получение/установка/сброс значений конфига)"
read_when:
  - Вы хотите читать или редактировать конфиг в неинтерактивном режиме
title: "config"
x-i18n:
  source_path: cli/config.md
  source_hash: d60a35f5330f22bc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:09Z
---

# `openclaw config`

Вспомогательные команды для конфига: получение/установка/сброс значений по пути. Запуск без подкоманды открывает мастер настройки
(то же самое, что `openclaw configure`).

## Примеры

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## Пути

Пути используют точечную или скобочную нотацию:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

Используйте индекс списка агентов, чтобы нацелиться на конкретного агента:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Значения

Значения по возможности разбираются как JSON5; в противном случае они трактуются как строки.
Используйте `--json`, чтобы принудительно требовать разбор JSON5.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

Перезапустите Gateway (шлюз) после изменений.
