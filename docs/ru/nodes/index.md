---
summary: "Узлы: сопряжение, возможности, разрешения и помощники CLI для canvas/камеры/экрана/системы"
read_when:
  - Сопряжение узлов iOS/Android с Gateway (шлюзом)
  - Использование canvas/камеры узла для контекста агента
  - Добавление новых команд узла или помощников CLI
title: "Узлы"
---

# Узлы

**Узел** — это сопутствующее устройство (macOS/iOS/Android/безголовое), которое подключается к **WebSocket** Gateway (шлюза) (тот же порт, что и у операторов) с `role: "node"` и предоставляет поверхность команд (например, `canvas.*`, `camera.*`, `system.*`) через `node.invoke`. Подробности протокола: [Протокол Gateway](/gateway/protocol).

Устаревший транспорт: [Протокол Bridge](/gateway/bridge-protocol) (TCP JSONL; устарел/удалён для текущих узлов).

macOS также может работать в **режиме узла**: приложение в строке меню подключается к WS‑серверу Gateway (шлюза) и предоставляет свои локальные команды canvas/камеры как узел (так что `openclaw nodes …` работает с этим Mac).

Примечания:

- Узлы — это **периферийные устройства**, а не шлюзы. Они не запускают сервис шлюза.
- Сообщения Telegram/WhatsApp и т. п. поступают на **gateway (шлюз)**, а не на узлы.
- Runbook по устранению неполадок: [/nodes/troubleshooting](/nodes/troubleshooting)

## Сопряжение + статус

**WS‑узлы используют сопряжение устройств.** Узлы предъявляют идентификатор устройства во время `connect`; Gateway (шлюз)
создаёт запрос на сопряжение устройства для `role: node`. Подтвердите через CLI устройства (или UI).

Быстрый CLI:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

Примечания:

- `nodes status` помечает узел как **сопряжённый**, когда роль сопряжения устройства включает `node`.
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject`) — это отдельное, принадлежащее шлюзу хранилище сопряжений узлов; оно **не** блокирует WS‑рукопожатие `connect`.

## Удалённый хост узла (system.run)

Используйте **хост узла**, когда ваш Gateway (шлюз) работает на одной машине, а вы хотите выполнять команды на другой. Модель по‑прежнему общается с **gateway (шлюзом)**; шлюз
перенаправляет вызовы `exec` на **хост узла**, когда выбран `host=node`.

### Что где выполняется

- **Хост шлюза Gateway**: принимает сообщения, запускает модель, маршрутизирует вызовы инструментов.
- **Хост узла**: выполняет `system.run`/`system.which` на машине узла.
- **Подтверждения**: применяются на хосте узла через `~/.openclaw/exec-approvals.json`.

### Запуск хоста узла (в фоне терминала)

На машине узла:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### Удалённый шлюз через SSH‑туннель (привязка к loopback)

Если Gateway (шлюз) привязывается к loopback (`gateway.bind=loopback`, по умолчанию в локальном режиме),
удалённые хосты узлов не могут подключаться напрямую. Создайте SSH‑туннель и укажите
хосту узла локальный конец туннеля.

Пример (хост узла → хост шлюза):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

Примечания:

- Токен — это `gateway.auth.token` из конфига шлюза (`~/.openclaw/openclaw.json` на хосте шлюза).
- `openclaw node run` читает `OPENCLAW_GATEWAY_TOKEN` для аутентификации.

### Запуск хоста узла (как сервиса)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### Сопряжение + имя

На хосте шлюза:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

Варианты именования:

- `--display-name` в `openclaw node run` / `openclaw node install` (сохраняется в `~/.openclaw/node.json` на узле).
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (переопределение на стороне шлюза).

### Разрешённый список команд

Подтверждения выполнения команд — **для каждого хоста узла**. Добавляйте записи allowlist со стороны шлюза:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

Подтверждения хранятся на хосте узла в `~/.openclaw/exec-approvals.json`.

### Направление exec на узел

Настройка значений по умолчанию (конфиг шлюза):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

Или для конкретного сеанса:

```
/exec host=node security=allowlist node=<id-or-name>
```

После установки любой вызов `exec` с `host=node` выполняется на хосте узла (с учётом
allowlist/подтверждений узла).

Связанное:

- [CLI хоста узла](/cli/node)
- [Инструмент Exec](/tools/exec)
- [Подтверждения Exec](/tools/exec-approvals)

## Вызов команд

Низкоуровневый (сырой RPC):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

Существуют более высокоуровневые помощники для распространённых сценариев «передать агенту вложение MEDIA».

## Скриншоты (снимки canvas)

Если узел отображает Canvas (WebView), `canvas.snapshot` возвращает `{ format, base64 }`.

Помощник CLI (записывает во временный файл и печатает `MEDIA:<path>`):

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Управление Canvas

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

Примечания:

- `canvas present` принимает URL или локальные пути к файлам (`--target`), а также необязательный `--x/--y/--width/--height` для позиционирования.
- `canvas eval` принимает встроенный JS (`--js`) или позиционный аргумент.

### A2UI (Canvas)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

Примечания:

- Поддерживается только A2UI v0.8 JSONL (v0.9/createSurface отклоняется).

## Фото + видео (камера узла)

Фото (`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

