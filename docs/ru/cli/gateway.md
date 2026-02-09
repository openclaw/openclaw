---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — запуск, запрос и обнаружение шлюзов"
read_when:
  - Запуск Gateway из CLI (dev или серверы)
  - Отладка аутентификации Gateway, режимов привязки и подключения
  - Обнаружение шлюзов через Bonjour (LAN + tailnet)
title: "gateway"
---

# Gateway CLI

Gateway — это WebSocket‑сервер OpenClaw (каналы, узлы, сеансы, хуки).

Подкоманды на этой странице находятся под `openclaw gateway …`.

Связанная документация:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Запуск Gateway

Запуск локального процесса Gateway:

```bash
openclaw gateway
```

Псевдоним переднего плана:

```bash
openclaw gateway run
```

Примечания:

- По умолчанию Gateway отказывается запускаться, если в `~/.openclaw/openclaw.json` не задано `gateway.mode=local`. Для разовых/dev‑запусков используйте `--allow-unconfigured`.
- Привязка за пределами loopback без аутентификации заблокирована (защитное ограничение).
- `SIGUSR1` инициирует перезапуск внутри процесса при наличии прав (включите `commands.restart` или используйте инструмент gateway / config apply/update).
- Обработчики `SIGINT`/`SIGTERM` останавливают процесс gateway, но не восстанавливают пользовательское состояние терминала. Если вы оборачиваете CLI в TUI или используете ввод в raw‑режиме, восстановите терминал перед выходом.

### Параметры

- `--port <port>`: порт WebSocket (значение по умолчанию берётся из конфига/переменных окружения; обычно `18789`).
- `--bind <loopback|lan|tailnet|auto|custom>`: режим привязки слушателя.
- `--auth <token|password>`: переопределение режима аутентификации.
- `--token <token>`: переопределение токена (также устанавливает `OPENCLAW_GATEWAY_TOKEN` для процесса).
- `--password <password>`: переопределение пароля (также устанавливает `OPENCLAW_GATEWAY_PASSWORD` для процесса).
- `--tailscale <off|serve|funnel>`: публикация Gateway через Tailscale.
- `--tailscale-reset-on-exit`: сброс конфигурации Tailscale serve/funnel при завершении работы.
- `--allow-unconfigured`: разрешить запуск gateway без `gateway.mode=local` в конфиге.
- `--dev`: создать dev‑конфиг + рабочее пространство при отсутствии (пропускает BOOTSTRAP.md).
- `--reset`: сбросить dev‑конфиг + учётные данные + сеансы + рабочее пространство (требуется `--dev`).
- `--force`: завершить любой существующий слушатель на выбранном порту перед запуском.
- `--verbose`: подробные логи.
- `--claude-cli-logs`: показывать в консоли только логи claude-cli (и включить его stdout/stderr).
- `--ws-log <auto|full|compact>`: стиль логов websocket (по умолчанию `auto`).
- `--compact`: алиас для `--ws-log compact`.
- `--raw-stream`: записывать сырые события потока модели в jsonl.
- `--raw-stream-path <path>`: путь к jsonl для сырого потока.

## Запросы к запущенному Gateway

Все команды запросов используют WebSocket RPC.

Режимы вывода:

- По умолчанию: человекочитаемый (с цветами в TTY).
- `--json`: машиночитаемый JSON (без оформления/спиннера).
- `--no-color` (или `NO_COLOR=1`): отключить ANSI, сохранив человекочитаемую раскладку.

Общие параметры (где поддерживаются):

- `--url <url>`: URL WebSocket Gateway.
- `--token <token>`: токен Gateway.
- `--password <password>`: пароль Gateway.
- `--timeout <ms>`: тайм‑аут/бюджет (зависит от команды).
- `--expect-final`: ждать «финального» ответа (вызовы агента).

Примечание: при установке `--url` CLI не использует резервный вариант из конфига или переменных окружения.
Передайте `--token` или `--password` явно. Отсутствие явных учётных данных считается ошибкой.

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` показывает сервис Gateway (launchd/systemd/schtasks) плюс необязательную RPC‑проверку.

```bash
openclaw gateway status
openclaw gateway status --json
```

Параметры:

- `--url <url>`: переопределить URL для проверки.
- `--token <token>`: аутентификация токеном для проверки.
- `--password <password>`: аутентификация паролем для проверки.
- `--timeout <ms>`: тайм‑аут проверки (по умолчанию `10000`).
- `--no-probe`: пропустить RPC‑проверку (только сервис).
- `--deep`: сканировать также сервисы на уровне системы.

### `gateway probe`

`gateway probe` — команда «отладить всё». Она всегда выполняет проверку:

- настроенного удалённого gateway (если задан), и
- localhost (loopback) **даже если удалённый gateway настроен**.

Если доступны несколько gateway, выводятся все. Несколько gateway поддерживаются при использовании изолированных профилей/портов (например, rescue‑бот), но в большинстве установок всё ещё используется один gateway.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### Удалённо через SSH (паритет с macOS‑приложением)

Режим macOS‑приложения «Remote over SSH» использует локальный port‑forward, благодаря чему удалённый gateway (который может быть привязан только к loopback) становится доступным по адресу `ws://127.0.0.1:<port>`.

Эквивалент в CLI:

```bash
openclaw gateway probe --ssh user@gateway-host
```

Параметры:

- `--ssh <target>`: `user@host` или `user@host:port` (порт по умолчанию `22`).
- `--ssh-identity <path>`: файл идентичности.
- `--ssh-auto`: выбрать первый обнаруженный хост шлюза Gateway в качестве SSH‑цели (только LAN/WAB).

Конфиг (необязательно, используется как значения по умолчанию):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

Низкоуровневый помощник RPC.

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Управление сервисом Gateway

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

Примечания:

- `gateway install` поддерживает `--port`, `--runtime`, `--token`, `--force`, `--json`.
- Команды жизненного цикла принимают `--json` для скриптов.

## Обнаружение шлюзов (Bonjour)

`gateway discover` сканирует маяки Gateway (`_openclaw-gw._tcp`).

- Multicast DNS‑SD: `local.`
- Unicast DNS‑SD (Wide‑Area Bonjour): выберите домен (пример: `openclaw.internal.`) и настройте split DNS + DNS‑сервер; см. [/gateway/bonjour](/gateway/bonjour)

Рекламируются только те gateway, у которых включено обнаружение Bonjour (по умолчанию).

Записи Wide‑Area discovery включают (TXT):

- `role` (подсказка роли gateway)
- `transport` (подсказка транспорта, например `gateway`)
- `gatewayPort` (порт WebSocket, обычно `18789`)
- `sshPort` (порт SSH; по умолчанию `22`, если отсутствует)
- `tailnetDns` (имя хоста MagicDNS, при наличии)
- `gatewayTls` / `gatewayTlsSha256` (включён TLS + отпечаток сертификата)
- `cliPath` (необязательная подсказка для удалённых установок)

### `gateway discover`

```bash
openclaw gateway discover
```

Параметры:

- `--timeout <ms>`: тайм‑аут на команду (browse/resolve); по умолчанию `2000`.
- `--json`: машиночитаемый вывод (также отключает оформление/спиннер).

Примеры:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
