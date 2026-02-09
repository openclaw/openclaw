---
summary: "Статус поддержки Discord-бота, возможности и конфигурация"
read_when:
  - Работа над возможностями канала Discord
title: "Discord"
---

# Discord (Bot API)

Статус: готов для личных сообщений (DM) и текстовых каналов серверов (guild) через официальный шлюз Discord для ботов.

## Быстрая настройка (для начинающих)

1. Создайте Discord-бота и скопируйте токен бота.
2. В настройках приложения Discord включите **Message Content Intent** (и **Server Members Intent**, если планируете использовать списки разрешённых или поиск по именам).
3. Задайте токен для OpenClaw:
   - Env: `DISCORD_BOT_TOKEN=...`
   - Или конфиг: `channels.discord.token: "..."`.
   - Если заданы оба варианта, приоритет у конфига (env используется как запасной вариант только для аккаунта по умолчанию).
4. Пригласите бота на свой сервер с правами на сообщения (создайте приватный сервер, если вам нужны только DM).
5. Запустите Gateway (шлюз).
6. Доступ к DM по умолчанию требует сопряжения; подтвердите код сопряжения при первом контакте.

Минимальный конфиг:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

## Цели

- Общение с OpenClaw через DM в Discord или каналы серверов.
- Прямые чаты сворачиваются в основной сеанс агента (по умолчанию `agent:main:main`); каналы серверов остаются изолированными как `agent:<agentId>:discord:channel:<channelId>` (отображаемые имена используют `discord:<guildSlug>#<channelSlug>`).
- Групповые DM по умолчанию игнорируются; включаются через `channels.discord.dm.groupEnabled` и при необходимости ограничиваются с помощью `channels.discord.dm.groupChannels`.
- Детерминированная маршрутизация: ответы всегда возвращаются в тот канал, откуда пришли.

## Как это работает

1. Создайте приложение Discord → Bot, включите нужные intents (DM + сообщения серверов + содержимое сообщений) и получите токен бота.
2. Пригласите бота на сервер с правами, необходимыми для чтения/отправки сообщений там, где вы хотите его использовать.
3. Сконфигурируйте OpenClaw с помощью `channels.discord.token` (или `DISCORD_BOT_TOKEN` как запасной вариант).
4. Запустите Gateway (шлюз); он автоматически запускает канал Discord, когда доступен токен (сначала конфиг, затем env как запасной вариант) и `channels.discord.enabled` не равно `false`.
   - Если предпочитаете переменные окружения, установите `DISCORD_BOT_TOKEN` (блок конфига необязателен).
5. Прямые чаты: при доставке используйте `user:<id>` (или упоминание `<@id>`); все реплики попадают в общий сеанс `main`. «Голые» числовые идентификаторы неоднозначны и отклоняются.
6. Каналы серверов: используйте `channel:<channelId>` для доставки. Упоминания требуются по умолчанию и могут настраиваться для каждого сервера или канала.
7. Прямые чаты: по умолчанию защищены через `channels.discord.dm.policy` (значение по умолчанию: `"pairing"`). Неизвестные отправители получают код сопряжения (истекает через 1 час); подтвердите через `openclaw pairing approve discord <code>`.
   - Чтобы сохранить старое поведение «открыто для всех»: установите `channels.discord.dm.policy="open"` и `channels.discord.dm.allowFrom=["*"]`.
   - Для жёсткого списка разрешённых: установите `channels.discord.dm.policy="allowlist"` и перечислите отправителей в `channels.discord.dm.allowFrom`.
   - Чтобы игнорировать все DM: установите `channels.discord.dm.enabled=false` или `channels.discord.dm.policy="disabled"`.
8. Групповые DM по умолчанию игнорируются; включите через `channels.discord.dm.groupEnabled` и при необходимости ограничьте с помощью `channels.discord.dm.groupChannels`.
9. Необязательные правила серверов: задайте `channels.discord.guilds`, ключами — id сервера (предпочтительно) или slug, с правилами на уровне каналов.
10. Необязательные нативные команды: `commands.native` по умолчанию равен `"auto"` (включено для Discord/Telegram, выключено для Slack). Переопределяется через `channels.discord.commands.native: true|false|"auto"`; `false` очищает ранее зарегистрированные команды. Текстовые команды управляются через `commands.text` и должны отправляться как отдельные сообщения `/...`. Используйте `commands.useAccessGroups: false`, чтобы обойти проверки групп доступа для команд.
    - Полный список команд и конфиг: [Slash commands](/tools/slash-commands)
