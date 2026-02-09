---
summary: "Задания cron + пробуждения для планировщика Gateway"
read_when:
  - Планирование фоновых заданий или пробуждений
  - Подключение автоматизации, которая должна работать с сигналами keepalive или параллельно с ними
  - Выбор между heartbeat и cron для запланированных задач
title: "Задания Cron"
---

# Задания cron (планировщик Gateway)

> **Cron или Heartbeat?** См. [Cron vs Heartbeat](/automation/cron-vs-heartbeat) — рекомендации по выбору подходящего варианта.

Cron — это встроенный планировщик Gateway. Он сохраняет задания, пробуждает агента
в нужный момент и при необходимости доставляет вывод обратно в чат.

Если вам нужно «выполнять это каждое утро» или «потревожить агента через 20 минут»,
используйте cron.

Устранение неполадок: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron работает **внутри Gateway** (а не внутри модели).
- Задания сохраняются в `~/.openclaw/cron/`, поэтому перезапуски не приводят к потере расписаний.
- Два стиля выполнения:
  - **Основной сеанс**: поставить системное событие в очередь и выполнить на следующем heartbeat.
  - **Изолированный**: выполнить отдельный ход агента в `cron:<jobId>` с доставкой (по умолчанию — announce или без доставки).
- Пробуждения — первоклассная возможность: задание может запросить «разбудить сейчас» вместо «на следующем heartbeat».

## Быстрый старт (практически применимо)

Создайте одноразовое напоминание, проверьте, что оно существует, и запустите его немедленно:

```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id>
openclaw cron runs --id <job-id>
```

Запланируйте повторяющееся изолированное задание с доставкой:

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

## Эквиваленты вызовов инструментов (инструмент cron Gateway)

