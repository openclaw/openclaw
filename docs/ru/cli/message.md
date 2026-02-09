---
summary: "Справочник CLI для `openclaw message` (отправка + действия с каналами)"
read_when:
  - Добавление или изменение действий CLI для сообщений
  - Изменение поведения исходящих каналов
title: "message"
---

# `openclaw message`

Единая исходящая команда для отправки сообщений и действий с каналами
(Discord/Google Chat/Slack/Mattermost (плагин)/Telegram/WhatsApp/Signal/iMessage/MS Teams).

## Использование

```
openclaw message <subcommand> [flags]
```

Выбор канала:

- `--channel` требуется, если настроено более одного канала.
- Если настроен ровно один канал, он становится каналом по умолчанию.
- Значения: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermost требует плагин)

Форматы целей (`--target`):

- WhatsApp: E.164 или групповой JID
- Telegram: chat id или `@username`
- Discord: `channel:<id>` или `user:<id>` (или упоминание `<@id>`; «сырые» числовые id трактуются как каналы)
- Google Chat: `spaces/<spaceId>` или `users/<userId>`
- Slack: `channel:<id>` или `user:<id>` (принимается «сырой» id канала)
- Mattermost (плагин): `channel:<id>`, `user:<id>` или `@username` («голые» id трактуются как каналы)
- Signal: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>` или `username:<name>`/`u:<name>`
- iMessage: handle, `chat_id:<id>`, `chat_guid:<guid>` или `chat_identifier:<id>`
- MS Teams: id беседы (`19:...@thread.tacv2`) или `conversation:<id>` или `user:<aad-object-id>`

Поиск по имени:

- Для поддерживаемых провайдеров (Discord/Slack и т. д.) имена каналов, такие как `Help` или `#help`, разрешаются через кэш каталога.
- При промахе кэша OpenClaw попытается выполнить живой поиск в каталоге, если провайдер это поддерживает.

## Общие флаги

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (целевой канал или пользователь для send/poll/read и т. п.)
- `--targets <name>` (повтор; только для broadcast)
- `--json`
- `--dry-run`
- `--verbose`

## Действия

### Core

- `send`
  - Каналы: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (плагин)/Signal/iMessage/MS Teams
  - Обязательно: `--target`, а также `--message` или `--media`
  - Необязательно: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - Только Telegram: `--buttons` (требует `channels.telegram.capabilities.inlineButtons` для разрешения)
  - Только Telegram: `--thread-id` (id темы форума)
  - Только Slack: `--thread-id` (timestamp треда; `--reply-to` использует то же поле)
  - Только WhatsApp: `--gif-playback`

- `poll`
  - Каналы: WhatsApp/Discord/MS Teams
  - Обязательно: `--target`, `--poll-question`, `--poll-option` (повтор)
  - Необязательно: `--poll-multi`
  - Только Discord: `--poll-duration-hours`, `--message`

- `react`
  - Каналы: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - Обязательно: `--message-id`, `--target`
  - Необязательно: `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - Примечание: `--remove` требует `--emoji` (исключите `--emoji` для очистки собственных реакций там, где это поддерживается; см. /tools/reactions)
  - Только WhatsApp: `--participant`, `--from-me`
  - Реакции в группах Signal: требуется `--target-author` или `--target-author-uuid`

- `reactions`
  - Каналы: Discord/Google Chat/Slack
  - Обязательно: `--message-id`, `--target`
  - Необязательно: `--limit`

- `read`
  - Каналы: Discord/Slack
  - Обязательно: `--target`
  - Необязательно: `--limit`, `--before`, `--after`
  - Только Discord: `--around`

- `edit`
  - Каналы: Discord/Slack
  - Обязательно: `--message-id`, `--message`, `--target`

- `delete`
  - Каналы: Discord/Slack/Telegram
  - Обязательно: `--message-id`, `--target`

- `pin` / `unpin`
  - Каналы: Discord/Slack
  - Обязательно: `--message-id`, `--target`

- `pins` (список)
  - Каналы: Discord/Slack
  - Обязательно: `--target`

- `permissions`
  - Каналы: Discord
  - Обязательно: `--target`

- `search`
  - Каналы: Discord
  - Обязательно: `--guild-id`, `--query`
  - Необязательно: `--channel-id`, `--channel-ids` (повтор), `--author-id`, `--author-ids` (повтор), `--limit`

### Потоки

- `thread create`
  - Каналы: Discord
  - Обязательно: `--thread-name`, `--target` (id канала)
  - Необязательно: `--message-id`, `--message`, `--auto-archive-min`

- `thread list`
  - Каналы: Discord
  - Обязательно: `--guild-id`
  - Необязательно: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - Каналы: Discord
  - Обязательно: `--target` (id треда), `--message`
  - Необязательно: `--media`, `--reply-to`

### Emojis

- `emoji list`
  - Discord: `--guild-id`
  - Slack: без дополнительных флагов

- `emoji upload`
  - Каналы: Discord
  - Обязательно: `--guild-id`, `--emoji-name`, `--media`
  - Необязательно: `--role-ids` (повтор)

### Стикеры

- `sticker send`
  - Каналы: Discord
  - Обязательно: `--target`, `--sticker-id` (повтор)
  - Необязательно: `--message`

- `sticker upload`
  - Каналы: Discord
  - Обязательно: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### Роли / Каналы / Участники / Голос

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`, `--user-id`, `--role-id`
- `channel info` (Discord): `--target`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (+ `--guild-id` для Discord)
- `voice status` (Discord): `--guild-id`, `--user-id`

### События

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`, `--event-name`, `--start-time`
  - Необязательно: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### Модерация (Discord)

- `timeout`: `--guild-id`, `--user-id` (необязательно `--duration-min` или `--until`; исключите оба, чтобы очистить тайм-аут)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` также поддерживает `--reason`

### Broadcast

- `broadcast`
  - Каналы: любой настроенный канал; используйте `--channel all` для нацеливания на всех провайдеров
  - Обязательно: `--targets` (повтор)
  - Необязательно: `--message`, `--media`, `--dry-run`

## Примеры

Отправка ответа в Discord:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

Создание опроса в Discord:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Отправка проактивного сообщения в Teams:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Создание опроса в Teams:

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

Реакция в Slack:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

Реакция в группе Signal:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

Отправка inline-кнопок в Telegram:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
