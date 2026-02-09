---
summary: "Подробный регламент устранения неполадок для шлюза, каналов, автоматизации, узлов и браузера"
read_when:
  - Центр устранения неполадок направил вас сюда для более глубокой диагностики
  - Вам нужны стабильные разделы регламента по симптомам с точными командами
title: "Устранение неполадок"
---

# Устранение неполадок Gateway

Эта страница — подробный регламент.
Если сначала нужен быстрый поток первичной диагностики, начните с [/help/troubleshooting](/help/troubleshooting).

## Командная лестница

Запустите их первыми, в таком порядке:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Ожидаемые здоровые сигналы:

- `openclaw gateway status` показывает `Runtime: running` и `RPC probe: ok`.
- `openclaw doctor` сообщает об отсутствии блокирующих проблем конфигурации/сервиса.
- `openclaw channels status --probe` показывает подключённые/готовые каналы.

## Нет ответов

Если каналы подняты, но ответов нет, прежде чем что-либо переподключать, проверьте маршрутизацию и политики.

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

Ищите:

- В ожидании отправки СМС.
- Ограничения упоминаний в группах (`requireMention`, `mentionPatterns`).
- Несоответствия списков разрешённых каналов/групп.

Общие подписи:

- `drop guild message (mention required` → групповое сообщение игнорируется до упоминания.
- `pairing request` → отправителю требуется одобрение.
- `blocked` / `allowlist` → отправитель/канал отфильтрован политикой.

Связанное:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## Подключение панели управления (dashboard/control UI)

Когда панель управления/control UI не подключается, проверьте URL, режим аутентификации и предположения о безопасном контексте.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

Ищите:

- Корректный URL зонда и URL панели.
- Несоответствие режима аутентификации/токена между клиентом и Gateway (шлюз).
- Использование HTTP там, где требуется идентификация устройства.

Общие подписи:

- `device identity required` → небезопасный контекст или отсутствует аутентификация устройства.
- `unauthorized` / цикл переподключения → несоответствие токена/пароля.
- `gateway connect failed:` → неверный хост/порт/URL назначения.

Связанное:

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## Сервис Gateway (шлюз) не запущен

Используйте это, когда сервис установлен, но процесс не удерживается в рабочем состоянии.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

Ищите:

- `Runtime: stopped` с подсказками по выходу.
- Несоответствие конфигурации сервиса (`Config (cli)` vs `Config (service)`).
- Конфликты портов/слушателей.

Общие подписи:

- `Gateway start blocked: set gateway.mode=local` → локальный режим шлюза не включён.
- `refusing to bind gateway ... without auth` → привязка не к loopback без токена/пароля.
- `another gateway instance is already listening` / `EADDRINUSE` → конфликт портов.

Связанное:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## Канал подключён, но сообщения не проходят

Если состояние канала «подключён», но поток сообщений не работает, сосредоточьтесь на политиках, правах и правилах доставки конкретного канала.

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

Ищите:

- Политику личных сообщений (`pairing`, `allowlist`, `open`, `disabled`).
- Списки разрешённых для групп и требования упоминаний.
- Отсутствующие API-права/области доступа канала.

Общие подписи:

- `mention required` → сообщение игнорируется политикой упоминаний группы.
- `pairing` / следы ожидания одобрения → отправитель не одобрен.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → проблема аутентификации/прав канала.

Связанное:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Доставка cron и heartbeat

Если cron или heartbeat не запустился или не доставил сообщения, сначала проверьте состояние планировщика, затем цель доставки.

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

Ищите:

- Крон включён и следующее пробуждение.
- Статус истории выполнения заданий (`ok`, `skipped`, `error`).
- Причины пропуска heartbeat (`quiet-hours`, `requests-in-flight`, `alerts-disabled`).

Общие подписи:

- `cron: scheduler disabled; jobs will not run automatically` → cron отключён.
- `cron: timer tick failed` → сбой тика планировщика; проверьте файлы/логи/ошибки среды выполнения.
- `heartbeat skipped` с `reason=quiet-hours` → вне окна активных часов.
- `heartbeat: unknown accountId` → неверный идентификатор аккаунта для цели доставки heartbeat.

Связанное:

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## Сбой инструментов у сопряжённого узла

Если узел сопряжён, но инструменты не работают, изолируйте состояние переднего плана, права и одобрения.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

Ищите:

- Узел онлайн с ожидаемыми возможностями.
- Выдачу прав ОС для камеры/микрофона/локации/экрана.
- Состояние подтверждений выполнения команд и списка разрешённых.

Общие подписи:

- `NODE_BACKGROUND_UNAVAILABLE` → приложение узла должно быть на переднем плане.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → отсутствует право ОС.
- `SYSTEM_RUN_DENIED: approval required` → ожидается подтверждение выполнения команды.
- `SYSTEM_RUN_DENIED: allowlist miss` → команда заблокирована списком разрешённых.

Связанное:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## Сбой браузерного инструмента

Используйте это, когда действия браузерного инструмента не работают, хотя сам Gateway (шлюз) исправен.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

Ищите:

- Корректный путь к исполняемому файлу браузера.
- Доступность профиля CDP.
- Подключение вкладки ретрансляции расширения для `profile="chrome"`.

Общие подписи:

- `Failed to start Chrome CDP on port` → процесс браузера не запустился.
- `browser.executablePath not found` → указанный путь неверен.
- `Chrome extension relay is running, but no tab is connected` → ретрансляция расширения не подключена.
- `Browser attachOnly is enabled ... not reachable` → профиль «attach-only» не имеет доступной цели.

Связанное:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## Если вы обновились и что-то внезапно сломалось

Большинство сбоев после обновления — это дрейф конфигурации или более строгие значения по умолчанию, которые теперь применяются.

### 1. Изменилось поведение аутентификации и переопределения URL

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

Что проверить:

- Если `gateway.mode=remote`, вызовы CLI могут нацеливаться на удалённый сервис, в то время как локальный работает нормально.
- Явные вызовы `--url` не откатываются к сохранённым учётным данным.

Общие подписи:

- `gateway connect failed:` → неверная цель URL.
- `unauthorized` → конечная точка доступна, но аутентификация неверна.

### 2. Ограждения привязки и аутентификации стали строже

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

Что проверить:

- Привязки не к loopback (`lan`, `tailnet`, `custom`) требуют настроенной аутентификации.
- Старые ключи, такие как `gateway.token`, не заменяют `gateway.auth.token`.

Общие подписи:

- `refusing to bind gateway ... without auth` → несоответствие привязки и аутентификации.
- `RPC probe: failed` при запущенной среде выполнения → шлюз жив, но недоступен с текущей аутентификацией/URL.

### 3. Изменилось состояние сопряжения и идентификации устройства

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

Что проверить:

- Ожидающие одобрения устройств для панели/узлов.
- Ожидающие одобрения сопряжения личных сообщений после изменений политики или идентификации.

Общие подписи:

- `device identity required` → требования аутентификации устройства не выполнены.
- `pairing required` → отправитель/устройство должны быть одобрены.

Если после проверок конфигурация сервиса и среда выполнения всё ещё расходятся, переустановите метаданные сервиса из того же профиля/каталога состояния:

```bash
openclaw gateway install --force
openclaw gateway restart
```

Связанное:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