Канонические JSON-формы и примеры см. в разделе [JSON schema for tool calls](/automation/cron-jobs#json-schema-for-tool-calls).

## Где хранятся задания cron

Задания cron по умолчанию сохраняются на хосте шлюза Gateway по пути `~/.openclaw/cron/jobs.json`.
Gateway загружает файл в память и перезаписывает его при изменениях, поэтому ручное редактирование
безопасно только при остановленном Gateway. Для изменений предпочтительно использовать `openclaw cron add/edit`
или API вызовов инструмента cron.

## Обзор для начинающих

Рассматривайте задание cron как: **когда** запускать + **что** выполнять.

1. **Выберите расписание**
   - Одноразовое напоминание → `schedule.kind = "at"` (CLI: `--at`)
   - Повторяющееся задание → `schedule.kind = "every"` или `schedule.kind = "cron"`
   - Если в ISO-времени не указана временная зона, оно трактуется как **UTC**.

2. **Выберите, где выполняется**
   - `sessionTarget: "main"` → выполнение во время следующего heartbeat с основным контекстом.
   - `sessionTarget: "isolated"` → отдельный ход агента в `cron:<jobId>`.

3. **Выберите полезную нагрузку**
   - Основной сеанс → `payload.kind = "systemEvent"`
   - Изолированный сеанс → `payload.kind = "agentTurn"`

Необязательно: одноразовые задания (`schedule.kind = "at"`) по умолчанию удаляются после успешного выполнения. Установите `deleteAfterRun: false`, чтобы сохранить их (после успеха они будут отключены).

## Concepts

### Задания

Задание cron — это сохранённая запись, содержащая:

- **расписание** (когда запускать),
- **полезную нагрузку** (что выполнять),
- необязательный **режим доставки** (announce или none),
- необязательную **привязку к агенту** (`agentId`): запуск задания под конкретным агентом; если
  отсутствует или неизвестна, Gateway использует агент по умолчанию.

Задания идентифицируются стабильным `jobId` (используется CLI и API Gateway).
В вызовах инструментов агента каноническим является `jobId`; устаревший `id`
принимается для совместимости.
Одноразовые задания по умолчанию автоматически удаляются после успеха;
установите `deleteAfterRun: false`, чтобы сохранить их.

### Расписания

Cron поддерживает три типа расписаний:

- `at`: одноразовая отметка времени через `schedule.at` (ISO 8601).
- `every`: фиксированный интервал (мс).
- `cron`: cron-выражение из 5 полей с необязательной IANA-временной зоной.

Cron-выражения используют `croner`. Если временная зона не указана, используется
локальная временная зона хоста Gateway.

### Основное и изолированное выполнение

#### Задания основного сеанса (системные события)

Основные задания ставят системное событие в очередь и при необходимости пробуждают runner heartbeat.
Они должны использовать `payload.kind = "systemEvent"`.

- `wakeMode: "now"` (по умолчанию): событие запускает немедленный heartbeat.
- `wakeMode: "next-heartbeat"`: событие ждёт следующего запланированного heartbeat.

Лучше всего подходит, когда нужен обычный prompt heartbeat + контекст основного сеанса.
См. [Heartbeat](/gateway/heartbeat).

#### Изолированные задания (выделенные сеансы cron)

Изолированные задания выполняют отдельный ход агента в сеансе `cron:<jobId>`.

Ключевые особенности:

- Prompt предваряется `[cron:<jobId> <job name>]` для трассируемости.
- Каждый запуск начинает **новый идентификатор сеанса** (без переноса предыдущего диалога).
- Поведение по умолчанию: если `delivery` не указан, изолированные задания публикуют краткий отчёт (`delivery.mode = "announce"`).
- `delivery.mode` (только для изолированных) определяет поведение:
  - `announce`: доставить краткий отчёт в целевой канал и опубликовать короткий отчёт в основном сеансе.
  - `none`: только внутренняя обработка (без доставки и без отчёта в основном сеансе).
- `wakeMode` управляет моментом публикации отчёта в основном сеансе:
  - `now`: немедленный heartbeat.
  - `next-heartbeat`: ожидание следующего запланированного heartbeat.

Используйте изолированные задания для шумных, частых или «фоновых задач», которые не должны
засорять историю основного чата.

### Формы полезной нагрузки (что выполняется)

Поддерживаются два типа полезной нагрузки:

- `systemEvent`: только для основного сеанса, проходит через prompt heartbeat.
- `agentTurn`: только для изолированного сеанса, выполняет отдельный ход агента.

Общие поля `agentTurn`:

- `message`: обязательный текстовый prompt.
- `model` / `thinking`: необязательные переопределения (см. ниже).
- `timeoutSeconds`: необязательное переопределение тайм-аута.

Конфигурация доставки (только для изолированных заданий):

- `delivery.mode`: `none` | `announce`.
- `delivery.channel`: `last` или конкретный канал.
- `delivery.to`: целевой идентификатор канала (телефон/чат/id канала).
- `delivery.bestEffort`: не считать задание неуспешным, если доставка announce не удалась.

Доставка announce подавляет отправки через инструменты сообщений в ходе выполнения; используйте
`delivery.channel`/`delivery.to` для прямого таргетинга чата. Когда `delivery.mode = "none"`, отчёт в основной
сеанс не публикуется.

Если `delivery` не указан для изолированных заданий, OpenClaw по умолчанию использует `announce`.

#### Поток доставки announce

Когда `delivery.mode = "announce"`, cron доставляет напрямую через адаптеры исходящих каналов.
Основной агент не запускается для формирования или пересылки сообщения.

Детали поведения:

- Содержимое: доставка использует исходящие полезные нагрузки изолированного запуска (текст/медиа) с обычной нарезкой и
  форматированием канала.
- Ответы только heartbeat (`HEARTBEAT_OK` без реального содержимого) не доставляются.
- Если изолированный запуск уже отправил сообщение тому же получателю через инструмент сообщений, доставка
  пропускается во избежание дубликатов.
- Отсутствующие или некорректные цели доставки приводят к сбою задания, если не указан `delivery.bestEffort = true`.
- Короткий отчёт публикуется в основном сеансе только когда `delivery.mode = "announce"`.
- Отчёт в основном сеансе учитывает `wakeMode`: `now` запускает немедленный heartbeat, а
  `next-heartbeat` ожидает следующего запланированного heartbeat.

### Переопределения модели и уровня «thinking»

Изолированные задания (`agentTurn`) могут переопределять модель и уровень thinking:

- `model`: строка провайдера/модели (например, `anthropic/claude-sonnet-4-20250514`) или алиас (например, `opus`)
- `thinking`: уровень thinking (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; только модели GPT-5.2 + Codex)

Примечание: параметр `model` можно задавать и для заданий основного сеанса, но он изменяет
общую модель основного сеанса. Рекомендуется использовать переопределения модели только
для изолированных заданий, чтобы избежать неожиданных сдвигов контекста.

Приоритет разрешения:

1. Переопределение в полезной нагрузке задания (наивысший)
2. Значения по умолчанию конкретного хука (например, `hooks.gmail.model`)
3. Значение по умолчанию в конфигурации агента

### Доставка (канал + цель)

Изолированные задания могут доставлять вывод в канал через конфигурацию верхнего уровня `delivery`:

- `delivery.mode`: `announce` (доставить краткий отчёт) или `none`.
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (плагин) / `signal` / `imessage` / `last`.
- `delivery.to`: целевой получатель, специфичный для канала.

Конфигурация доставки допустима только для изолированных заданий (`sessionTarget: "isolated"`).

Если `delivery.channel` или `delivery.to` не указан, cron может использовать «последний маршрут»
основного сеанса (последнее место, куда агент отвечал).

Напоминания по форматам целей:

- Для Slack/Discord/Mattermost (плагин) используйте явные префиксы (например, `channel:<id>`, `user:<id>`), чтобы избежать неоднозначности.
- Темы Telegram следует указывать в формате `:topic:` (см. ниже).

#### Цели доставки Telegram (темы / ветки форума)

Telegram поддерживает темы форума через `message_thread_id`. Для доставки cron вы можете закодировать
тему/ветку в поле `to`:

- `-1001234567890` (только id чата)
- `-1001234567890:topic:123` (предпочтительно: явный маркер темы)
- `-1001234567890:123` (краткая форма: числовой суффикс)

Префиксные цели вроде `telegram:...` / `telegram:group:...` также принимаются:

- `telegram:group:-1001234567890:topic:123`

## JSON schema для вызовов инструментов

Используйте эти формы при прямом вызове инструментов Gateway `cron.*` (вызовы инструментов агента или RPC).
Флаги CLI принимают человекочитаемые длительности вроде `20m`, но вызовы инструментов должны
использовать строку ISO 8601 для `schedule.at` и миллисекунды для `schedule.everyMs`.

### Параметры cron.add

Одноразовое задание основного сеанса (системное событие):

```json
{
  "name": "Reminder",
  "schedule": { "kind": "at", "at": "2026-02-01T16:00:00Z" },
  "sessionTarget": "main",
  "wakeMode": "now",
  "payload": { "kind": "systemEvent", "text": "Reminder text" },
  "deleteAfterRun": true
}
```

Повторяющееся изолированное задание с доставкой:

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize overnight updates."
  },
  "delivery": {
    "mode": "announce",
    "channel": "slack",
    "to": "channel:C1234567890",
    "bestEffort": true
  }
}
```

Примечания:

- `schedule.kind`: `at` (`at`), `every` (`everyMs`) или `cron` (`expr`, необязательный `tz`).
- `schedule.at` принимает ISO 8601 (временная зона необязательна; при отсутствии считается UTC).
- `everyMs` — миллисекунды.
- `sessionTarget` должен быть `"main"` или `"isolated"` и должен соответствовать `payload.kind`.
- Необязательные поля: `agentId`, `description`, `enabled`, `deleteAfterRun` (по умолчанию true для `at`),
  `delivery`.
- `wakeMode` по умолчанию равен `"now"`, если не указан.

### Параметры cron.update

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

Примечания:

- `jobId` является каноническим; `id` принимается для совместимости.
- Используйте `agentId: null` в патче, чтобы очистить привязку к агенту.

### Параметры cron.run и cron.remove

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## Хранилище и история

- Хранилище заданий: `~/.openclaw/cron/jobs.json` (JSON под управлением Gateway).
- История запусков: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, с автоочисткой).
- Переопределение пути хранилища: `cron.store` в конфигурации.

## Конфигурация

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
  },
}
```

