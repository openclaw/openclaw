---
summary: "Справочник CLI для `openclaw approvals` (подтверждения выполнения команд для Gateway (шлюз) или хостов узлов)"
read_when:
  - Вы хотите редактировать подтверждения выполнения команд из CLI
  - Вам нужно управлять списками разрешённых на хостах шлюза Gateway или хостах узлов
title: "approvals"
---

# `openclaw approvals`

Управляйте подтверждениями выполнения команд для **локального хоста**, **хоста шлюза Gateway** или **хоста узла**.
По умолчанию команды нацелены на локальный файл подтверждений на диске. Используйте `--gateway`, чтобы нацелиться на шлюз, или `--node`, чтобы нацелиться на конкретный узел.

Связанное:

- Подтверждения выполнения команд: [Exec approvals](/tools/exec-approvals)
- Узлы: [Nodes](/nodes)

## Часто используемые команды

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## Замена подтверждений из файла

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## Вспомогательные инструменты для списка разрешённых

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## Примечания

- `--node` использует тот же резолвер, что и `openclaw nodes` (id, name, ip или префикс id).
- `--agent` по умолчанию использует `"*"`, который применяется ко всем агентам.
- Хост узла должен объявлять `system.execApprovals.get/set` (приложение для macOS или headless хост узла).
- Файлы подтверждений хранятся для каждого хоста по пути `~/.openclaw/exec-approvals.json`.
