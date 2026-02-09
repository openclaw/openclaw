---
summary: "Опросные сообщения heartbeat и правила уведомлений"
read_when:
  - Настройка частоты heartbeat или формата сообщений
  - Выбор между heartbeat и cron для запланированных задач
title: "Heartbeat"
---

# Heartbeat (Gateway)

> **Heartbeat или Cron?** См. [Cron vs Heartbeat](/automation/cron-vs-heartbeat) — рекомендации, когда использовать каждый из вариантов.

Heartbeat выполняет **периодические ходы агента** в основном сеансе, чтобы модель
могла выявлять то, что требует внимания, не засыпая вас сообщениями.

Устранение неполадок: [/automation/troubleshooting](/automation/troubleshooting)

## Быстрый старт (для начинающих)

1. Оставьте heartbeat включённым (по умолчанию — `30m`, или `1h` для Anthropic OAuth/setup-token) либо задайте собственную периодичность.
2. Создайте небольшой чек‑лист `HEARTBEAT.md` в рабочем пространстве агента (необязательно, но рекомендуется).
3. Определите, куда должны отправляться сообщения heartbeat (по умолчанию — `target: "last"`).
4. Необязательно: включите доставку рассуждений heartbeat для прозрачности.
5. Необязательно: ограничьте heartbeat активными часами (локальное время).

Пример конфига:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## Значения по умолчанию

- Интервал: `30m` (или `1h`, когда обнаружен режим аутентификации Anthropic OAuth/setup-token). Задайте `agents.defaults.heartbeat.every` или для каждого агента `agents.list[].heartbeat.every`; используйте `0m` для отключения.
- Тело промпта (настраивается через `agents.defaults.heartbeat.prompt`):
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- Промпт heartbeat отправляется **дословно** как пользовательское сообщение. Системный
  промпт включает раздел «Heartbeat», а запуск помечается внутренним флагом.
- Активные часы (`heartbeat.activeHours`) проверяются в настроенном часовом поясе.
  Вне окна heartbeat пропускаются до следующего тика внутри окна.

## Для чего нужен промпт heartbeat

Промпт по умолчанию намеренно общий:

- **Фоновые задачи**: «Consider outstanding tasks» побуждает агента просматривать
  последующие действия (входящие, календарь, напоминания, очередь работ) и выносить срочное.
- **Человеческий чек‑ин**: «Checkup sometimes on your human during day time» побуждает
  к редкому, лёгкому сообщению «нужно ли что‑нибудь?», избегая ночного спама
  за счёт использования вашего локального часового пояса (см. [/concepts/timezone](/concepts/timezone)).

Если вы хотите, чтобы heartbeat делал что‑то строго определённое (например,
«проверять статистику Gmail PubSub» или «проверять здоровье шлюза»), задайте
`agents.defaults.heartbeat.prompt` (или `agents.list[].heartbeat.prompt`) с пользовательским телом (отправляется дословно).

## Контракт ответа

- Если внимания ничего не требует, ответьте **`HEARTBEAT_OK`**.
- Во время запусков heartbeat OpenClaw рассматривает `HEARTBEAT_OK` как подтверждение,
  если токен находится **в начале или в конце** ответа. Токен удаляется, а ответ
  отбрасывается, если оставшееся содержимое **≤ `ackMaxChars`** (по умолчанию: 300).
- Если `HEARTBEAT_OK` находится **в середине** ответа, он не обрабатывается особым образом.
- Для алертов **не** включайте `HEARTBEAT_OK`; возвращайте только текст алерта.

Вне heartbeat случайный `HEARTBEAT_OK` в начале/конце сообщения удаляется и логируется;
сообщение, состоящее только из `HEARTBEAT_OK`, отбрасывается.