Полное отключение cron:

- `cron.enabled: false` (конфиг)
- `OPENCLAW_SKIP_CRON=1` (переменная окружения)

## Быстрый старт CLI

Одноразовое напоминание (UTC ISO, автоудаление после успеха):

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

Одноразовое напоминание (основной сеанс, немедленное пробуждение):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

Повторяющееся изолированное задание (announce в WhatsApp):

```bash
openclaw cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Повторяющееся изолированное задание (доставка в тему Telegram):

```bash
openclaw cron add \
  --name "Nightly summary (topic)" \
  --cron "0 22 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize today; send to the nightly topic." \
  --announce \
  --channel telegram \
  --to "-1001234567890:topic:123"
```

Изолированное задание с переопределением модели и уровня thinking:

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Weekly deep analysis of project progress." \
  --model "opus" \
  --thinking high \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Выбор агента (настройки с несколькими агентами):

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

Ручной запуск (по умолчанию force; используйте `--due`, чтобы запускать только при наступлении срока):

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

Редактирование существующего задания (патч полей):

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

История запусков:

```bash
openclaw cron runs --id <jobId> --limit 50
```

Немедленное системное событие без создания задания:

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Поверхность API Gateway

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (force или due), `cron.runs`
  Для немедленных системных событий без задания используйте [`openclaw system event`](/cli/system).

## Устранение неполадок

### «Ничего не запускается»

- Проверьте, что cron включён: `cron.enabled` и `OPENCLAW_SKIP_CRON`.
- Убедитесь, что Gateway работает непрерывно (cron работает внутри процесса Gateway).
- Для расписаний `cron`: проверьте временную зону (`--tz`) относительно временной зоны хоста.

### Повторяющееся задание продолжает откладываться после ошибок

- OpenClaw применяет экспоненциальную задержку повторных попыток для повторяющихся заданий после последовательных ошибок:
  30с, 1м, 5м, 15м, затем 60м между попытками.
- Задержка автоматически сбрасывается после следующего успешного запуска.
- Одноразовые (`at`) задания отключаются после терминального запуска (`ok`, `error` или `skipped`) и не повторяются.

### Telegram доставляет не туда

- Для тем форума используйте `-100…:topic:<id>`, чтобы указание было явным и однозначным.
- Если в логах или сохранённых целях «последнего маршрута» вы видите префиксы `telegram:...`, это нормально;
  доставка cron принимает их и корректно разбирает идентификаторы тем.
