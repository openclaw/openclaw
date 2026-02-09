---
title: Sandbox CLI
summary: "Управление контейнерами Sandbox и просмотр эффективной политики sandbox"
read_when: "Вы управляете контейнерами Sandbox или отлаживаете поведение sandbox/политики инструментов."
status: active
---

# Sandbox CLI

Управление контейнерами Sandbox на базе Docker для изолированного выполнения агентов.

## Обзор

OpenClaw может запускать агентов в изолированных Docker-контейнерах для повышения безопасности. Команды `sandbox` помогают управлять этими контейнерами, особенно после обновлений или изменений конфигурации.

## Команды

### `openclaw sandbox explain`

Просмотр **эффективного** режима/области Sandbox/доступа к рабочему пространству, политики инструментов Sandbox и повышенных «gate»-прав (с путями ключей конфига для исправлений).

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

Список всех контейнеров Sandbox с их статусом и конфигурацией.

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**Вывод включает:**

- Имя контейнера и статус (запущен/остановлен)
- Docker-образ и соответствие конфигурации
- Возраст (время с момента создания)
- Время простоя (время с последнего использования)
- Связанный сеанс/агент

### `openclaw sandbox recreate`

Удаление контейнеров Sandbox для принудительного пересоздания с обновлёнными образами/конфигом.

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**Параметры:**

- `--all`: Пересоздать все контейнеры Sandbox
- `--session <key>`: Пересоздать контейнер для конкретного сеанса
- `--agent <id>`: Пересоздать контейнеры для конкретного агента
- `--browser`: Пересоздавать только браузерные контейнеры
- `--force`: Пропустить запрос подтверждения

**Важно:** Контейнеры автоматически пересоздаются при следующем использовании агента.

## Сценарии использования

### После обновления Docker-образов

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### После изменения конфигурации Sandbox

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### После изменения setupCommand

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### Только для конкретного агента

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## Зачем это нужно?

**Проблема:** Когда вы обновляете Docker-образы Sandbox или конфигурацию:

- Существующие контейнеры продолжают работать со старыми настройками
- Контейнеры удаляются только после 24 часов простоя
- Регулярно используемые агенты держат старые контейнеры запущенными бесконечно

**Решение:** Используйте `openclaw sandbox recreate` для принудительного удаления старых контейнеров. Они будут автоматически пересозданы с текущими настройками при следующей необходимости.

Совет: отдавайте предпочтение `openclaw sandbox recreate` вместо ручного `docker rm`. Он использует именование контейнеров Gateway (шлюз) и предотвращает несоответствия при изменении ключей области/сеанса.

## Конфигурация

Настройки Sandbox находятся в `~/.openclaw/openclaw.json` в разделе `agents.defaults.sandbox` (переопределения для каждого агента — в `agents.list[].sandbox`):

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all", // off, non-main, all
        "scope": "agent", // session, agent, shared
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          // ... more Docker options
        },
        "prune": {
          "idleHours": 24, // Auto-prune after 24h idle
          "maxAgeDays": 7, // Auto-prune after 7 days
        },
      },
    },
  },
}
```

## См. также

- [Документация по Sandbox](/gateway/sandboxing)
- [Конфигурация агента](/concepts/agent-workspace)
- [Команда Doctor](/gateway/doctor) — проверка настройки Sandbox