11. Необязательная история контекста сервера: установите `channels.discord.historyLimit` (по умолчанию 20, с откатом к `messages.groupChat.historyLimit`), чтобы включать последние N сообщений сервера как контекст при ответе на упоминание. Установите `0` для отключения.
12. Реакции: агент может инициировать реакции через инструмент `discord` (ограничивается `channels.discord.actions.*`).
    - Семантика удаления реакций: см. [/tools/reactions](/tools/reactions).
    - Инструмент `discord` доступен только когда текущий канал — Discord.
13. Нативные команды используют изолированные ключи сеансов (`agent:<agentId>:discord:slash:<userId>`), а не общий сеанс `main`.

Примечание: Разрешение «имя → id» использует поиск участников сервера и требует Server Members Intent; если бот не может искать участников, используйте id или упоминания `<@id>`.
Примечание: Slug — это нижний регистр, пробелы заменяются на `-`. Имена каналов приводятся к slug без ведущего `#`.
Примечание: Строки контекста сервера `[from:]` включают `author.tag` + `id`, чтобы упростить ответы с пингами.

## Запись конфига

По умолчанию Discord разрешено записывать обновления конфига, инициированные `/config set|unset` (требуется `commands.config: true`).

Отключить:

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## Как создать собственного бота

Это настройка в «Discord Developer Portal» для запуска OpenClaw в канале сервера (guild), например `#help`.

### 1. Создайте приложение Discord + пользователя-бота

1. Discord Developer Portal → **Applications** → **New Application**
2. В приложении:
   - **Bot** → **Add Bot**
   - Скопируйте **Bot Token** (это значение указывается в `DISCORD_BOT_TOKEN`)

### 2) Включите intents шлюза, необходимые OpenClaw

Discord блокирует «привилегированные intents», если вы явно их не включили.

В **Bot** → **Privileged Gateway Intents** включите:

- **Message Content Intent** (обязательно для чтения текста сообщений в большинстве серверов; без него вы увидите «Used disallowed intents» или бот подключится, но не будет реагировать)
- **Server Members Intent** (рекомендуется; требуется для некоторых поисков участников/пользователей и сопоставления списков разрешённых на серверах)

Обычно **Presence Intent** не нужен. Установка собственного статуса бота (действие `setPresence`) использует gateway OP3 и не требует этого intent; он нужен только если вы хотите получать обновления статусов других участников сервера.

### 3. Сгенерируйте URL приглашения (OAuth2 URL Generator)

В приложении: **OAuth2** → **URL Generator**

**Scopes**

- ✅ `bot`
- ✅ `applications.commands` (обязательно для нативных команд)

**Bot Permissions** (минимальный набор)

- ✅ View Channels
- ✅ Send Messages
- ✅ Read Message History
- ✅ Embed Links
- ✅ Attach Files
- ✅ Add Reactions (необязательно, но рекомендуется)
- ✅ Use External Emojis / Stickers (необязательно; только если нужно)

Избегайте **Administrator**, если только вы не отлаживаете и полностью не доверяете боту.

Скопируйте сгенерированный URL, откройте его, выберите сервер и установите бота.

### 4. Получите идентификаторы (guild/user/channel)

Discord везде использует числовые id; конфиг OpenClaw предпочитает id.

1. Discord (desktop/web) → **User Settings** → **Advanced** → включите **Developer Mode**
2. Правый клик:
   - Имя сервера → **Copy Server ID** (id сервера)
   - Канал (например, `#help`) → **Copy Channel ID**
   - Ваш пользователь → **Copy User ID**

### 5) Настройте OpenClaw

#### Токен

Задайте токен бота через переменную окружения (рекомендуется на серверах):

- `DISCORD_BOT_TOKEN=...`

Или через конфиг:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

Поддержка нескольких аккаунтов: используйте `channels.discord.accounts` с токенами для каждого аккаунта и необязательным `name`. [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) для общего шаблона.

#### Список разрешённых + маршрутизация каналов

Пример «один сервер, разрешить только мне, только #help»:

```json5
{
  channels: {
    discord: {
      enabled: true,
      dm: { enabled: false },
      guilds: {
        YOUR_GUILD_ID: {
          users: ["YOUR_USER_ID"],
          requireMention: true,
          channels: {
            help: { allow: true, requireMention: true },
          },
        },
      },
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

Примечания:

- `requireMention: true` означает, что бот отвечает только при упоминании (рекомендуется для общих каналов).
- `agents.list[].groupChat.mentionPatterns` (или `messages.groupChat.mentionPatterns`) также считаются упоминаниями для сообщений сервера.
- Переопределение для нескольких агентов: задайте шаблоны для каждого агента в `agents.list[].groupChat.mentionPatterns`.
- Если присутствует `channels`, любой неуказанный канал по умолчанию запрещён.
- Используйте запись канала `"*"`, чтобы применить значения по умолчанию ко всем каналам; явные записи каналов переопределяют wildcard.
- Треды наследуют конфигурацию родительского канала (список разрешённых, `requireMention`, навыки, промпты и т. д.), если вы явно не добавите id треда. если вы не добавите идентификатор канала потока явно.
- Подсказка владельца: когда список разрешённых `users` на уровне сервера или канала совпадает с отправителем, OpenClaw считает этого отправителя владельцем в системном промпте. Для глобального владельца во всех каналах установите `commands.ownerAllowFrom`.
- Сообщения, созданные ботом, по умолчанию игнорируются; установите `channels.discord.allowBots=true`, чтобы разрешить их (собственные сообщения всё равно фильтруются).
- Предупреждение: если вы разрешаете ответы другим ботам (`channels.discord.allowBots=true`), предотвратите циклы «бот↔бот» с помощью списков разрешённых `requireMention`, `channels.discord.guilds.*.channels.<id>.users` и/или очистите ограничители в `AGENTS.md` и `SOUL.md`.

### 6. Проверьте работу

1. Запустите Gateway (шлюз).
2. В канале сервера отправьте: `@Krill hello` (или имя вашего бота).
3. Если ничего не происходит: проверьте раздел **Устранение неполадок** ниже.

### Устранение неполадок

- Сначала: выполните `openclaw doctor` и `openclaw channels status --probe` (предупреждения с действиями + быстрые проверки).
- **«Used disallowed intents»**: включите **Message Content Intent** (и, вероятно, **Server Members Intent**) в Developer Portal, затем перезапустите Gateway (шлюз).
- **Бот подключается, но не отвечает в канале сервера**:
  - Отсутствует **Message Content Intent**, или
  - У бота нет прав канала (View/Send/Read History), или
  - Конфиг требует упоминаний, а вы не упомянули бота, или
  - Список разрешённых сервера/канала запрещает канал/пользователя.
- **`requireMention: false`, но ответов всё равно нет**:
- `channels.discord.groupPolicy` по умолчанию равен **allowlist**; установите `"open"` или добавьте запись сервера в `channels.discord.guilds` (при необходимости перечислите каналы в `channels.discord.guilds.<id>.channels` для ограничения).
  - Если вы установили только `DISCORD_BOT_TOKEN` и никогда не создавали раздел `channels.discord`, во время выполнения
    значение `groupPolicy` по умолчанию устанавливается в `open`. Добавьте `channels.discord.groupPolicy`,
    `channels.defaults.groupPolicy` или список разрешённых сервера/канала, чтобы зафиксировать ограничения.
- `requireMention` должен находиться под `channels.discord.guilds` (или конкретным каналом). `channels.discord.requireMention` на верхнем уровне игнорируется.
- **Аудиты прав** (`channels status --probe`) проверяют только числовые id каналов. Если вы используете slug/имена как ключи `channels.discord.guilds.*.channels`, аудит не сможет проверить права.
- **DM не работают**: `channels.discord.dm.enabled=false`, `channels.discord.dm.policy="disabled"` или вы ещё не одобрены (`channels.discord.dm.policy="pairing"`).
- **Подтверждения выполнения (exec approvals) в Discord**: Discord поддерживает **UI с кнопками** для подтверждений в DM (Allow once / Always allow / Deny). `/approve <id> ...` используется только для пересылаемых подтверждений и не решает запросы с кнопками Discord. Если вы видите `❌ Failed to submit approval: Error: unknown approval id` или UI не появляется, проверьте:
  - `channels.discord.execApprovals.enabled: true` в конфиге.
  - Ваш Discord user id указан в `channels.discord.execApprovals.approvers` (UI отправляется только утверждающим).
  - Используйте кнопки в DM (**Allow once**, **Always allow**, **Deny**).
  - См. [Exec approvals](/tools/exec-approvals) и [Slash commands](/tools/slash-commands) для общего потока подтверждений и команд.

## Возможности и ограничения

- DM и текстовые каналы серверов (треды считаются отдельными каналами; голос не поддерживается).
- Индикаторы набора текста отправляются по возможности; разбиение сообщений использует `channels.discord.textChunkLimit` (по умолчанию 2000) и делит длинные ответы по количеству строк (`channels.discord.maxLinesPerMessage`, по умолчанию 17).
- Необязательное разбиение по переносам строк: установите `channels.discord.chunkMode="newline"`, чтобы сначала делить по пустым строкам (границы абзацев), а затем по длине.
- Загрузка файлов поддерживается до настроенного значения `channels.discord.mediaMaxMb` (по умолчанию 8 МБ).
- Ответы в каналах серверов по умолчанию требуют упоминания, чтобы избежать «шумных» ботов.
- Контекст ответа внедряется, когда сообщение ссылается на другое сообщение (цитируемое содержимое + id).
- Нативное тредирование ответов **выключено по умолчанию**; включается через `channels.discord.replyToMode` и теги ответов.

## Политика повторов

Исходящие вызовы Discord API повторяются при ограничениях скорости (429) с использованием Discord `retry_after` при наличии, с экспоненциальной задержкой и jitter. Настраивается через `channels.discord.retry`. См. [Retry policy](/concepts/retry).

## Конфиг

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "abc.123",
      groupPolicy: "allowlist",
      guilds: {
        "*": {
          channels: {
            general: { allow: true },
          },
        },
      },
      mediaMaxMb: 8,
      actions: {
        reactions: true,
        stickers: true,
        emojiUploads: true,
        stickerUploads: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        channels: true,
        voiceStatus: true,
        events: true,
        moderation: false,
        presence: false,
      },
      replyToMode: "off",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["123456789012345678", "steipete"],
        groupEnabled: false,
        groupChannels: ["openclaw-dm"],
      },
      guilds: {
        "*": { requireMention: true },
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          reactionNotifications: "own",
          users: ["987654321098765432", "steipete"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["search", "docs"],
              systemPrompt: "Keep answers short.",
            },
          },
        },
      },
    },
  },
}
```

