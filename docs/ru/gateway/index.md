---
summary: "Рунбук для сервиса Gateway, его жизненного цикла и операций"
read_when:
  - При запуске или отладке процесса Gateway
title: "Рунбук Gateway"
---

# Рунбук сервиса Gateway

Последнее обновление: 2025-12-09

## Что это такое

- Постоянно работающий процесс, владеющий единственным соединением Baileys/Telegram и плоскостью управления/событий.
- Заменяет устаревшую команду `gateway`. Точка входа CLI: `openclaw gateway`.
- Работает до остановки; при фатальных ошибках завершает работу с ненулевым кодом, чтобы супервизор перезапустил его.

## Как запустить (локально)

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- Горячая перезагрузка конфига отслеживает `~/.openclaw/openclaw.json` (или `OPENCLAW_CONFIG_PATH`).
  - Режим по умолчанию: `gateway.reload.mode="hybrid"` (безопасные изменения применяются на лету, критические — с перезапуском).
  - Горячая перезагрузка при необходимости использует перезапуск в процессе через **SIGUSR1**.
  - Отключается с помощью `gateway.reload.mode="off"`.
- Привязывает плоскость управления WebSocket к `127.0.0.1:<port>` (по умолчанию 18789).
- Тот же порт также обслуживает HTTP (UI управления, хуки, A2UI). Мультиплексирование на одном порту.
  - OpenAI Chat Completions (HTTP): [`/v1/chat/completions`](/gateway/openai-http-api).
  - OpenResponses (HTTP): [`/v1/responses`](/gateway/openresponses-http-api).
  - Tools Invoke (HTTP): [`/tools/invoke`](/gateway/tools-invoke-http-api).
- По умолчанию запускает файловый сервер Canvas на `canvasHost.port` (по умолчанию `18793`), обслуживающий `http://<gateway-host>:18793/__openclaw__/canvas/` из `~/.openclaw/workspace/canvas`. Отключается с помощью `canvasHost.enabled=false` или `OPENCLAW_SKIP_CANVAS_HOST=1`.
- Логи пишутся в stdout; используйте launchd/systemd для поддержания процесса и ротации логов.
- Передайте `--verbose`, чтобы зеркалировать отладочные логи (рукопожатия, req/res, события) из файла логов в stdio при устранении неполадок.
- `--force` использует `lsof` для поиска слушателей на выбранном порту, отправляет SIGTERM, логирует, что было остановлено, затем запускает Gateway (быстро завершается с ошибкой, если отсутствует `lsof`).
- Если вы запускаете под супервизором (launchd/systemd/дочерний процесс приложения для macOS), остановка/перезапуск обычно отправляет **SIGTERM**; в старых сборках это может отображаться как `pnpm` `ELIFECYCLE` с кодом выхода **143** (SIGTERM), что является штатным завершением, а не сбоем.
- **SIGUSR1** инициирует перезапуск в процессе при наличии разрешений (инструмент Gateway/применение конфига/обновление либо включите `commands.restart` для ручных перезапусков).
- Аутентификация Gateway по умолчанию обязательна: задайте `gateway.auth.token` (или `OPENCLAW_GATEWAY_TOKEN`) либо `gateway.auth.password`. Клиенты должны отправлять `connect.params.auth.token/password`, если не используется идентификация Tailscale Serve.
- Мастер настройки теперь генерирует токен по умолчанию, даже на loopback.
- Приоритет портов: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > значение по умолчанию `18789`.

## Удалённый доступ

- Предпочтительно Tailscale/VPN; в противном случае — SSH-туннель:

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- Затем клиенты подключаются к `ws://127.0.0.1:18789` через туннель.

- Если настроен токен, клиенты должны включать его в `connect.params.auth.token` даже через туннель.

## Несколько Gateway (на одном хосте)

Обычно не требуется: один Gateway может обслуживать несколько каналов сообщений и агентов. Используйте несколько Gateway только для резервирования или строгой изоляции (например, rescue bot).

Поддерживается при изоляции состояния и конфига и использовании уникальных портов. Полное руководство: [Несколько Gateway](/gateway/multiple-gateways).

Имена сервисов учитывают профиль:

- macOS: `bot.molt.<profile>` (устаревший `com.openclaw.*` может всё ещё существовать)
- Linux: `openclaw-gateway-<profile>.service`
- Windows: `OpenClaw Gateway (<profile>)`