## Конфигурация

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last", // last | none | <channel id> (core or plugin, e.g. "bluebubbles")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
      },
    },
  },
}
```

### Область действия и приоритеты

- `agents.defaults.heartbeat` задаёт глобальное поведение heartbeat.
- `agents.list[].heartbeat` накладывается поверх; если у любого агента есть блок `heartbeat`,
  **heartbeat выполняются только для этих агентов**.
- `channels.defaults.heartbeat` задаёт видимость по умолчанию для всех каналов.
- `channels.<channel>.heartbeat` переопределяет настройки каналов.
- `channels.<channel>.accounts.<id>.heartbeat` (каналы с несколькими аккаунтами) переопределяет настройки на уровне аккаунта.

### Heartbeat для каждого агента

Если любая запись `agents.list[]` содержит блок `heartbeat`, heartbeat выполняются
**только для этих агентов**. Блок для агента накладывается поверх `agents.defaults.heartbeat`
(что позволяет задать общие значения по умолчанию и переопределять их для агента).

Пример: два агента, heartbeat запускается только у второго.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### Пример активных часов

Ограничьте heartbeat рабочими часами в конкретном часовом поясе:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

Вне этого окна (до 9:00 или после 22:00 по восточному времени) heartbeat пропускаются. Следующий запланированный тик внутри окна выполнится как обычно.

### Пример с несколькими аккаунтами

Используйте `accountId`, чтобы нацелиться на конкретный аккаунт в каналах с
несколькими аккаунтами, таких как Telegram:

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678",
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### Пояснения к полям

- `every`: интервал heartbeat (строка длительности; единица по умолчанию — минуты).
- `model`: необязательное переопределение модели для запусков heartbeat (`provider/model`).
- `includeReasoning`: при включении дополнительно доставляет отдельное сообщение `Reasoning:`,
  когда доступно (та же структура, что у `/reasoning on`).
- `session`: необязательный ключ сеанса для запусков heartbeat.
  - `main` (по умолчанию): основной сеанс агента.
  - Явный ключ сеанса (скопируйте из `openclaw sessions --json` или из [sessions CLI](/cli/sessions)).
  - Форматы ключей сеанса: см. [Sessions](/concepts/session) и [Groups](/channels/groups).
- `target`:
  - `last` (по умолчанию): доставка в последний использованный внешний канал.
  - явный канал: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`.
  - `none`: выполнить heartbeat, но **не доставлять** вовне.
- `to`: необязательное переопределение получателя (идентификатор, специфичный для канала, например E.164 для WhatsApp или chat id Telegram).
- `accountId`: необязательный id аккаунта для каналов с несколькими аккаунтами. Когда `target: "last"`, id аккаунта применяется к разрешённому последнему каналу, если он поддерживает аккаунты; иначе игнорируется. Если id аккаунта не совпадает с настроенным аккаунтом для разрешённого канала, доставка пропускается.
- `prompt`: переопределяет тело промпта по умолчанию (не объединяется).
- `ackMaxChars`: максимальное число символов, разрешённое после `HEARTBEAT_OK` перед доставкой.
- `activeHours`: ограничивает запуски heartbeat временным окном. Объект с `start` (HH:MM, включительно), `end` (HH:MM, исключительно; допускается `24:00` для конца дня) и необязательным `timezone`.
  - Отсутствует или `"user"`: используется ваш `agents.defaults.userTimezone`, если задан, иначе — часовой пояс хоста.
  - `"local"`: всегда использует часовой пояс хоста.
  - Любой идентификатор IANA (например, `America/New_York`): используется напрямую; если некорректен, происходит откат к поведению `"user"` выше.
  - Вне активного окна heartbeat пропускаются до следующего тика внутри окна.

## Поведение доставки

- Heartbeat по умолчанию выполняются в основном сеансе агента (`agent:<id>:<mainKey>`),
  или в `global`, когда `session.scope = "global"`. Задайте `session`, чтобы
  переопределить на конкретный сеанс канала (Discord/WhatsApp и т. д.).
- `session` влияет только на контекст запуска; доставка контролируется
  `target` и `to`.
- Для доставки в конкретный канал/получателю задайте `target` + `to`. При `target: "last"` доставка использует последний внешний канал для этого сеанса.
- Если основная очередь занята, heartbeat пропускается и будет повторён позже.
- Если `target` не разрешается во внешний пункт назначения, запуск всё равно
  происходит, но исходящее сообщение не отправляется.
