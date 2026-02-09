---
summary: "Настройка Slack для режима Socket или HTTP webhook"
read_when: "Настройка Slack или отладка режимов Slack socket/HTTP"
title: "Slack"
---

# Slack

## Socket mode (по умолчанию)

### Быстрая настройка (для начинающих)

1. Создайте приложение Slack и включите **Socket Mode**.
2. Создайте **App Token** (`xapp-...`) и **Bot Token** (`xoxb-...`).
3. Задайте токены для OpenClaw и запустите Gateway (шлюз).

Минимальный конфиг:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### Настройка

1. Создайте приложение Slack (From scratch) на [https://api.slack.com/apps](https://api.slack.com/apps).
2. **Socket Mode** → включите переключатель. Затем **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** с областью `connections:write`. Скопируйте **App Token** (`xapp-...`).
3. **OAuth & Permissions** → добавьте области доступа bot token (используйте манифест ниже). Нажмите **Install to Workspace**. Скопируйте **Bot User OAuth Token** (`xoxb-...`).
4. Необязательно: **OAuth & Permissions** → добавьте **User Token Scopes** (см. список только для чтения ниже). Переустановите приложение и скопируйте **User OAuth Token** (`xoxp-...`).
5. **Event Subscriptions** → включите события и подпишитесь на:
   - `message.*` (включает правки/удаления/рассылки в тредах)
   - `app_mention`
   - `reaction_added`, `reaction_removed`
   - `member_joined_channel`, `member_left_channel`
   - `channel_rename`
   - `pin_added`, `pin_removed`
6. Пригласите бота в каналы, которые он должен читать.
7. Slash Commands → создайте `/openclaw`, если используете `channels.slack.slashCommand`. Если вы включаете нативные команды, добавьте по одной slash-команде на каждую встроенную команду (с теми же именами, что и `/help`). По умолчанию нативные команды для Slack выключены, если вы не зададите `channels.slack.commands.native: true` (глобальное `commands.native` равно `"auto"`, что оставляет Slack выключенным).
8. App Home → включите **Messages Tab**, чтобы пользователи могли писать боту в личные сообщения.

Используйте манифест ниже, чтобы области доступа и события оставались синхронизированными.

Поддержка нескольких аккаунтов: используйте `channels.slack.accounts` с токенами для каждого аккаунта и необязательным `name`. [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) для общего шаблона.

### Конфигурация OpenClaw (Socket mode)

Установить токены через env vars (рекомендуется):

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

Или через конфиг:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### User token (необязательно)

OpenClaw может использовать пользовательский токен Slack (`xoxp-...`) для операций чтения (история,
закрепы, реакции, emoji, информация об участниках). По умолчанию он остаётся только для чтения: чтение
предпочитает пользовательский токен при его наличии, а запись по‑прежнему использует bot token, если
вы явно не включили иное. Даже при `userTokenReadOnly: false` bot token остаётся
предпочтительным для записи, когда он доступен.

Пользовательские токены настраиваются в конфиге (поддержки env vars нет). Для
нескольких аккаунтов задайте `channels.slack.accounts.<id>.userToken`.

Пример с bot + app + user token:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
    },
  },
}
```

Пример с явно заданным userTokenReadOnly (разрешить запись пользовательским токеном):

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
      userTokenReadOnly: false,
    },
  },
}
```

#### Использование токенов

- Операции чтения (история, список реакций, список закрепов, список emoji, информация об участниках,
  поиск) предпочитают пользовательский токен, если он настроен, иначе bot token.
- Операции записи (отправка/редактирование/удаление сообщений, добавление/удаление реакций, закрепление/открепление,
  загрузка файлов) по умолчанию используют bot token. Если задан `userTokenReadOnly: false` и
  bot token недоступен, OpenClaw переходит на пользовательский токен.

### Контекст истории