Метаданные установки встроены в конфиг сервиса:

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

Паттерн Rescue-Bot: держите второй Gateway изолированным с собственным профилем, каталогом состояния, рабочим пространством и разнесением базовых портов. Полное руководство: [Руководство по rescue-bot](/gateway/multiple-gateways#rescue-bot-guide).

### Профиль Dev (`--dev`)

Быстрый путь: запустите полностью изолированный dev-инстанс (конфиг/состояние/рабочее пространство), не затрагивая основную установку.

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

Значения по умолчанию (можно переопределить через env/флаги/конфиг):

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001` (Gateway WS + HTTP)
- порт сервиса управления браузером = `19003` (производное: `gateway.port+2`, только loopback)
- `canvasHost.port=19005` (производное: `gateway.port+4`)
- `agents.defaults.workspace` по умолчанию становится `~/.openclaw/workspace-dev`, когда вы запускаете `setup`/`onboard` под `--dev`.

Производные порты (эмпирические правила):

- Базовый порт = `gateway.port` (или `OPENCLAW_GATEWAY_PORT` / `--port`)
- порт сервиса управления браузером = база + 2 (только loopback)
- `canvasHost.port = base + 4` (или `OPENCLAW_CANVAS_HOST_PORT` / переопределение в конфиге)
- Порты CDP профиля браузера выделяются автоматически начиная с `browser.controlPort + 9 .. + 108` (сохраняются для профиля).

Checklist per instance:

- уникальный `gateway.port`
- уникальный `OPENCLAW_CONFIG_PATH`
- уникальный `OPENCLAW_STATE_DIR`
- уникальный `agents.defaults.workspace`
- отдельные номера WhatsApp (если используется WA)

Установка сервиса для профиля:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

Пример:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## Протокол (взгляд оператора)

- Полная документация: [Протокол Gateway](/gateway/protocol) и [Протокол Bridge (устаревший)](/gateway/bridge-protocol).
- Обязательный первый фрейм от клиента: `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`.
- Gateway отвечает `res {type:"res", id, ok:true, payload:hello-ok }` (или `ok:false` с ошибкой, затем закрывает соединение).
- После рукопожатия:
  - Запросы: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - События: `{type:"event", event, payload, seq?, stateVersion?}`
- Структурированные записи присутствия: `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }` (для WS‑клиентов `instanceId` поступает из `connect.client.instanceId`).
- Ответы `agent` двухэтапные: сначала `res` ack `{runId,status:"accepted"}`, затем финальный `res` `{runId,status:"ok"|"error",summary}` после завершения выполнения; потоковый вывод приходит как `event:"agent"`.

## Методы (начальный набор)

- `health` — полный снимок состояния (та же форма, что и `openclaw health --json`).
- `status` — краткое резюме.
- `system-presence` — текущий список присутствия.
- `system-event` — опубликовать заметку присутствия/системную (структурированную).
- `send` — отправить сообщение через активный канал(ы).
- `agent` — выполнить ход агента (поток событий возвращается по тому же соединению).
- `node.list` — список сопряжённых и текущих подключённых узлов (включает `caps`, `deviceFamily`, `modelIdentifier`, `paired`, `connected` и объявленные `commands`).
- `node.describe` — описание узла (возможности + поддерживаемые команды `node.invoke`; работает для сопряжённых узлов и для подключённых, но не сопряжённых).
- `node.invoke` — вызов команды на узле (например, `canvas.*`, `camera.*`).
- `node.pair.*` — жизненный цикл сопряжения (`request`, `list`, `approve`, `reject`, `verify`).

См. также: [Присутствие](/concepts/presence) — как формируется/дедуплицируется присутствие и почему важен стабильный `client.instanceId`.

## События

- `agent` — потоковые события инструмента/вывода из выполнения агента (с тегами последовательности).
- `presence` — обновления присутствия (дельты с stateVersion), рассылаемые всем подключённым клиентам.
- `tick` — периодический keepalive/no-op для подтверждения живости.
- `shutdown` — Gateway завершает работу; полезная нагрузка включает `reason` и необязательный `restartExpectedMs`. Клиенты должны переподключиться.

## Интеграция WebChat

- WebChat — это нативный UI на SwiftUI, который напрямую взаимодействует с WebSocket Gateway для истории, отправки, прерывания и событий.
- Удалённое использование проходит через тот же SSH/Tailscale‑туннель; если настроен токен Gateway, клиент включает его во время `connect`.
- Приложение для macOS подключается через один WS (общее соединение); оно гидратирует присутствие из начального снимка и слушает события `presence` для обновления UI.

## Напечатать и проверить

- Сервер валидирует каждый входящий фрейм с помощью AJV по JSON Schema, сгенерированной из определений протокола.
- Клиенты (TS/Swift) используют сгенерированные типы (TS — напрямую; Swift — через генератор репозитория).
- Определения протокола — источник истины; перегенерируйте схемы/модели с помощью:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## Снимок соединения

- `hello-ok` включает `snapshot` с `presence`, `health`, `stateVersion` и `uptimeMs`, а также `policy {maxPayload,maxBufferedBytes,tickIntervalMs}`, чтобы клиенты могли сразу отрисоваться без дополнительных запросов.
- `health`/`system-presence` остаются доступными для ручного обновления, но не требуются при подключении.

## Коды ошибок (форма res.error)

- Ошибки используют `{ code, message, details?, retryable?, retryAfterMs? }`.
- Стандартные коды:
  - `NOT_LINKED` — WhatsApp не аутентифицирован.
  - `AGENT_TIMEOUT` — агент не ответил в пределах настроенного дедлайна.
  - `INVALID_REQUEST` — ошибка валидации схемы/параметров.
  - `UNAVAILABLE` — Gateway завершает работу или зависимость недоступна.

## Поведение keepalive

- События `tick` (или WS ping/pong) периодически отправляются, чтобы клиенты знали, что Gateway жив даже при отсутствии трафика.
- Подтверждения отправки/агента остаются отдельными ответами; не перегружайте тики для отправок.

## Повторы / разрывы

- События не воспроизводятся повторно. Клиенты обнаруживают разрывы последовательности и должны обновиться (`health` + `system-presence`) перед продолжением. WebChat и клиенты macOS теперь автоматически обновляются при разрыве.

## Супервизия (пример для macOS)

- Используйте launchd для поддержания сервиса:
  - Program: путь к `openclaw`
  - Arguments: `gateway`
  - KeepAlive: true
  - StandardOut/Err: пути к файлам или `syslog`
- При сбое launchd перезапускает; фатальная неправильная конфигурация должна продолжать приводить к выходу, чтобы оператор заметил проблему.
- LaunchAgents — для каждого пользователя и требуют активной сессии; для headless‑настроек используйте кастомный LaunchDaemon (не поставляется).
  - `openclaw gateway install` записывает `~/Library/LaunchAgents/bot.molt.gateway.plist`
    (или `bot.molt.<profile>.plist`; устаревший `com.openclaw.*` очищается).
  - `openclaw doctor` проверяет конфигурацию LaunchAgent и может обновить её до текущих значений по умолчанию.

## Управление сервисом Gateway (CLI)

Используйте Gateway CLI для install/start/stop/restart/status:

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

Примечания:

- `gateway status` по умолчанию проверяет Gateway RPC, используя разрешённый порт/конфиг сервиса (переопределяется с помощью `--url`).
- `gateway status --deep` добавляет проверки на уровне системы (LaunchDaemons/system units).
- `gateway status --no-probe` пропускает RPC‑проверку (полезно при недоступной сети).
- `gateway status --json` стабилен для скриптов.
- `gateway status` отдельно сообщает о **времени работы супервизора** (launchd/systemd запущен) и **доступности RPC** (WS‑подключение + статус RPC).
- `gateway status` выводит путь к конфигу и цель проверки, чтобы избежать путаницы «localhost vs LAN bind» и несоответствий профилей.
- `gateway status` включает последнюю строку ошибки Gateway, когда сервис выглядит запущенным, но порт закрыт.
- `logs` читает файл логов Gateway через RPC (без ручного `tail`/`grep`).
- Если обнаружены другие сервисы, похожие на gateway, CLI предупреждает, если это не сервисы профиля OpenClaw.
  Мы по‑прежнему рекомендуем **один gateway на машину** для большинства установок; используйте изолированные профили/порты для резервирования или rescue bot. См. См. [Multiple gateways](/gateway/multiple-gateways).
  - Очистка: `openclaw gateway uninstall` (текущий сервис) и `openclaw doctor` (устаревшие миграции).
- `gateway install` — no-op, если уже установлено; используйте `openclaw gateway install --force` для переустановки (изменения профиля/env/пути).

Встроенное приложение для macOS:

- OpenClaw.app может поставляться с relay Gateway на базе Node и устанавливать пользовательский LaunchAgent с меткой
  `bot.molt.gateway` (или `bot.molt.<profile>`; устаревшие метки `com.openclaw.*` корректно выгружаются).
- Для корректной остановки используйте `openclaw gateway stop` (или `launchctl bootout gui/$UID/bot.molt.gateway`).
- Для перезапуска используйте `openclaw gateway restart` (или `launchctl kickstart -k gui/$UID/bot.molt.gateway`).
  - `launchctl` работает только если LaunchAgent установлен; в противном случае сначала используйте `openclaw gateway install`.
  - Замените метку на `bot.molt.<profile>` при запуске именованного профиля.

## Супервизия (пользовательский unit systemd)

OpenClaw по умолчанию устанавливает **пользовательский сервис systemd** на Linux/WSL2. Мы
рекомендуем пользовательские сервисы для однопользовательских машин (проще окружение, конфиг для пользователя).
Используйте **системный сервис** для многопользовательских или постоянно работающих серверов (без lingering,
с общим надзором).

`openclaw gateway install` записывает пользовательский unit. `openclaw doctor` проверяет
unit и может обновить его в соответствии с текущими рекомендуемыми значениями по умолчанию.

Создайте `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
Environment=OPENCLAW_GATEWAY_TOKEN=
WorkingDirectory=/home/youruser