- Ответы, предназначенные только для heartbeat, **не** поддерживают активность сеанса;
  последний `updatedAt` восстанавливается, поэтому истечение простоя ведёт себя обычно.

## Управление видимостью

По умолчанию подтверждения `HEARTBEAT_OK` подавляются, а содержимое алертов доставляется. Вы можете настроить это для каждого канала или аккаунта:

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

Приоритет: аккаунт → канал → значения канала по умолчанию → встроенные значения по умолчанию.

### Что делает каждый флаг

- `showOk`: отправляет подтверждение `HEARTBEAT_OK`, когда модель возвращает ответ только с OK.
- `showAlerts`: отправляет содержимое алерта, когда модель возвращает ответ не OK.
- `useIndicator`: генерирует события‑индикаторы для поверхностей статуса UI.

Если **все три** равны false, OpenClaw полностью пропускает запуск heartbeat (без вызова модели).

### Примеры: канал vs аккаунт

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### Распространённые шаблоны

| Цель                                                                  | Конфиг                                                                                   |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Поведение по умолчанию (тихие OK, алерты включены) | _(конфиг не нужен)_                                                   |
| Полностью тихо (нет сообщений, нет индикатора)     | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| Только индикатор (без сообщений)                   | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| OK только в одном канале                                              | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (необязательно)

Если в рабочем пространстве существует файл `HEARTBEAT.md`, промпт по умолчанию
предписывает агенту прочитать его. Думайте об этом как о «чек‑листе heartbeat»:
небольшом, стабильном и безопасном для включения каждые 30 минут.

Если `HEARTBEAT.md` существует, но фактически пуст (только пустые строки и
markdown‑заголовки вроде `# Heading`), OpenClaw пропускает запуск heartbeat,
чтобы сэкономить API‑вызовы.
Если файла нет, heartbeat всё равно выполняется, и
модель решает, что делать.

Держите его маленьким (короткий чек‑лист или напоминания), чтобы избежать раздувания промпта.

Пример `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### Может ли агент обновлять HEARTBEAT.md?

Да — если вы его об этом попросите.

`HEARTBEAT.md` — это обычный файл в рабочем пространстве агента, поэтому вы можете
сказать агенту (в обычном чате), например:

- «Обнови `HEARTBEAT.md`, добавив ежедневную проверку календаря».
- «Перепиши `HEARTBEAT.md`, чтобы он был короче и сосредоточен на обработке входящих».

Если вы хотите, чтобы это происходило проактивно, можно также добавить явную строку
в промпт heartbeat, например: «Если чек‑лист устарел, обнови HEARTBEAT.md на более удачный».

Примечание по безопасности: не помещайте секреты (ключи API, номера телефонов,
приватные токены) в `HEARTBEAT.md` — он становится частью контекста промпта.

## Ручной запуск (по требованию)

Вы можете поставить в очередь системное событие и немедленно запустить heartbeat с помощью:

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

Если у нескольких агентов настроен `heartbeat`, ручной запуск немедленно выполнит
heartbeat каждого из этих агентов.

Используйте `--mode next-heartbeat`, чтобы дождаться следующего запланированного тика.

## Доставка рассуждений (необязательно)

По умолчанию heartbeat доставляет только финальный «ответ».

Если нужна прозрачность, включите:

- `agents.defaults.heartbeat.includeReasoning: true`

При включении heartbeat также будет доставлять отдельное сообщение с префиксом
`Reasoning:` (та же структура, что у `/reasoning on`). Это может быть полезно,
когда агент управляет несколькими сеансами/кодексами и вы хотите видеть, почему он
решил вас уведомить, — но это также может раскрывать больше внутренних деталей,
чем вам нужно. В групповых чатах предпочтительно оставлять выключенным.

## Осознание стоимости

Heartbeat выполняют полноценные ходы агента. Более короткие интервалы сжигают больше токенов. Держите `HEARTBEAT.md` небольшим и рассмотрите более дешёвую `model` или
`target: "none"`, если вам нужны только обновления внутреннего состояния.