- `channels.slack.historyLimit` (или `channels.slack.accounts.*.historyLimit`) управляет тем, сколько последних сообщений канала/группы включается в prompt.
- Используется запасное значение `messages.groupChat.historyLimit`. Установите `0`, чтобы отключить (по умолчанию 50).

## HTTP mode (Events API)

Используйте HTTP webhook режим, когда ваш Gateway (шлюз) доступен для Slack по HTTPS (типично для серверных развёртываний).
HTTP mode использует Events API + Interactivity + Slash Commands с общим URL запроса.

### Настройка (HTTP mode)

1. Создайте приложение Slack и **отключите Socket Mode** (необязательно, если вы используете только HTTP).
2. **Basic Information** → скопируйте **Signing Secret**.
3. **OAuth & Permissions** → установите приложение и скопируйте **Bot User OAuth Token** (`xoxb-...`).
4. **Event Subscriptions** → включите события и задайте **Request URL** на путь webhook вашего шлюза (по умолчанию `/slack/events`).
5. **Interactivity & Shortcuts** → включите и задайте тот же **Request URL**.
6. **Slash Commands** → задайте тот же **Request URL** для ваших команд.

Пример URL запроса:
`https://gateway-host/slack/events`

### Конфигурация OpenClaw (минимальная)

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

HTTP mode с несколькими аккаунтами: задайте `channels.slack.accounts.<id>.mode = "http"` и укажите уникальный
`webhookPath` для каждого аккаунта, чтобы каждое приложение Slack указывало на свой URL.

### Манифест (опционально)

