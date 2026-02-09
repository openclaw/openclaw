---
summary: "CLI-reference for `openclaw message` (send + kanalhandlinger)"
read_when:
  - Tilføjelse eller ændring af message CLI-handlinger
  - Ændring af udgående kanaladfærd
title: "message"
---

# `openclaw message`

En enkelt udgående kommando til afsendelse af beskeder og kanalhandlinger
(Discord/Google Chat/Slack/Mattermost (plugin)/Telegram/WhatsApp/Signal/iMessage/MS Teams).

## Brug

```
openclaw message <subcommand> [flags]
```

Kanalvalg:

- `--channel` påkrævet, hvis mere end én kanal er konfigureret.
- Hvis præcis én kanal er konfigureret, bliver den standard.
- Værdier: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermost kræver plugin)

Målformater (`--target`):

- WhatsApp: E.164 eller gruppe-JID
- Telegram: chat-id eller `@username`
- Discord: `channel:<id>` eller `user:<id>` (eller `<@id>`-mention; rå numeriske id’er behandles som kanaler)
- Google Chat: `spaces/<spaceId>` eller `users/<userId>`
- Slack: `channel:<id>` eller `user:<id>` (rå kanal-id accepteres)
- Mattermost (plugin): `channel:<id>`, `user:<id>` eller `@username` (rene id’er behandles som kanaler)
- Signal: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>` eller `username:<name>`/`u:<name>`
- iMessage: handle, `chat_id:<id>`, `chat_guid:<guid>` eller `chat_identifier:<id>`
- MS Teams: samtale-id (`19:...@thread.tacv2`) eller `conversation:<id>` eller `user:<aad-object-id>`

Navneopslag:

- For understøttede udbydere (Discord/Slack/etc), kanalnavne som `Help` eller `#help` løses via mappe-cachen.
- Ved cache-miss vil OpenClaw forsøge et live directory-opslag, når udbyderen understøtter det.

## Fælles flag

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (målkanal eller -bruger til send/poll/read/etc.)
- `--targets <name>` (gentag; kun broadcast)
- `--json`
- `--dry-run`
- `--verbose`

## Handlinger

### Kerne

- `send`
  - Kanaler: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams
  - Påkrævet: `--target`, samt `--message` eller `--media`
  - Valgfri: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - Kun Telegram: `--buttons` (kræver `channels.telegram.capabilities.inlineButtons` for at tillade det)
  - Kun Telegram: `--thread-id` (forum topic-id)
  - Kun Slack: `--thread-id` (tråd-timestamp; `--reply-to` bruger samme felt)
  - Kun WhatsApp: `--gif-playback`

- `poll`
  - Kanaler: WhatsApp/Discord/MS Teams
  - Påkrævet: `--target`, `--poll-question`, `--poll-option` (gentag)
  - Valgfri: `--poll-multi`
  - Kun Discord: `--poll-duration-hours`, `--message`

- `react`
  - Kanaler: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - Påkrævet: `--message-id`, `--target`
  - Valgfri: `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - Note: `--remove` kræver `--emoji` (udelad `--emoji` for at rydde egne reaktioner, hvor understøttet; se /tools/reactions)
  - Kun WhatsApp: `--participant`, `--from-me`
  - Signal-gruppereaktioner: `--target-author` eller `--target-author-uuid` påkrævet

- `reactions`
  - Kanaler: Discord/Google Chat/Slack
  - Påkrævet: `--message-id`, `--target`
  - Valgfri: `--limit`

- `read`
  - Kanaler: Discord/Slack
  - Påkrævet: `--target`
  - Valgfri: `--limit`, `--before`, `--after`
  - Kun Discord: `--around`

- `edit`
  - Kanaler: Discord/Slack
  - Påkrævet: `--message-id`, `--message`, `--target`

- `delete`
  - Kanaler: Discord/Slack/Telegram
  - Påkrævet: `--message-id`, `--target`

- `pin` / `unpin`
  - Kanaler: Discord/Slack
  - Påkrævet: `--message-id`, `--target`

- `pins` (liste)
  - Kanaler: Discord/Slack
  - Påkrævet: `--target`

- `permissions`
  - Kanaler: Discord
  - Påkrævet: `--target`

- `search`
  - Kanaler: Discord
  - Påkrævet: `--guild-id`, `--query`
  - Valgfri: `--channel-id`, `--channel-ids` (gentag), `--author-id`, `--author-ids` (gentag), `--limit`

### Tråde

- `thread create`
  - Kanaler: Discord
  - Påkrævet: `--thread-name`, `--target` (kanal-id)
  - Valgfri: `--message-id`, `--message`, `--auto-archive-min`

- `thread list`
  - Kanaler: Discord
  - Påkrævet: `--guild-id`
  - Valgfri: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - Kanaler: Discord
  - Påkrævet: `--target` (tråd-id), `--message`
  - Valgfri: `--media`, `--reply-to`

### Emojis

- `emoji list`
  - Discord: `--guild-id`
  - Slack: ingen ekstra flag

- `emoji upload`
  - Kanaler: Discord
  - Påkrævet: `--guild-id`, `--emoji-name`, `--media`
  - Valgfri: `--role-ids` (gentag)

### Klistermærker

- `sticker send`
  - Kanaler: Discord
  - Påkrævet: `--target`, `--sticker-id` (gentag)
  - Valgfri: `--message`

- `sticker upload`
  - Kanaler: Discord
  - Påkrævet: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### Roller / Kanaler / Medlemmer / Voice

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`, `--user-id`, `--role-id`
- `channel info` (Discord): `--target`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (+ `--guild-id` for Discord)
- `voice status` (Discord): `--guild-id`, `--user-id`

### Begivenheder

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`, `--event-name`, `--start-time`
  - Valgfri: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### Moderation (Discord)

- `timeout`: `--guild-id`, `--user-id` (valgfri `--duration-min` eller `--until`; udelad begge for at rydde timeout)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` understøtter også `--reason`

### Broadcast

- `broadcast`
  - Kanaler: enhver konfigureret kanal; brug `--channel all` til at målrette alle udbydere
  - Påkrævet: `--targets` (gentag)
  - Valgfri: `--message`, `--media`, `--dry-run`

## Eksempler

Send et Discord-svar:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

Opret en Discord-afstemning:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Send en Teams proaktiv besked:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Opret en Teams-afstemning:

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

Reagér i Slack:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

Reagér i en Signal-gruppe:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

Send Telegram inline-knapper:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
