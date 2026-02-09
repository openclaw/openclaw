---
summary: "Обзор логирования: файловые логи, вывод в консоль, tail через CLI и Control UI"
read_when:
  - Вам нужен обзор логирования для начинающих
  - Вы хотите настроить уровни или форматы логов
  - Вы устраняете неполадки и хотите быстро найти логи
title: "Логирование"
---

# Логирование

OpenClaw ведёт логи в двух местах:

- **Файловые логи** (JSON-строки), записываемые Gateway (шлюзом).
- **Вывод в консоль**, отображаемый в терминалах и Control UI.

На этой странице объясняется, где находятся логи, как их читать и как настраивать
уровни и форматы логирования.

## Где находятся логи

По умолчанию Gateway (шлюз) пишет вращающийся лог-файл по пути:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

Дата использует локальный часовой пояс хоста шлюза Gateway.

Вы можете переопределить это в `~/.openclaw/openclaw.json`:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## Как читать логи

### CLI: live tail (рекомендуется)

Используйте CLI для «хвоста» лог-файла шлюза через RPC:

```bash
openclaw logs --follow
```

Режимы вывода:

- **TTY-сеансы**: красивый, цветной, структурированный вывод строк логов.
- **Не-TTY-сеансы**: простой текст.
- `--json`: JSON с разделением по строкам (одно событие лога на строку).
- `--plain`: принудительный простой текст в TTY-сеансах.
- `--no-color`: отключить ANSI-цвета.

В режиме JSON CLI выводит объекты с тегом `type`:

- `meta`: метаданные потока (файл, курсор, размер)
- `log`: разобранная запись лога
- `notice`: подсказки об усечении / ротации
- `raw`: неразобранная строка лога

Если Gateway (шлюз) недоступен, CLI выводит краткую подсказку выполнить:

```bash
openclaw doctor
```

### Control UI (веб)

Вкладка **Logs** в Control UI читает тот же файл, используя `logs.tail`.
См. [/web/control-ui](/web/control-ui), как открыть интерфейс.

### Логи только каналов

Чтобы отфильтровать активность каналов (WhatsApp/Telegram/и т. д.), используйте:

```bash
openclaw channels logs --channel whatsapp
```

## Форматы логов

### Файловые логи (JSONL)

Каждая строка в лог-файле — это JSON-объект. CLI и Control UI разбирают эти записи
для отображения структурированного вывода (время, уровень, подсистема, сообщение).

### Вывод в консоль

Консольные логи **учитывают TTY** и форматируются для удобства чтения:

- Префиксы подсистем (например, `gateway/channels/whatsapp`)
- Цветовое выделение уровней (info/warn/error)
- Необязательный компактный или JSON-режим

Форматирование консоли управляется параметром `logging.consoleStyle`.

## Настройка логирования

Вся конфигурация логирования находится под `logging` в `~/.openclaw/openclaw.json`.

```json
{
  "logging": {
    "level": "info",
    "file": "/tmp/openclaw/openclaw-YYYY-MM-DD.log",
    "consoleLevel": "info",
    "consoleStyle": "pretty",
    "redactSensitive": "tools",
    "redactPatterns": ["sk-.*"]
  }
}
```

### Уровни логов

- `logging.level`: уровень **файловых логов** (JSONL).
- `logging.consoleLevel`: уровень подробности **консоли**.

`--verbose` влияет только на вывод в консоль; уровни файловых логов он не меняет.

### Стили консоли

`logging.consoleStyle`:

- `pretty`: ориентированный на человека, цветной, с временными метками.
- `compact`: более плотный вывод (лучше для длительных сессий).
- `json`: JSON по строкам (для обработчиков логов).

### Редакция (redaction)

Сводки инструментов могут скрывать чувствительные токены до попадания в консоль:

- `logging.redactSensitive`: `off` | `tools` (по умолчанию: `tools`)
- `logging.redactPatterns`: список regex-строк для переопределения набора по умолчанию

Редакция влияет **только на вывод в консоль** и не изменяет файловые логи.

## Диагностика + OpenTelemetry

Диагностика — это структурированные, машиночитаемые события для запусков моделей **и**
телеметрии потока сообщений (webhooks, очереди, состояние сессий). Они **не**
заменяют логи; они существуют для передачи метрик, трейсов и других экспортеров.

Диагностические события испускаются внутри процесса, но экспортеры подключаются
только когда включены диагностика и плагин-экспортер.

### OpenTelemetry vs OTLP

- **OpenTelemetry (OTel)**: модель данных и SDK для трейсов, метрик и логов.
- **OTLP**: протокол передачи для экспорта данных OTel в коллектор/бэкенд.
- OpenClaw в настоящее время экспортирует через **OTLP/HTTP (protobuf)**.

### Экспортируемые сигналы

- **Метрики**: счётчики и гистограммы (использование токенов, поток сообщений, очереди).
- **Трейсы**: спаны для использования моделей и обработки webhook/сообщений.
- **Логи**: экспортируются по OTLP, когда включён `diagnostics.otel.logs`. Объём логов
  может быть высоким; учитывайте `logging.level` и фильтры экспортера.

### Каталог диагностических событий

Использование моделей:

- `model.usage`: токены, стоимость, длительность, контекст, провайдер/модель/канал, идентификаторы сессий.

Поток сообщений:

- `webhook.received`: вход webhook по каналам.
- `webhook.processed`: обработка webhook + длительность.
- `webhook.error`: ошибки обработчика webhook.
- `message.queued`: сообщение помещено в очередь на обработку.
- `message.processed`: результат + длительность + необязательная ошибка.

Очереди и сессии:

- `queue.lane.enqueue`: постановка в очередь команд (lane) + глубина.
- `queue.lane.dequeue`: извлечение из очереди команд (lane) + время ожидания.
- `session.state`: переход состояния сессии + причина.
- `session.stuck`: предупреждение о «застрявшей» сессии + возраст.
- `run.attempt`: метаданные повторов/попыток запуска.
- `diagnostic.heartbeat`: агрегированные счётчики (webhooks/очереди/сессии).

### Включить диагностику (без экспортера)

Используйте это, если вам нужны диагностические события для плагинов или
пользовательских приёмников:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### Флаги диагностики (таргетированные логи)

Используйте флаги, чтобы включать дополнительные, точечные debug-логи без
повышения `logging.level`.
Флаги нечувствительны к регистру и поддерживают
шаблоны (например, `telegram.*` или `*`).

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Переопределение через env (одноразово):

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Примечания:

- Логи флагов пишутся в стандартный лог-файл (тот же, что и `logging.file`).
- Вывод по-прежнему редактируется в соответствии с `logging.redactSensitive`.
- Полное руководство: [/diagnostics/flags](/diagnostics/flags).

### Экспорт в OpenTelemetry

Диагностика может экспортироваться через плагин `diagnostics-otel` (OTLP/HTTP). Это
работает с любым коллектором/бэкендом OpenTelemetry, принимающим OTLP/HTTP.

```json
{
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": {
        "enabled": true
      }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://otel-collector:4318",
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 0.2,
      "flushIntervalMs": 60000
    }
  }
}
```

Примечания:

- Вы также можете включить плагин с помощью `openclaw plugins enable diagnostics-otel`.
- `protocol` в настоящее время поддерживает только `http/protobuf`. `grpc` игнорируется.
- Метрики включают использование токенов, стоимость, размер контекста, длительность запуска и
  счётчики/гистограммы потока сообщений (webhooks, очереди, состояние сессий, глубина/ожидание очереди).
- Трейсы/метрики можно переключать с помощью `traces` / `metrics` (по умолчанию: включены). Трейсы
  включают спаны использования моделей, а также спаны обработки webhook/сообщений, когда включены.
- Установите `headers`, если вашему коллектору требуется аутентификация.
- Поддерживаемые переменные окружения: `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`.

### Экспортируемые метрики (имена + типы)

Использование моделей:

- `openclaw.tokens` (counter, attrs: `openclaw.token`, `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (counter, attrs: `openclaw.channel`, `openclaw.provider`,
  `openclaw.model`)
- `openclaw.run.duration_ms` (histogram, attrs: `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (histogram, attrs: `openclaw.context`,
  `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

Поток сообщений:

- `openclaw.webhook.received` (counter, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.error` (counter, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (histogram, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.message.queued` (counter, attrs: `openclaw.channel`,
  `openclaw.source`)
- `openclaw.message.processed` (counter, attrs: `openclaw.channel`,
  `openclaw.outcome`)
- `openclaw.message.duration_ms` (histogram, attrs: `openclaw.channel`,
  `openclaw.outcome`)

Очереди и сессии:

- `openclaw.queue.lane.enqueue` (counter, attrs: `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (counter, attrs: `openclaw.lane`)
- `openclaw.queue.depth` (histogram, attrs: `openclaw.lane` или
  `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (histogram, attrs: `openclaw.lane`)
- `openclaw.session.state` (counter, attrs: `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (counter, attrs: `openclaw.state`)
- `openclaw.session.stuck_age_ms` (histogram, attrs: `openclaw.state`)
- `openclaw.run.attempt` (counter, attrs: `openclaw.attempt`)

### Экспортируемые спаны (имена + ключевые атрибуты)

- `openclaw.model.usage`
  - `openclaw.channel`, `openclaw.provider`, `openclaw.model`
  - `openclaw.sessionKey`, `openclaw.sessionId`
  - `openclaw.tokens.*` (input/output/cache_read/cache_write/total)
- `openclaw.webhook.processed`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`,
    `openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`, `openclaw.outcome`, `openclaw.chatId`,
    `openclaw.messageId`, `openclaw.sessionKey`, `openclaw.sessionId`,
    `openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`, `openclaw.ageMs`, `openclaw.queueDepth`,
    `openclaw.sessionKey`, `openclaw.sessionId`

### Отбор проб + сброс

- Сэмплирование трейсов: `diagnostics.otel.sampleRate` (0.0–1.0, только корневые спаны).
- Интервал экспорта метрик: `diagnostics.otel.flushIntervalMs` (минимум 1000 мс).

### Примечания по протоколу

- Конечные точки OTLP/HTTP можно задать через `diagnostics.otel.endpoint` или
  `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Если конечная точка уже содержит `/v1/traces` или `/v1/metrics`, она используется как есть.
- Если конечная точка уже содержит `/v1/logs`, она используется как есть для логов.
- `diagnostics.otel.logs` включает экспорт логов OTLP для основного вывода логгера.

### Поведение экспорта логов

- Логи OTLP используют те же структурированные записи, что записываются в `logging.file`.
- Учитывается `logging.level` (уровень файловых логов). Редакция консоли **не**
  применяется к логам OTLP.
- Для установок с большим объёмом данных предпочтительны сэмплирование/фильтрация на стороне коллектора OTLP.

## Советы по устранению неполадок

- **Gateway (шлюз) недоступен?** Сначала выполните `openclaw doctor`.
- **Логи пустые?** Убедитесь, что Gateway (шлюз) запущен и пишет в путь файла,
  указанный в `logging.file`.
- **Нужно больше деталей?** Установите `logging.level` в `debug` или `trace` и повторите.