Видеоклипы (`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

Примечания:

- Узел должен быть **на переднем плане** для `canvas.*` и `camera.*` (вызовы в фоне возвращают `NODE_BACKGROUND_UNAVAILABLE`).
- Длительность клипа ограничивается (в настоящее время `<= 60s`), чтобы избежать чрезмерно больших base64‑полезных нагрузок.
- Android по возможности запрашивает разрешения `CAMERA`/`RECORD_AUDIO`; отклонённые разрешения завершаются ошибкой `*_PERMISSION_REQUIRED`.

## Записи экрана (узлы)

Узлы предоставляют `screen.record` (mp4). Пример:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

Примечания:

- `screen.record` требует, чтобы приложение узла было на переднем плане.
- Android покажет системный запрос захвата экрана перед записью.
- Записи экрана ограничиваются `<= 60s`.
- `--no-audio` отключает захват микрофона (поддерживается на iOS/Android; macOS использует системный звук захвата).
- Используйте `--screen <index>` для выбора дисплея при наличии нескольких экранов.

## Геолокация (узлы)

Узлы предоставляют `location.get`, когда геолокация включена в настройках.

Помощник CLI:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

Примечания:

- Геолокация **по умолчанию выключена**.
- Режим «Всегда» требует системного разрешения; фоновое получение — по принципу best‑effort.
- Ответ включает широту/долготу, точность (в метрах) и временную метку.

## SMS (узлы Android)

Узлы Android могут предоставлять `sms.send`, когда пользователь предоставляет разрешение **SMS** и устройство поддерживает телефонию.

Низкоуровневый вызов:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

Примечания:

- Запрос разрешения должен быть принят на устройстве Android до объявления возможности.
- Устройства только с Wi‑Fi без телефонии не будут объявлять `sms.send`.

## Системные команды (хост узла / узел mac)

Узел macOS предоставляет `system.run`, `system.notify` и `system.execApprovals.get/set`.
Безголовый хост узла предоставляет `system.run`, `system.which` и `system.execApprovals.get/set`.

Примеры:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

Примечания:

- `system.run` возвращает stdout/stderr/код выхода в полезной нагрузке.
- `system.notify` учитывает состояние разрешений на уведомления в приложении macOS.
- `system.run` поддерживает `--cwd`, `--env KEY=VAL`, `--command-timeout` и `--needs-screen-recording`.
- `system.notify` поддерживает `--priority <passive|active|timeSensitive>` и `--delivery <system|overlay|auto>`.
- Узлы macOS игнорируют переопределения `PATH`; безголовые хосты узлов принимают `PATH` только когда он предваряет PATH хоста узла.
- В режиме узла macOS `system.run` ограничен подтверждениями exec в приложении macOS (Настройки → Exec approvals).
  Ask/allowlist/full ведут себя так же, как на безголовом хосте узла; отклонённые запросы возвращают `SYSTEM_RUN_DENIED`.
- На безголовом хосте узла `system.run` ограничен подтверждениями exec (`~/.openclaw/exec-approvals.json`).

## Привязка exec к узлу

Когда доступно несколько узлов, можно привязать exec к конкретному узлу.
Это задаёт узел по умолчанию для `exec host=node` (и может быть переопределено для каждого агента).

Глобальное значение по умолчанию:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

Переопределение для агента:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Сбросить, чтобы разрешить любой узел:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## Карта разрешений

Узлы могут включать карту `permissions` в `node.list` / `node.describe`, с ключами по имени разрешения (например, `screenRecording`, `accessibility`) и булевыми значениями (`true` = предоставлено).

## Безголовый хост узла (кросс‑платформенный)

OpenClaw может запускать **безголовый хост узла** (без UI), который подключается к WebSocket Gateway (шлюза)
и предоставляет `system.run` / `system.which`. Это полезно на Linux/Windows
или для запуска минимального узла рядом с сервером.

Запуск:

```bash
openclaw node run --host <gateway-host> --port 18789
```

Примечания:

- Сопряжение по‑прежнему требуется (Gateway покажет запрос на одобрение узла).
- Хост узла хранит свой id узла, токен, отображаемое имя и информацию о подключении к шлюзу в `~/.openclaw/node.json`.
- Подтверждения exec применяются локально через `~/.openclaw/exec-approvals.json`
  (см. [Подтверждения Exec](/tools/exec-approvals)).
- На macOS безголовый хост узла предпочитает exec‑хост сопутствующего приложения, если он доступен, и
  откатывается к локальному выполнению, если приложение недоступно. Установите `OPENCLAW_NODE_EXEC_HOST=app`, чтобы требовать
  приложение, или `OPENCLAW_NODE_EXEC_FALLBACK=0`, чтобы отключить откат.
- Добавьте `--tls` / `--tls-fingerprint`, когда Gateway WS использует TLS.

## Режим узла mac

- Приложение macOS в строке меню подключается к WS‑серверу Gateway как узел (так что `openclaw nodes …` работает с этим Mac).
- В удалённом режиме приложение открывает SSH‑туннель для порта шлюза и подключается к `localhost`.