Реакции подтверждения (ack) управляются глобально через `messages.ackReaction` +
`messages.ackReactionScope`. Используйте `messages.removeAckAfterReply`, чтобы очистить
реакцию подтверждения после ответа бота.

- `dm.enabled`: установите `false`, чтобы игнорировать все DM (по умолчанию `true`).
- `dm.policy`: контроль доступа к DM (рекомендуется `pairing`). `"open"` требует `dm.allowFrom=["*"]`.
- `dm.allowFrom`: список разрешённых для DM (id пользователей или имена). Используется `dm.policy="allowlist"` и для проверки `dm.policy="open"`. Мастер настройки принимает имена пользователей и разрешает их в id, когда бот может искать участников.
- `dm.groupEnabled`: включить групповые DM (по умолчанию `false`).
- `dm.groupChannels`: необязательный список разрешённых для id или slug каналов групповых DM.
- `groupPolicy`: управление обработкой каналов серверов (`open|disabled|allowlist`); `allowlist` требует списков разрешённых каналов.
- `guilds`: правила на уровне сервера, ключи — id сервера (предпочтительно) или slug.
- `guilds."*"`: настройки сервера по умолчанию, применяемые при отсутствии явной записи.
- `guilds.<id>.slug`: необязательный дружелюбный slug для отображаемых имён.
- `guilds.<id>.users`: необязательный список разрешённых пользователей сервера (id или имена).
- `guilds.<id>.tools`: необязательные переопределения политик инструментов на уровне сервера (`allow`/`deny`/`alsoAllow`), используемые при отсутствии переопределения канала.
- `guilds.<id>.toolsBySender`: необязательные переопределения политик инструментов на уровне отправителя в пределах сервера (применяется при отсутствии переопределения канала; поддерживается wildcard `"*"`).
- `guilds.<id>.channels.<channel>.allow`: разрешить/запретить канал при `groupPolicy="allowlist"`.
- `guilds.<id>.channels.<channel>.requireMention`: требование упоминания для канала.
- `guilds.<id>.channels.<channel>.tools`: необязательные переопределения политик инструментов на уровне канала (`allow`/`deny`/`alsoAllow`).
- `guilds.<id>.channels.<channel>.toolsBySender`: необязательные переопределения политик инструментов для отправителя внутри канала (поддерживается wildcard `"*"`).
- `guilds.<id>.channels.<channel>.users`: необязательный список разрешённых пользователей канала.
- `guilds.<id>.channels.<channel>.skills`: фильтр навыков (не указано = все навыки, пусто = ни одного).
- `guilds.<id>.channels.<channel>.systemPrompt`: дополнительный системный промпт для канала. Темы каналов Discord внедряются как **недоверенный** контекст (не системный промпт).
- `guilds.<id>.channels.<channel>.enabled`: установите `false`, чтобы отключить канал.
- `guilds.<id>.channels`: правила каналов (ключи — slug или id каналов).
- `guilds.<id>.requireMention`: требование упоминания на уровне сервера (можно переопределить на уровне канала).
- `guilds.<id>.reactionNotifications`: режим системных событий реакций (`off`, `own`, `all`, `allowlist`).
- `textChunkLimit`: размер чанка исходящего текста (символы). По умолчанию: 2000.
- `chunkMode`: `length` (по умолчанию) делит только при превышении `textChunkLimit`; `newline` делит по пустым строкам (границы абзацев) перед делением по длине.
- `maxLinesPerMessage`: мягкий максимум строк на сообщение. По умолчанию: 17.
- `mediaMaxMb`: ограничение входящих медиа, сохраняемых на диск.
- `historyLimit`: количество последних сообщений сервера для включения в контекст при ответе на упоминание (по умолчанию 20; с откатом к `messages.groupChat.historyLimit`; `0` отключает).
- `dmHistoryLimit`: лимит истории DM в пользовательских репликах. Переопределения для пользователей: `dms["<user_id>"].historyLimit`.
- `retry`: политика повторов для исходящих вызовов Discord API (attempts, minDelayMs, maxDelayMs, jitter).
- `pluralkit`: разрешать PluralKit-проксированные сообщения так, чтобы участники системы отображались как отдельные отправители.
- `actions`: ограничения инструментов по действиям; не указывайте, чтобы разрешить всё (установите `false` для отключения).
  - `reactions` (покрывает реакции + чтение реакций)
  - `stickers`, `emojiUploads`, `stickerUploads`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`
  - `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
  - `channels` (создание/редактирование/удаление каналов + категорий + прав)
  - `roles` (добавление/удаление ролей, по умолчанию `false`)
  - `moderation` (таймаут/кик/бан, по умолчанию `false`)
  - `presence` (статус/активность бота, по умолчанию `false`)