Используйте этот манифест приложения Slack, чтобы быстро создать приложение (при необходимости измените имя/команду). Включите
пользовательские области доступа, если планируете настраивать пользовательский токен.

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ],
      "user": [
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "reactions:read",
        "pins:read",
        "emoji:read",
        "search:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

Если вы включаете нативные команды, добавьте по одному элементу `slash_commands` для каждой команды, которую хотите открыть (в соответствии со списком `/help`). Переопределяйте с помощью `channels.slack.commands.native`.

## Scopes (текущие и необязательные)

Conversations API в Slack типо‑ориентирован: вам нужны только области доступа для тех
типов диалогов, с которыми вы реально работаете (channels, groups, im, mpim). См. См. [https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) для обзора.

### Bot token scopes (обязательные)

- `chat:write` (отправка/обновление/удаление сообщений через `chat.postMessage`)
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- `im:write` (открытие личных сообщений через `conversations.open` для DMs пользователей)
  [https://docs.slack.dev/reference/methods/conversations.open](https://docs.slack.dev/reference/methods/conversations.open)
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
  [https://docs.slack.dev/reference/methods/conversations.history](https://docs.slack.dev/reference/methods/conversations.history)
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
  [https://docs.slack.dev/reference/methods/conversations.info](https://docs.slack.dev/reference/methods/conversations.info)
- `users:read` (поиск пользователей)
  [https://docs.slack.dev/reference/methods/users.info](https://docs.slack.dev/reference/methods/users.info)
- `reactions:read`, `reactions:write` (`reactions.get` / `reactions.add`)
  [https://docs.slack.dev/reference/methods/reactions.get](https://docs.slack.dev/reference/methods/reactions.get)
  [https://docs.slack.dev/reference/methods/reactions.add](https://docs.slack.dev/reference/methods/reactions.add)
- `pins:read`, `pins:write` (`pins.list` / `pins.add` / `pins.remove`)
  [https://docs.slack.dev/reference/scopes/pins.read](https://docs.slack.dev/reference/scopes/pins.read)
  [https://docs.slack.dev/reference/scopes/pins.write](https://docs.slack.dev/reference/scopes/pins.write)
- `emoji:read` (`emoji.list`)
  [https://docs.slack.dev/reference/scopes/emoji.read](https://docs.slack.dev/reference/scopes/emoji.read)
- `files:write` (загрузки через `files.uploadV2`)
  [https://docs.slack.dev/messaging/working-with-files/#upload](https://docs.slack.dev/messaging/working-with-files/#upload)

### User token scopes (необязательные, по умолчанию только чтение)

Добавьте их в **User Token Scopes**, если настраиваете `channels.slack.userToken`.

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### Пока не требуется (но вероятно в будущем)

- `mpim:write` (только если мы добавим открытие group-DM/старт DM через `conversations.open`)
- `groups:write` (только если мы добавим управление приватными каналами: создание/переименование/приглашение/архивация)
- `chat:write.public` (только если нужно публиковать в каналы, где бота нет)
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)
- `users:read.email` (только если нам нужны поля email из `users.info`)
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)
- `files:read` (только если начнём перечислять/читать метаданные файлов)

## Конфиг

Slack использует только Socket Mode (без HTTP webhook сервера). Укажите оба токена:

```json
{
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "groupPolicy": "allowlist",
    "dm": {
      "enabled": true,
      "policy": "pairing",
      "allowFrom": ["U123", "U456", "*"],
      "groupEnabled": false,
      "groupChannels": ["G123"],
      "replyToMode": "all"
    },
    "channels": {
      "C123": { "allow": true, "requireMention": true },
      "#general": {
        "allow": true,
        "requireMention": true,
        "users": ["U123"],
        "skills": ["search", "docs"],
        "systemPrompt": "Keep answers short."
      }
    },
    "reactionNotifications": "own",
    "reactionAllowlist": ["U123"],
    "replyToMode": "off",
    "actions": {
      "reactions": true,
      "messages": true,
      "pins": true,
      "memberInfo": true,
      "emojiList": true
    },
    "slashCommand": {
      "enabled": true,
      "name": "openclaw",
      "sessionPrefix": "slack:slash",
      "ephemeral": true
    },
    "textChunkLimit": 4000,
    "mediaMaxMb": 20
  }
}
```

Токены также могут быть поставлены через env vars:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

Ack‑реакции управляются глобально через `messages.ackReaction` +
`messages.ackReactionScope`. Используйте `messages.removeAckAfterReply`, чтобы очистить
ack‑реакцию после ответа бота.

## Ограничения

- Исходящий текст разбивается на части по `channels.slack.textChunkLimit` (по умолчанию 4000).
- Необязательное разбиение по новым строкам: задайте `channels.slack.chunkMode="newline"`, чтобы сначала делить по пустым строкам (границы абзацев) перед разбиением по длине.
- Загрузка медиа ограничена `channels.slack.mediaMaxMb` (по умолчанию 20).

## Треды ответов

По умолчанию OpenClaw отвечает в основном канале. Используйте `channels.slack.replyToMode` для управления автоматическим тредингом:

| Режим   | Поведение                                                                                                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`   | **По умолчанию.** Ответ в основном канале. В тред — только если исходное сообщение уже было в треде.                                               |
| `first` | Первый ответ уходит в тред (под исходным сообщением), последующие — в основной канал. Полезно для сохранения контекста без захламления тредами. |
| `all`   | Все ответы уходят в тред. Сохраняет диалоги компактными, но может снижать видимость.                                                                               |

Режим применяется как к автоответам, так и к вызовам инструментов агента (`slack sendMessage`).

### Трединг по типам чатов

Вы можете настроить разное поведение трединга для каждого типа чата, задав `channels.slack.replyToModeByChatType`:

```json5
{
  channels: {
    slack: {
      replyToMode: "off", // default for channels
      replyToModeByChatType: {
        direct: "all", // DMs always thread
        group: "first", // group DMs/MPIM thread first reply
      },
    },
  },
}
```

Поддерживаемые типы чатов:

- `direct`: личные сообщения 1:1 (Slack `im`)
- `group`: групповые DMs / MPIMs (Slack `mpim`)
- `channel`: обычные каналы (публичные/приватные)

Приоритеты:

1. `replyToModeByChatType.<chatType>`
2. `replyToMode`
3. Значение по умолчанию провайдера (`off`)

Устаревший `channels.slack.dm.replyToMode` по‑прежнему принимается как запасной вариант для `direct`, если не задано переопределение по типу чата.

Примеры:

Тредить только DMs:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { direct: "all" },
    },
  },
}
```

Тредить групповые DMs, но оставлять каналы в корне:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { group: "first" },
    },
  },
}
```

Сделать каналы тредами, а DMs оставить в корне:

```json5
{
  channels: {
    slack: {
      replyToMode: "first",
      replyToModeByChatType: { direct: "off", group: "off" },
    },
  },
}
```

### Ручные теги трединга

Для тонкой настройки используйте эти теги в ответах агента:

- `[[reply_to_current]]` — ответить на исходное сообщение (начать/продолжить тред).
- `[[reply_to:<id>]]` — ответить на конкретный id сообщения.

## Сессии и маршрутизация

- DMs используют общую сессию `main` (как WhatsApp/Telegram).
- Каналы сопоставляются с сессиями `agent:<agentId>:slack:channel:<channelId>`.
- Slash‑команды используют сессии `agent:<agentId>:slack:slash:<userId>` (префикс настраивается через `channels.slack.slashCommand.sessionPrefix`).
- Если Slack не предоставляет `channel_type`, OpenClaw выводит его из префикса id канала (`D`, `C`, `G`) и по умолчанию использует `channel`, чтобы ключи сессий оставались стабильными.
- Регистрация нативных команд использует `commands.native` (глобальное значение по умолчанию `"auto"` → Slack выключен) и может быть переопределена для рабочего пространства через `channels.slack.commands.native`. Текстовые команды требуют отдельных сообщений `/...` и могут быть отключены через `commands.text: false`. Slack slash‑команды управляются в приложении Slack и автоматически не удаляются. Используйте `commands.useAccessGroups: false`, чтобы обходить проверки групп доступа для команд.
- Полный список команд и конфигурация: [Slash commands](/tools/slash-commands)

## Безопасность ТМ (пар)

- По умолчанию: `channels.slack.dm.policy="pairing"` — неизвестные отправители DMs получают код сопряжения (истекает через 1 час).
- Подтверждение через: `openclaw pairing approve slack <code>`.
- Чтобы разрешить всем: задайте `channels.slack.dm.policy="open"` и `channels.slack.dm.allowFrom=["*"]`.
- `channels.slack.dm.allowFrom` принимает id пользователей, @хэндлы или email (разрешаются при старте, когда токены позволяют). Мастер настройки принимает имена пользователей и разрешает их в id во время настройки, когда токены позволяют.

## Политика групп

- `channels.slack.groupPolicy` управляет обработкой каналов (`open|disabled|allowlist`).
- `allowlist` требует, чтобы каналы были перечислены в `channels.slack.channels`.
- Если вы задаёте только `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` и никогда не создаёте раздел `channels.slack`,
  значения по умолчанию во время выполнения устанавливают `groupPolicy` в `open`. Добавьте `channels.slack.groupPolicy`,
  `channels.defaults.groupPolicy` или allowlist каналов, чтобы зафиксировать политику.
- Мастер конфигурации принимает имена `#channel` и по возможности разрешает их в ID
  (публичные + приватные); при нескольких совпадениях предпочитается активный канал.
- При старте OpenClaw разрешает имена каналов/пользователей в allowlist в ID (когда токены позволяют)
  и логирует сопоставление; неразрешённые записи сохраняются как введены.
- Чтобы разрешить **ни одного канала**, задайте `channels.slack.groupPolicy: "disabled"` (или оставьте allowlist пустым).

Параметры каналов (`channels.slack.channels.<id>` или `channels.slack.channels.<name>`):

- `allow`: разрешить/запретить канал, когда `groupPolicy="allowlist"`.
- `requireMention`: контроль упоминаний для канала.
- `tools`: необязательные переопределения политик инструментов на канал (`allow`/`deny`/`alsoAllow`).
- `toolsBySender`: необязательные переопределения политик инструментов для отправителей внутри канала (ключи — id отправителей/@хэндлы/email; поддерживается wildcard `"*"`).
- `allowBots`: разрешить сообщения, созданные ботом, в этом канале (по умолчанию: false).
- `users`: необязательный allowlist пользователей для канала.
- `skills`: фильтр Skills (пропуск = все Skills, пусто = ни одной).
- `systemPrompt`: дополнительный системный prompt для канала (объединяется с темой/назначением).
- `enabled`: установите `false`, чтобы отключить канал.

## Цели доставки

Используйте их с отправками через cron/CLI:

- `user:<id>` для DMs
- `channel:<id>` для каналов

## Действия инструментов

Действия инструментов Slack можно ограничивать через `channels.slack.actions.*`:

| Группа действий | По умолчанию | Примечания                              |
| --------------- | ------------ | --------------------------------------- |
| reactions       | enabled      | Реакции + список реакций                |
| messages        | enabled      | Чтение/отправка/редактирование/удаление |
| pins            | enabled      | Закрепить/открепить/список              |
| memberInfo      | enabled      | Информация об участниках                |
| emojiList       | enabled      | Список кастомных emoji                  |

## Примечания по безопасности

- Операции записи по умолчанию используют bot token, чтобы изменения состояния оставались в рамках
  прав и идентичности бота приложения.
- Установка `userTokenReadOnly: false` позволяет использовать пользовательский токен для операций
  записи, когда bot token недоступен, что означает выполнение действий с правами
  пользователя, установившего приложение. Рассматривайте пользовательский токен как высокопривилегированный и держите ограничения действий и allowlist максимально жёсткими.
- Если вы включаете запись пользовательским токеном, убедитесь, что он включает ожидаемые
  области доступа на запись (`chat:write`, `reactions:write`, `pins:write`,
  `files:write`), иначе эти операции завершатся ошибкой.

## Устранение неполадок

Сначала запустите лестницу:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Затем при необходимости проверьте состояние сопряжения DMs:

```bash
openclaw pairing list slack
```

Частые сбои:

- Подключено, но нет ответов в каналах: канал заблокирован `groupPolicy` или отсутствует в allowlist `channels.slack.channels`.
- DMs игнорируются: отправитель не одобрен при `channels.slack.dm.policy="pairing"`.
- Ошибки API (`missing_scope`, `not_in_channel`, ошибки аутентификации): токены бота/приложения или области доступа Slack неполные.

схему триажа: [/channels/troubleshooting](/channels/troubleshooting).

## Примечания

- Контроль упоминаний управляется через `channels.slack.channels` (установите `requireMention` в `true`); `agents.list[].groupChat.mentionPatterns` (или `messages.groupChat.mentionPatterns`) также считаются упоминаниями.
- Переопределение для нескольких агентов: задайте шаблоны для каждого агента в `agents.list[].groupChat.mentionPatterns`.
- Уведомления о реакциях следуют `channels.slack.reactionNotifications` (используйте `reactionAllowlist` с режимом `allowlist`).
- Сообщения, созданные ботом, по умолчанию игнорируются; включите через `channels.slack.allowBots` или `channels.slack.channels.<id>.allowBots`.
- Предупреждение: если вы разрешаете ответы другим ботам (`channels.slack.allowBots=true` или `channels.slack.channels.<id>.allowBots=true`), предотвращайте циклы ответов ботов с помощью allowlist `requireMention`, `channels.slack.channels.<id>.users` и/или жёстких ограничений в `AGENTS.md` и `SOUL.md`.
- Для инструмента Slack семантика удаления реакций описана в [/tools/reactions](/tools/reactions).
- Вложения загружаются в хранилище медиа при наличии разрешений и если размер не превышает лимит.
