---
summary: "Справка CLI для `openclaw nodes` (list/status/approve/invoke, camera/canvas/screen)"
read_when:
  - Вы управляете сопряжёнными узлами (камерами, экраном, холстом)
  - Вам нужно одобрять запросы или вызывать команды узлов
title: "узлы"
---

# `openclaw nodes`

Управление сопряжёнными узлами (устройствами) и вызов возможностей узлов.

Связанное:

- Обзор узлов: [Nodes](/nodes)
- Камера: [Camera nodes](/nodes/camera)
- Изображения: [Image nodes](/nodes/images)

Общие параметры:

- `--url`, `--token`, `--timeout`, `--json`

## Часто используемые команды

```bash
openclaw nodes list
openclaw nodes list --connected
openclaw nodes list --last-connected 24h
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes status
openclaw nodes status --connected
openclaw nodes status --last-connected 24h
```

`nodes list` выводит таблицы ожидающих/сопряжённых. Для сопряжённых строк указывается возраст последнего подключения (Last Connect).
Используйте `--connected`, чтобы показать только узлы, подключённые в данный момент. Используйте `--last-connected <duration>`, чтобы
отфильтровать узлы, подключившиеся в пределах заданной длительности (например, `24h`, `7d`).

## Вызов / запуск

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Флаги вызова:

- `--params <json>`: строка JSON-объекта (по умолчанию `{}`).
- `--invoke-timeout <ms>`: таймаут вызова узла (по умолчанию `15000`).
- `--idempotency-key <key>`: необязательный ключ идемпотентности.

### Значения по умолчанию в стиле exec

`nodes run` отражает поведение exec модели (значения по умолчанию + подтверждения):

- Читает `tools.exec.*` (плюс переопределения `agents.list[].tools.exec.*`).
- Использует подтверждения выполнения команд (`exec.approval.request`) перед вызовом `system.run`.
- `--node` можно опустить, когда задано `tools.exec.node`.
- Требуется узел, который объявляет `system.run` (сопутствующее приложение для macOS или headless хост узла).

Флаги:

- `--cwd <path>`: рабочий каталог.
- `--env <key=val>`: переопределение env (можно указывать повторно).
- `--command-timeout <ms>`: таймаут команды.
- `--invoke-timeout <ms>`: таймаут вызова узла (по умолчанию `30000`).
- `--needs-screen-recording`: требовать разрешение на запись экрана.
- `--raw <command>`: выполнить строку оболочки (`/bin/sh -lc` или `cmd.exe /c`).
- `--agent <id>`: подтверждения/списки разрешённых на уровне агента (по умолчанию используется настроенный агент).
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: переопределения.
