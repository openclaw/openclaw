---
summary: "Запуск моста ACP для интеграций с IDE"
read_when:
  - Настройка IDE‑интеграций на базе ACP
  - Отладка маршрутизации сеансов ACP к Gateway (шлюзу)
title: "acp"
---

# acp

Запуск моста ACP (Agent Client Protocol), который взаимодействует с Gateway (шлюзом) OpenClaw.

Эта команда использует ACP поверх stdio для IDE и пересылает запросы в Gateway (шлюз)
через WebSocket. Она поддерживает сопоставление сеансов ACP с ключами сеансов Gateway (шлюза).

## Usage

```bash
openclaw acp

# Remote Gateway
openclaw acp --url wss://gateway-host:18789 --token <token>

# Attach to an existing session key
openclaw acp --session agent:main:main

# Attach by label (must already exist)
openclaw acp --session-label "support inbox"

# Reset the session key before the first prompt
openclaw acp --session agent:main:main --reset-session
```

## ACP client (debug)

Используйте встроенный ACP‑клиент, чтобы проверить мост без IDE.
Он запускает мост ACP и позволяет интерактивно вводить запросы.

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## How to use this

Используйте ACP, когда IDE (или другой клиент) говорит на Agent Client Protocol и вы хотите,
чтобы он управлял сеансом Gateway (шлюза) OpenClaw.

1. Убедитесь, что Gateway (шлюз) запущен (локально или удалённо).
2. Настройте целевой Gateway (шлюз) (через конфиг или флаги).
3. Укажите в IDE запуск `openclaw acp` через stdio.

Пример конфига (с сохранением):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

Пример прямого запуска (без записи конфига):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Selecting agents

ACP не выбирает агентов напрямую. Маршрутизация происходит по ключу сеанса Gateway (шлюза).

Используйте ключи сеансов с областью агента, чтобы нацелиться на конкретного агента:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

Каждый сеанс ACP сопоставляется с одним ключом сеанса Gateway (шлюза). У одного агента может быть
много сеансов; по умолчанию ACP использует изолированный сеанс `acp:<uuid>`, если вы не переопределите
ключ или метку.

## Zed editor setup

Добавьте пользовательского ACP‑агента в `~/.config/zed/settings.json` (или используйте интерфейс настроек Zed):

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Чтобы нацелиться на конкретный Gateway (шлюз) или агента:

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": [
        "acp",
        "--url",
        "wss://gateway-host:18789",
        "--token",
        "<token>",
        "--session",
        "agent:design:main"
      ],
      "env": {}
    }
  }
}
```

В Zed откройте панель Agent и выберите «OpenClaw ACP», чтобы начать тред.

## Session mapping

По умолчанию сеансы ACP получают изолированный ключ сеанса Gateway (шлюза) с префиксом `acp:`.
Чтобы повторно использовать известный сеанс, передайте ключ сеанса или метку:

- `--session <key>`: использовать конкретный ключ сеанса Gateway (шлюза).
- `--session-label <label>`: разрешить существующий сеанс по метке.
- `--reset-session`: создать новый идентификатор сеанса для этого ключа (тот же ключ, новый транскрипт).

Если ваш ACP‑клиент поддерживает метаданные, вы можете переопределять параметры для каждого сеанса:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

Подробнее о ключах сеансов см. [/concepts/session](/concepts/session).

## Options

- `--url <url>`: URL WebSocket Gateway (шлюза) (по умолчанию используется gateway.remote.url при наличии конфигурации).
- `--token <token>`: токен аутентификации Gateway (шлюза).
- `--password <password>`: пароль аутентификации Gateway (шлюза).
- `--session <key>`: ключ сеанса по умолчанию.
- `--session-label <label>`: метка сеанса по умолчанию для разрешения.
- `--require-existing`: завершить с ошибкой, если ключ/метка сеанса не существует.
- `--reset-session`: сбросить ключ сеанса перед первым использованием.
- `--no-prefix-cwd`: не добавлять рабочий каталог в начало запросов.
- `--verbose, -v`: подробное логирование в stderr.

### `acp client` options

- `--cwd <dir>`: рабочий каталог для сеанса ACP.
- `--server <command>`: команда сервера ACP (по умолчанию: `openclaw`).
- `--server-args <args...>`: дополнительные аргументы, передаваемые серверу ACP.
- `--server-verbose`: включить подробное логирование на сервере ACP.
- `--verbose, -v`: подробное логирование клиента.
