---
summary: "Поведение групповых чатов на разных платформах (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - Изменение поведения групповых чатов или управления упоминаниями
title: "Группы"
---

# Группы

OpenClaw единообразно обрабатывает групповые чаты на разных платформах: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams.

## Введение для начинающих (2 минуты)

OpenClaw «живет» в ваших собственных мессенджер‑аккаунтах. Отдельного пользователя‑бота WhatsApp не существует.
Если **вы** состоите в группе, OpenClaw может видеть эту группу и отвечать в ней.

Поведение по умолчанию:

- Группы ограничены (`groupPolicy: "allowlist"`).
- Для ответов требуется упоминание, если вы явно не отключили управление упоминаниями.

Перевод: авторизованные отправители могут вызывать OpenClaw, упоминая его.

> TL;DR
>
> - **Доступ к личным сообщениям (DM)** управляется через `*.allowFrom`.
> - **Доступ к группам** управляется через `*.groupPolicy` + списки разрешённых (`*.groups`, `*.groupAllowFrom`).
> - **Триггер ответа** управляется управлением упоминаниями (`requireMention`, `/activation`).

Краткий поток (что происходит с групповым сообщением):

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Поток групповых сообщений](/images/groups-flow.svg)

Если вам нужно...

| Цель                                                                 | Что установить                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Разрешить все группы, но отвечать только на @упоминания | `groups: { "*": { requireMention: true } }`                              |
| Отключить все ответы в группах                                       | `groupPolicy: "disabled"`                                                |
| Только определённые группы                                           | `groups: { "<group-id>": { ... } }` (без ключа `"*"`) |
| Только вы можете вызывать в группах                                  | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]`               |

## Ключи сеансов

- Групповые сеансы используют ключи сеансов `agent:<agentId>:<channel>:group:<id>` (комнаты/каналы используют `agent:<agentId>:<channel>:channel:<id>`).
- Темы форумов Telegram добавляют `:topic:<threadId>` к идентификатору группы, поэтому каждая тема имеет собственный сеанс.
- Прямые чаты используют основной сеанс (или отдельный для каждого отправителя, если настроено).
- Сигналы keepalive пропускаются для групповых сеансов.

## Паттерн: личные DM + публичные группы (один агент)

Да — это хорошо работает, если ваш «личный» трафик — это **DM**, а «публичный» трафик — **группы**.

Почему: в режиме одного агента DM обычно попадают в **основной** ключ сеанса (`agent:main:main`), тогда как группы всегда используют **неосновные** ключи сеансов (`agent:main:<channel>:group:<id>`). Если включить sandboxing с помощью `mode: "non-main"`, эти групповые сеансы выполняются в Docker, в то время как основной DM‑сеанс остаётся на хосте.

Это даёт вам один «мозг» агента (общее рабочее пространство + память), но две модели исполнения:

- **DM**: полный набор инструментов (хост)
- **Группы**: sandbox + ограниченные инструменты (Docker)

> Если вам нужны действительно раздельные рабочие пространства/персоны («личное» и «публичное» никогда не должны смешиваться), используйте второго агента + привязки. См. [Маршрутизация нескольких агентов](/concepts/multi-agent).

Пример (DM на хосте, группы — в sandbox + только инструменты для обмена сообщениями):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // groups/channels are non-main -> sandboxed
        scope: "session", // strongest isolation (one container per group/channel)
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // If allow is non-empty, everything else is blocked (deny still wins).
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

Нужно «группы могут видеть только папку X» вместо «нет доступа к хосту»? Оставьте `workspaceAccess: "none"` и смонтируйте в sandbox только разрешённые пути:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
        docker: {
          binds: [
            // hostPath:containerPath:mode
            "~/FriendsShared:/data:ro",
          ],
        },
      },
    },
  },
}
```

Связанное:

- Ключи конфигурации и значения по умолчанию: [Конфигурация Gateway (шлюз)](/gateway/configuration#agentsdefaultssandbox)
- Отладка причин блокировки инструмента: [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- Детали bind‑mount: [Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## Отображаемые метки

- Метки интерфейса используют `displayName` при наличии, в формате `<channel>:<token>`.
- `#room` зарезервирован для комнат/каналов; групповые чаты используют `g-<slug>` (нижний регистр, пробелы → `-`, сохранять `#@+._-`).

## Политика групп

Управление обработкой сообщений групп/комнат по каждому каналу:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789", "@username"],
    },
    signal: {
      groupPolicy: "disabled",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "disabled",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "disabled",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: { channels: { help: { allow: true } } },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
    matrix: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["@owner:example.org"],
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
    },
  },
}
```

| Политика      | Поведение                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `"open"`      | Группы обходят списки разрешённых; управление упоминаниями всё ещё применяется.   |
| `"disabled"`  | Полностью блокировать все групповые сообщения.                                    |
| `"allowlist"` | Разрешать только группы/комнаты, соответствующие настроенному списку разрешённых. |

Примечания:

- `groupPolicy` отделён от управления упоминаниями (которое требует @упоминаний).
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: используйте `groupAllowFrom` (fallback: явный `allowFrom`).
- Discord: список разрешённых использует `channels.discord.guilds.<id>.channels`.
- Slack: список разрешённых использует `channels.slack.channels`.
- Matrix: список разрешённых использует `channels.matrix.groups` (ID комнат, алиасы или имена). Используйте `channels.matrix.groupAllowFrom` для ограничения отправителей; также поддерживаются списки разрешённых `users` на уровне комнаты.
- Групповые DM управляются отдельно (`channels.discord.dm.*`, `channels.slack.dm.*`).
- Список разрешённых Telegram может сопоставляться с ID пользователей (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) или с именами пользователей (`"@alice"` или `"alice"`); префиксы нечувствительны к регистру.
- Значение по умолчанию — `groupPolicy: "allowlist"`; если список разрешённых групп пуст, групповые сообщения блокируются.

Краткая ментальная модель (порядок оценки для групповых сообщений):

1. `groupPolicy` (open/disabled/allowlist)
2. списки разрешённых групп (`*.groups`, `*.groupAllowFrom`, список разрешённых конкретного канала)
3. управление упоминаниями (`requireMention`, `/activation`)

## Управление упоминаниями (по умолчанию)

Групповые сообщения требуют упоминания, если это не переопределено для конкретной группы. Значения по умолчанию задаются для каждой подсистемы в `*.groups."*"`.

Ответ на сообщение бота считается неявным упоминанием (когда канал поддерживает метаданные ответа). Это применимо к Telegram, WhatsApp, Slack, Discord и Microsoft Teams.

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
        "123@g.us": { requireMention: false },
      },
    },
    telegram: {
      groups: {
        "*": { requireMention: true },
        "123456789": { requireMention: false },
      },
    },
    imessage: {
      groups: {
        "*": { requireMention: true },
        "123": { requireMention: false },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          mentionPatterns: ["@openclaw", "openclaw", "\\+15555550123"],
          historyLimit: 50,
        },
      },
    ],
  },
}
```

