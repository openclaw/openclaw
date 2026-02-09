---
summary: "CLI-referentie voor `openclaw message` (verzenden + kanaalacties)"
read_when:
  - Toevoegen of wijzigen van message-CLI-acties
  - Wijzigen van uitgaand kanaalgedrag
title: "message"
---

# `openclaw message`

Enkelvoudige uitgaande opdracht voor het verzenden van berichten en kanaalacties
(Discord/Google Chat/Slack/Mattermost (plugin)/Telegram/WhatsApp/Signal/iMessage/MS Teams).

## Gebruik

```
openclaw message <subcommand> [flags]
```

Kanaalselectie:

- `--channel` vereist als er meer dan één kanaal is geconfigureerd.
- Als precies één kanaal is geconfigureerd, wordt dit de standaard.
- Waarden: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermost vereist plugin)

Doelformaten (`--target`):

- WhatsApp: E.164 of groeps-JID
- Telegram: chat-id of `@username`
- Discord: `channel:<id>` of `user:<id>` (of `<@id>`-vermelding; ruwe numerieke id's worden als kanalen behandeld)
- Google Chat: `spaces/<spaceId>` of `users/<userId>`
- Slack: `channel:<id>` of `user:<id>` (ruwe kanaal-id wordt geaccepteerd)
- Mattermost (plugin): `channel:<id>`, `user:<id>` of `@username` (kale id's worden als kanalen behandeld)
- Signal: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>` of `username:<name>`/`u:<name>`
- iMessage: handle, `chat_id:<id>`, `chat_guid:<guid>` of `chat_identifier:<id>`
- MS Teams: conversatie-id (`19:...@thread.tacv2`) of `conversation:<id>` of `user:<aad-object-id>`

Naamopzoeking:

- Voor ondersteunde providers (Discord/Slack/etc) worden kanaalnamen zoals `Help` of `#help` opgelost via de directorycache.
- Bij een cache-mis zal OpenClaw een live directory-opzoeking proberen wanneer de provider dit ondersteunt.

## Veelgebruikte flags

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (doelkanaal of gebruiker voor send/poll/read/etc)
- `--targets <name>` (herhalen; alleen broadcast)
- `--json`
- `--dry-run`
- `--verbose`

## Acties

### Core

- `send`
  - Kanalen: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams
  - Vereist: `--target`, plus `--message` of `--media`
  - Optioneel: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - Alleen Telegram: `--buttons` (vereist `channels.telegram.capabilities.inlineButtons` om dit toe te staan)
  - Alleen Telegram: `--thread-id` (forum topic-id)
  - Alleen Slack: `--thread-id` (thread-timestamp; `--reply-to` gebruikt hetzelfde veld)
  - Alleen WhatsApp: `--gif-playback`

- `poll`
  - Kanalen: WhatsApp/Discord/MS Teams
  - Vereist: `--target`, `--poll-question`, `--poll-option` (herhalen)
  - Optioneel: `--poll-multi`
  - Alleen Discord: `--poll-duration-hours`, `--message`

- `react`
  - Kanalen: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - Vereist: `--message-id`, `--target`
  - Optioneel: `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - Let op: `--remove` vereist `--emoji` (laat `--emoji` weg om eigen reacties te wissen waar ondersteund; zie /tools/reactions)
  - Alleen WhatsApp: `--participant`, `--from-me`
  - Signal-groepsreacties: `--target-author` of `--target-author-uuid` vereist

- `reactions`
  - Kanalen: Discord/Google Chat/Slack
  - Vereist: `--message-id`, `--target`
  - Optioneel: `--limit`

- `read`
  - Kanalen: Discord/Slack
  - Vereist: `--target`
  - Optioneel: `--limit`, `--before`, `--after`
  - Alleen Discord: `--around`

- `edit`
  - Kanalen: Discord/Slack
  - Vereist: `--message-id`, `--message`, `--target`

- `delete`
  - Kanalen: Discord/Slack/Telegram
  - Vereist: `--message-id`, `--target`

- `pin` / `unpin`
  - Kanalen: Discord/Slack
  - Vereist: `--message-id`, `--target`

- `pins` (lijst)
  - Kanalen: Discord/Slack
  - Vereist: `--target`

- `permissions`
  - Kanalen: Discord
  - Vereist: `--target`

- `search`
  - Kanalen: Discord
  - Vereist: `--guild-id`, `--query`
  - Optioneel: `--channel-id`, `--channel-ids` (herhalen), `--author-id`, `--author-ids` (herhalen), `--limit`

### Threads

- `thread create`
  - Kanalen: Discord
  - Vereist: `--thread-name`, `--target` (kanaal-id)
  - Optioneel: `--message-id`, `--message`, `--auto-archive-min`

- `thread list`
  - Kanalen: Discord
  - Vereist: `--guild-id`
  - Optioneel: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - Kanalen: Discord
  - Vereist: `--target` (thread-id), `--message`
  - Optioneel: `--media`, `--reply-to`

### Emoji's

- `emoji list`
  - Discord: `--guild-id`
  - Slack: geen extra flags

- `emoji upload`
  - Kanalen: Discord
  - Vereist: `--guild-id`, `--emoji-name`, `--media`
  - Optioneel: `--role-ids` (herhalen)

### Stickers

- `sticker send`
  - Kanalen: Discord
  - Vereist: `--target`, `--sticker-id` (herhalen)
  - Optioneel: `--message`

- `sticker upload`
  - Kanalen: Discord
  - Vereist: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### Rollen / Kanalen / Leden / Spraak

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`, `--user-id`, `--role-id`
- `channel info` (Discord): `--target`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (+ `--guild-id` voor Discord)
- `voice status` (Discord): `--guild-id`, `--user-id`

### Gebeurtenissen

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`, `--event-name`, `--start-time`
  - Optioneel: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### Moderatie (Discord)

- `timeout`: `--guild-id`, `--user-id` (optioneel `--duration-min` of `--until`; laat beide weg om de timeout te wissen)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` ondersteunt ook `--reason`

### Broadcast

- `broadcast`
  - Kanalen: elk geconfigureerd kanaal; gebruik `--channel all` om alle providers te targeten
  - Vereist: `--targets` (herhalen)
  - Optioneel: `--message`, `--media`, `--dry-run`

## Voorbeelden

Een Discord-antwoord verzenden:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

Een Discord-poll maken:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Een Teams proactief bericht verzenden:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Een Teams-poll maken:

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

Reageren in Slack:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

Reageren in een Signal-groep:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

Telegram inline-knoppen verzenden:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
