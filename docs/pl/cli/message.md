---
summary: "Referencja CLI dla `openclaw message` (wysyłanie + akcje kanałów)"
read_when:
  - Dodawanie lub modyfikowanie akcji CLI dla wiadomości
  - Zmienianie zachowania kanałów wychodzących
title: "message"
---

# `openclaw message`

Pojedyncze polecenie wychodzące do wysyłania wiadomości i wykonywania akcji na kanałach
(Discord/Google Chat/Slack/Mattermost (wtyczka)/Telegram/WhatsApp/Signal/iMessage/MS Teams).

## Użycie

```
openclaw message <subcommand> [flags]
```

Wybór kanału:

- `--channel` wymagane, jeśli skonfigurowano więcej niż jeden kanał.
- Jeśli skonfigurowano dokładnie jeden kanał, staje się on domyślny.
- Wartości: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermost wymaga wtyczki)

Formaty celu (`--target`):

- WhatsApp: E.164 lub JID grupy
- Telegram: identyfikator czatu lub `@username`
- Discord: `channel:<id>` lub `user:<id>` (albo wzmianka `<@id>`; surowe identyfikatory numeryczne są traktowane jako kanały)
- Google Chat: `spaces/<spaceId>` lub `users/<userId>`
- Slack: `channel:<id>` lub `user:<id>` (akceptowany jest surowy identyfikator kanału)
- Mattermost (wtyczka): `channel:<id>`, `user:<id>` lub `@username` (gołe identyfikatory są traktowane jako kanały)
- Signal: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>` lub `username:<name>`/`u:<name>`
- iMessage: uchwyt, `chat_id:<id>`, `chat_guid:<guid>` lub `chat_identifier:<id>`
- MS Teams: identyfikator konwersacji (`19:...@thread.tacv2`) lub `conversation:<id>` lub `user:<aad-object-id>`

Wyszukiwanie nazw:

- Dla obsługiwanych dostawców (Discord/Slack/etc.) nazwy kanałów, takie jak `Help` lub `#help`, są rozwiązywane przez pamięć podręczną katalogu.
- W przypadku braku w pamięci podręcznej OpenClaw spróbuje wykonać wyszukiwanie katalogu na żywo, gdy dostawca to obsługuje.

## Typowe flagi

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (docelowy kanał lub użytkownik dla send/poll/read/etc)
- `--targets <name>` (powtórzenie; tylko broadcast)
- `--json`
- `--dry-run`
- `--verbose`

## Akcje

### Podstawowe

- `send`
  - Kanały: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (wtyczka)/Signal/iMessage/MS Teams
  - Wymagane: `--target`, oraz `--message` lub `--media`
  - Opcjonalne: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - Tylko Telegram: `--buttons` (wymaga `channels.telegram.capabilities.inlineButtons`, aby na to pozwolić)
  - Tylko Telegram: `--thread-id` (identyfikator tematu forum)
  - Tylko Slack: `--thread-id` (znacznik czasu wątku; `--reply-to` używa tego samego pola)
  - Tylko WhatsApp: `--gif-playback`

- `poll`
  - Kanały: WhatsApp/Discord/MS Teams
  - Wymagane: `--target`, `--poll-question`, `--poll-option` (powtórzenie)
  - Opcjonalne: `--poll-multi`
  - Tylko Discord: `--poll-duration-hours`, `--message`

- `react`
  - Kanały: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - Wymagane: `--message-id`, `--target`
  - Opcjonalne: `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - Uwaga: `--remove` wymaga `--emoji` (pomiń `--emoji`, aby wyczyścić własne reakcje tam, gdzie jest to obsługiwane; zobacz /tools/reactions)
  - Tylko WhatsApp: `--participant`, `--from-me`
  - Reakcje w grupach Signal: wymagane `--target-author` lub `--target-author-uuid`

- `reactions`
  - Kanały: Discord/Google Chat/Slack
  - Wymagane: `--message-id`, `--target`
  - Opcjonalne: `--limit`

- `read`
  - Kanały: Discord/Slack
  - Wymagane: `--target`
  - Opcjonalne: `--limit`, `--before`, `--after`
  - Tylko Discord: `--around`

- `edit`
  - Kanały: Discord/Slack
  - Wymagane: `--message-id`, `--message`, `--target`

- `delete`
  - Kanały: Discord/Slack/Telegram
  - Wymagane: `--message-id`, `--target`

- `pin` / `unpin`
  - Kanały: Discord/Slack
  - Wymagane: `--message-id`, `--target`

- `pins` (lista)
  - Kanały: Discord/Slack
  - Wymagane: `--target`

- `permissions`
  - Kanały: Discord
  - Wymagane: `--target`

- `search`
  - Kanały: Discord
  - Wymagane: `--guild-id`, `--query`
  - Opcjonalne: `--channel-id`, `--channel-ids` (powtórzenie), `--author-id`, `--author-ids` (powtórzenie), `--limit`

### Wątki

- `thread create`
  - Kanały: Discord
  - Wymagane: `--thread-name`, `--target` (identyfikator kanału)
  - Opcjonalne: `--message-id`, `--message`, `--auto-archive-min`

- `thread list`
  - Kanały: Discord
  - Wymagane: `--guild-id`
  - Opcjonalne: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - Kanały: Discord
  - Wymagane: `--target` (identyfikator wątku), `--message`
  - Opcjonalne: `--media`, `--reply-to`

### Emoji

- `emoji list`
  - Discord: `--guild-id`
  - Slack: brak dodatkowych flag

- `emoji upload`
  - Kanały: Discord
  - Wymagane: `--guild-id`, `--emoji-name`, `--media`
  - Opcjonalne: `--role-ids` (powtórzenie)

### Naklejki

- `sticker send`
  - Kanały: Discord
  - Wymagane: `--target`, `--sticker-id` (powtórzenie)
  - Opcjonalne: `--message`

- `sticker upload`
  - Kanały: Discord
  - Wymagane: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### Role / Kanały / Członkowie / Głos

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`, `--user-id`, `--role-id`
- `channel info` (Discord): `--target`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (+ `--guild-id` dla Discord)
- `voice status` (Discord): `--guild-id`, `--user-id`

### Zdarzenia

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`, `--event-name`, `--start-time`
  - Opcjonalne: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### Moderacja (Discord)

- `timeout`: `--guild-id`, `--user-id` (opcjonalnie `--duration-min` lub `--until`; pomiń oba, aby wyczyścić timeout)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` obsługuje także `--reason`

### Broadcast

- `broadcast`
  - Kanały: dowolny skonfigurowany kanał; użyj `--channel all`, aby objąć wszystkich dostawców
  - Wymagane: `--targets` (powtórzenie)
  - Opcjonalne: `--message`, `--media`, `--dry-run`

## Przykłady

Wyślij odpowiedź na Discordzie:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

Utwórz ankietę na Discordzie:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Wyślij proaktywną wiadomość w Teams:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Utwórz ankietę w Teams:

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

Zareaguj w Slacku:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

Zareaguj w grupie Signal:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

Wyślij przyciski inline w Telegramie:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