Примечания:

- `mentionPatterns` — это регексы, нечувствительные к регистру.
- Платформы с явными упоминаниями всё равно проходят; шаблоны — это fallback.
- Переопределение на уровне агента: `agents.list[].groupChat.mentionPatterns` (полезно, когда несколько агентов разделяют группу).
- Управление упоминаниями применяется только тогда, когда обнаружение упоминаний возможно (нативные упоминания или настроены `mentionPatterns`).
- Значения по умолчанию для Discord находятся в `channels.discord.guilds."*"` (можно переопределять для сервера/канала).
- Контекст истории группы унифицирован для всех каналов и является **только ожидающим** (сообщения, пропущенные из‑за управления упоминаниями); используйте `messages.groupChat.historyLimit` для глобального значения по умолчанию и `channels.<channel>.historyLimit` (или `channels.<channel>.accounts.*.historyLimit`) для переопределений. Установите `0`, чтобы отключить.

## Ограничения инструментов для групп/каналов (необязательно)

Некоторые конфигурации каналов поддерживают ограничение доступных инструментов **внутри конкретной группы/комнаты/канала**.

- `tools`: разрешить/запретить инструменты для всей группы.
- `toolsBySender`: переопределения для отдельных отправителей внутри группы (ключи — ID отправителей/имена пользователей/email/номера телефонов в зависимости от канала). Используйте `"*"` как wildcard.

Порядок разрешения (самый специфичный имеет приоритет):

1. совпадение `toolsBySender` группы/канала
2. `tools` группы/канала
3. значение по умолчанию (`"*"`) — совпадение `toolsBySender`
4. значение по умолчанию (`"*"`) — `tools`

Пример (Telegram):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { tools: { deny: ["exec"] } },
        "-1001234567890": {
          tools: { deny: ["exec", "read", "write"] },
          toolsBySender: {
            "123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

Примечания:

- Ограничения инструментов для групп/каналов применяются дополнительно к глобальной/агентной политике инструментов (запрет всё равно имеет приоритет).
- Некоторые каналы используют другую вложенность для комнат/каналов (например, Discord `guilds.*.channels.*`, Slack `channels.*`, MS Teams `teams.*.channels.*`).

## Списки разрешённых групп

Когда настроены `channels.whatsapp.groups`, `channels.telegram.groups` или `channels.imessage.groups`, эти ключи действуют как список разрешённых групп. Используйте `"*"`, чтобы разрешить все группы, сохранив поведение упоминаний по умолчанию.

Общие намерения (копия/вставка):

1. Отключить все ответы в группах

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. Разрешить только определённые группы (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "123@g.us": { requireMention: true },
        "456@g.us": { requireMention: false },
      },
    },
  },
}
```

3. Разрешить все группы, но требовать упоминание (явно)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. Только владелец может вызывать в группах (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## Активация (только владелец)

Владельцы групп могут переключать активацию для каждой группы:

- `/activation mention`
- `/activation always`

Владелец определяется через `channels.whatsapp.allowFrom` (или собственный E.164 бота, если не задано). Отправляйте команду отдельным сообщением. Другие платформы в настоящее время игнорируют `/activation`.

## Поля контекста

Входящие полезные нагрузки группы устанавливают:

- `ChatType=group`
- `GroupSubject` (если известно)
- `GroupMembers` (если известно)
- `Отменено` (упоминание результата ворот)
- Темы форумов Telegram также включают `MessageThreadId` и `IsForum`.

Системный prompt агента включает вступление для группы на первом ходе нового группового сеанса. Он напоминает модели отвечать как человек, избегать Markdown‑таблиц и не выводить буквальные последовательности `\n`.

## Особенности iMessage

- При маршрутизации или формировании списка разрешённых предпочитайте `chat_id:<id>`.
- Список чатов: `imsg chats --limit 20`.
- Ответы в группах всегда возвращаются в тот же `chat_id`.

## Особенности WhatsApp

[Групповые сообщения](/channels/group-messages) для поведения, специфичного для WhatsApp (внедрение истории, детали обработки упоминаний).