- `execApprovals`: подтверждения выполнения (exec approvals) только для Discord в DM (UI с кнопками). Поддерживает `enabled`, `approvers`, `agentFilter`, `sessionFilter`.

Уведомления о реакциях используют `guilds.<id>.reactionNotifications`:

- `off`: без событий реакций.
- `own`: реакции на собственные сообщения бота (по умолчанию).
- `all`: все реакции на все сообщения.
- `allowlist`: реакции от `guilds.<id>.users` на всех сообщениях (пустой список отключает).

### Поддержка PluralKit (PK)

Включите поиск PK, чтобы проксированные сообщения разрешались к исходной системе и участнику.
При включении OpenClaw использует идентичность участника для списков разрешённых и помечает
отправителя как `Member (PK:System)`, чтобы избежать случайных пингов в Discord.

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optional; required for private systems
      },
    },
  },
}
```

Примечания по спискам разрешённых (с включённым PK):

- Используйте `pk:<memberId>` в `dm.allowFrom`, `guilds.<id>.users` или в `users` на уровне канала.
- Отображаемые имена участников также сопоставляются по имени/slug.
- Поиск использует **оригинальный** ID сообщения Discord (до проксирования), поэтому API PK разрешает его только в пределах 30 минут.
- Если поиск PK не удался (например, приватная система без токена), проксированные сообщения
  считаются сообщениями бота и отбрасываются, если не задано `channels.discord.allowBots=true`.

### Значения по умолчанию для действий инструментов

| Группа действий | По умолчанию | Примечания                                              |
| --------------- | ------------ | ------------------------------------------------------- |
| reactions       | enabled      | Реакции + список реакций + emojiList                    |
| stickers        | enabled      | Отправка стикеров                                       |
| emojiUploads    | enabled      | Загрузить эмодзи                                        |
| stickerUploads  | enabled      | Загрузка стикеров                                       |
| polls           | enabled      | Создание опросов                                        |
| permissions     | enabled      | Снимок прав канала                                      |
| messages        | enabled      | Чтение/отправка/редактирование/удаление                 |
| threads         | enabled      | Создание/список/ответ                                   |
| pins            | enabled      | Закрепить/открепить/список                              |
| search          | enabled      | Поиск сообщений (preview-функция)    |
| memberInfo      | enabled      | Информация об участнике                                 |
| roleInfo        | enabled      | Список ролей                                            |
| channelInfo     | enabled      | Информация о канале + список                            |
| channels        | enabled      | Управление каналами/категориями                         |
| voiceStatus     | enabled      | Просмотр состояния голоса                               |
| events          | enabled      | Список/создание запланированных событий                 |
| roles           | disabled     | Добавление/удаление ролей                               |
| moderation      | disabled     | Таймаут/кик/бан                                         |
| presence        | disabled     | Статус/активность бота (setPresence) |

- `replyToMode`: `off` (по умолчанию), `first` или `all`. Применяется только когда модель включает тег ответа.

## Теги ответов

Чтобы запросить ответ в треде, модель может включить один тег в выводе:

- `[[reply_to_current]]` — ответить на инициирующее сообщение Discord.
- `[[reply_to:<id>]]` — ответить на конкретный id сообщения из контекста/истории.
  Текущие id сообщений добавляются к промптам как `[message_id: …]`; записи истории уже включают id.

Поведение управляется через `channels.discord.replyToMode`:

- `off`: игнорировать теги.
- `first`: только первый исходящий чанк/вложение является ответом.
- `all`: каждый исходящий чанк/вложение является ответом.

Примечания по сопоставлению списков разрешённых:

- `allowFrom`/`users`/`groupChannels` принимают id, имена, теги или упоминания вроде `<@id>`.
- Поддерживаются префиксы `discord:`/`user:` (пользователи) и `channel:` (групповые DM).
- Используйте `*`, чтобы разрешить любого отправителя/канал.
- При наличии `guilds.<id>.channels` каналы, не перечисленные, запрещены по умолчанию.
- Если `guilds.<id>.channels` опущен, разрешены все каналы в сервере из списка разрешённых.
- Чтобы не разрешать **ни одного канала**, установите `channels.discord.groupPolicy: "disabled"` (или оставьте пустой список разрешённых).
- Мастер настройки принимает имена `Guild/Channel` (публичные + приватные) и по возможности разрешает их в ID.
- При запуске OpenClaw разрешает имена каналов/пользователей в списках разрешённых в ID (когда бот может искать участников)
  и логирует соответствие; неразрешённые записи сохраняются как введены.

Нативные заметки:

- Зарегистрированные команды зеркалируют чат-команды OpenClaw.
- Нативные команды учитывают те же списки разрешённых, что и DM/сообщения серверов (`channels.discord.dm.allowFrom`, `channels.discord.guilds`, правила каналов).
- Slash-команды могут быть видны в UI Discord пользователям вне списков разрешённых; OpenClaw проверяет доступ при выполнении и отвечает «not authorized».

## Действия инструментов

Агент может вызывать `discord` с действиями, такими как:

- `react` / `reactions` (добавить или перечислить реакции)
- `sticker`, `poll`, `permissions`
- `readMessages`, `sendMessage`, `editMessage`, `deleteMessage`
- Полезные нагрузки инструментов чтения/поиска/закрепления включают нормализованные `timestampMs` (UTC epoch ms) и `timestampUtc` вместе с «сырыми» Discord `timestamp`.
- `threadCreate`, `threadList`, `threadReply`
- `pinMessage`, `unpinMessage`, `listPins`
- `searchMessages`, `memberInfo`, `roleInfo`, `roleAdd`, `roleRemove`, `emojiList`
- `channelInfo`, `channelList`, `voiceStatus`, `eventList`, `eventCreate`
- `timeout`, `kick`, `ban`
- `setPresence` (активность бота и онлайн-статус)

ID сообщений Discord отображаются во внедрённом контексте (`[discord message id: …]` и строки истории), чтобы агент мог на них нацеливаться.
Эмодзи могут быть unicode (например, `✅`) или в синтаксисе кастомных эмодзи, как `<:party_blob:1234567890>`.

## Безопасность и эксплуатация

- Обращайтесь с токеном бота как с паролем; предпочтительна переменная окружения `DISCORD_BOT_TOKEN` на контролируемых хостах или строгие права доступа к файлу конфига.
- Выдавайте боту только необходимые права (обычно Read/Send Messages).
- Если бот завис или упёрся в лимиты, перезапустите Gateway (шлюз) (`openclaw gateway --force`), убедившись, что никакие другие процессы не владеют сессией Discord.