[Install]
WantedBy=default.target
```

Включите lingering (требуется, чтобы пользовательский сервис переживал выход из системы/простой):

```
sudo loginctl enable-linger youruser
```

Онбординг выполняет это на Linux/WSL2 (может запросить sudo; записывает `/var/lib/systemd/linger`).
Затем включите сервис:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

**Альтернатива (системный сервис)** — для постоянно работающих или многопользовательских серверов вы можете
установить systemd **system** unit вместо пользовательского (lingering не требуется).
Создайте `/etc/systemd/system/openclaw-gateway[-<profile>].service` (скопируйте unit выше,
переключите `WantedBy=multi-user.target`, задайте `User=` + `WorkingDirectory=`), затем:

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows (WSL2)

Установки на Windows должны использовать **WSL2** и следовать разделу Linux systemd выше.

## Операционные проверки

- Живучесть: откройте WS и отправьте `req:connect` → ожидайте `res` с `payload.type="hello-ok"` (со снимком).
- Готовность: вызовите `health` → ожидайте `ok: true` и связанный канал в `linkChannel` (когда применимо).
- Отладка: подпишитесь на события `tick` и `presence`; убедитесь, что `status` показывает возраст связки/аутентификации; записи присутствия показывают хост шлюза Gateway и подключённых клиентов.

## Гарантии безопасности

- По умолчанию предполагается один Gateway на хост; если вы запускаете несколько профилей, изолируйте порты/состояние и обращайтесь к правильному инстансу.
- Нет резервного перехода к прямым подключениям Baileys; если Gateway недоступен, отправки немедленно завершаются ошибкой.
- Некорректные первые фреймы подключения или повреждённый JSON отклоняются, и сокет закрывается.
- Корректное завершение: перед закрытием отправляется событие `shutdown`; клиенты должны обрабатывать закрытие и переподключение.

## CLI‑помощники

- `openclaw gateway health|status` — запросить health/status через WS Gateway.
- `openclaw message send --target <num> --message "hi" [--media ...]` — отправка через Gateway (идемпотентно для WhatsApp).
- `openclaw agent --message "hi" --to <num>` — выполнить ход агента (по умолчанию ждёт финал).
- `openclaw gateway call <method> --params '{"k":"v"}'` — низкоуровневый вызов метода для отладки.
- `openclaw gateway stop|restart` — остановить/перезапустить сервис Gateway под супервизором (launchd/systemd).
- Подкоманды помощника Gateway предполагают запущенный gateway на `--url`; они больше не запускают его автоматически.

## Руководство по миграции

- Прекратите использование `openclaw gateway` и устаревшего TCP‑порта управления.
- Обновите клиентов для работы по WS‑протоколу с обязательным подключением и структурированным присутствием.
