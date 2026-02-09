---
summary: "CLI-Referenz für `openclaw message` (Senden + Kanalaktionen)"
read_when:
  - Hinzufügen oder Ändern von Message-CLI-Aktionen
  - Ändern des ausgehenden Kanalverhaltens
title: "message"
---

# `openclaw message`

Ein einzelner ausgehender Befehl zum Senden von Nachrichten und für Kanalaktionen
(Discord/Google Chat/Slack/Mattermost (Plugin)/Telegram/WhatsApp/Signal/iMessage/MS Teams).

## Verwendung

```
openclaw message <subcommand> [flags]
```

Kanalauswahl:

- `--channel` erforderlich, wenn mehr als ein Kanal konfiguriert ist.
- Wenn genau ein Kanal konfiguriert ist, wird er zum Standard.
- Werte: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermost erfordert ein Plugin)

Zielformate (`--target`):

- WhatsApp: E.164 oder Gruppen-JID
- Telegram: Chat-ID oder `@username`
- Discord: `channel:<id>` oder `user:<id>` (oder `<@id>`-Erwähnung; rohe numerische IDs werden als Kanäle behandelt)
- Google Chat: `spaces/<spaceId>` oder `users/<userId>`
- Slack: `channel:<id>` oder `user:<id>` (rohe Kanal-ID wird akzeptiert)
- Mattermost (Plugin): `channel:<id>`, `user:<id>` oder `@username` (reine IDs werden als Kanäle behandelt)
- Signal: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>` oder `username:<name>`/`u:<name>`
- iMessage: Handle, `chat_id:<id>`, `chat_guid:<guid>` oder `chat_identifier:<id>`
- MS Teams: Konversations-ID (`19:...@thread.tacv2`) oder `conversation:<id>` oder `user:<aad-object-id>`

Namensauflösung:

- Für unterstützte Anbieter (Discord/Slack/etc.) werden Kanalnamen wie `Help` oder `#help` über den Verzeichnis-Cache aufgelöst.
- Bei einem Cache-Miss versucht OpenClaw eine Live-Verzeichnisabfrage, sofern der Anbieter dies unterstützt.

## Allgemeine Flags

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (Zielkanal oder -benutzer für Senden/Umfrage/Lesen/etc.)
- `--targets <name>` (Wiederholen; nur Broadcast)
- `--json`
- `--dry-run`
- `--verbose`

## Aktionen

### Kern

- `send`
  - Kanäle: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (Plugin)/Signal/iMessage/MS Teams
  - Erforderlich: `--target` sowie `--message` oder `--media`
  - Optional: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - Nur Telegram: `--buttons` (erfordert `channels.telegram.capabilities.inlineButtons`, um dies zuzulassen)
  - Nur Telegram: `--thread-id` (Forum-Topic-ID)
  - Nur Slack: `--thread-id` (Thread-Zeitstempel; `--reply-to` verwendet dasselbe Feld)
  - Nur WhatsApp: `--gif-playback`

- `poll`
  - Kanäle: WhatsApp/Discord/MS Teams
  - Erforderlich: `--target`, `--poll-question`, `--poll-option` (Wiederholen)
  - Optional: `--poll-multi`
  - Nur Discord: `--poll-duration-hours`, `--message`

- `react`
  - Kanäle: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - Erforderlich: `--message-id`, `--target`
  - Optional: `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - Hinweis: `--remove` erfordert `--emoji` (lassen Sie `--emoji` weg, um eigene Reaktionen zu löschen, wo unterstützt; siehe /tools/reactions)
  - Nur WhatsApp: `--participant`, `--from-me`
  - Signal-Gruppenreaktionen: `--target-author` oder `--target-author-uuid` erforderlich

- `reactions`
  - Kanäle: Discord/Google Chat/Slack
  - Erforderlich: `--message-id`, `--target`
  - Optional: `--limit`

- `read`
  - Kanäle: Discord/Slack
  - Erforderlich: `--target`
  - Optional: `--limit`, `--before`, `--after`
  - Nur Discord: `--around`

- `edit`
  - Kanäle: Discord/Slack
  - Erforderlich: `--message-id`, `--message`, `--target`

- `delete`
  - Kanäle: Discord/Slack/Telegram
  - Erforderlich: `--message-id`, `--target`

- `pin` / `unpin`
  - Kanäle: Discord/Slack
  - Erforderlich: `--message-id`, `--target`

- `pins` (Liste)
  - Kanäle: Discord/Slack
  - Erforderlich: `--target`

- `permissions`
  - Kanäle: Discord
  - Erforderlich: `--target`

- `search`
  - Kanäle: Discord
  - Erforderlich: `--guild-id`, `--query`
  - Optional: `--channel-id`, `--channel-ids` (Wiederholen), `--author-id`, `--author-ids` (Wiederholen), `--limit`

### Threads

- `thread create`
  - Kanäle: Discord
  - Erforderlich: `--thread-name`, `--target` (Kanal-ID)
  - Optional: `--message-id`, `--message`, `--auto-archive-min`

- `thread list`
  - Kanäle: Discord
  - Erforderlich: `--guild-id`
  - Optional: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - Kanäle: Discord
  - Erforderlich: `--target` (Thread-ID), `--message`
  - Optional: `--media`, `--reply-to`

### Emojis

- `emoji list`
  - Discord: `--guild-id`
  - Slack: keine zusätzlichen Flags

- `emoji upload`
  - Kanäle: Discord
  - Erforderlich: `--guild-id`, `--emoji-name`, `--media`
  - Optional: `--role-ids` (Wiederholen)

### Sticker

- `sticker send`
  - Kanäle: Discord
  - Erforderlich: `--target`, `--sticker-id` (Wiederholen)
  - Optional: `--message`

- `sticker upload`
  - Kanäle: Discord
  - Erforderlich: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### Rollen / Kanäle / Mitglieder / Sprache

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`, `--user-id`, `--role-id`
- `channel info` (Discord): `--target`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (+ `--guild-id` für Discord)
- `voice status` (Discord): `--guild-id`, `--user-id`

### Ereignisse

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`, `--event-name`, `--start-time`
  - Optional: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### Moderation (Discord)

- `timeout`: `--guild-id`, `--user-id` (optional `--duration-min` oder `--until`; beide weglassen, um das Timeout zu löschen)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` unterstützt auch `--reason`

### Broadcast

- `broadcast`
  - Kanäle: jeder konfigurierte Kanal; verwenden Sie `--channel all`, um alle Anbieter anzusprechen
  - Erforderlich: `--targets` (Wiederholen)
  - Optional: `--message`, `--media`, `--dry-run`

## Beispiele

Eine Discord-Antwort senden:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

Eine Discord-Umfrage erstellen:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Eine proaktive Teams-Nachricht senden:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Eine Teams-Umfrage erstellen:

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

In Slack reagieren:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

In einer Signal-Gruppe reagieren:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

Telegram-Inline-Buttons senden:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
