---
summary: "CLI-referens för `openclaw message` (skicka + kanalåtgärder)"
read_when:
  - Lägga till eller ändra åtgärder i message-CLI
  - Ändra beteende för utgående kanaler
title: "meddelande"
---

# `openclaw message`

En enda utgående kommando för att skicka meddelanden och kanalåtgärder
(Discord/Google Chat/Slack/Mattermost (plugin)/Telegram/WhatsApp/Signal/iMessage/MS Teams).

## Användning

```
openclaw message <subcommand> [flags]
```

Val av kanal:

- `--channel` krävs om mer än en kanal är konfigurerad.
- Om exakt en kanal är konfigurerad blir den standard.
- Värden: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermost kräver plugin)

Målformat (`--target`):

- WhatsApp: E.164 eller grupp-JID
- Telegram: chatt-id eller `@username`
- Discord: `channel:<id>` eller `user:<id>` (eller `<@id>`-omnämnande; råa numeriska id:n behandlas som kanaler)
- Google Chat: `spaces/<spaceId>` eller `users/<userId>`
- Slack: `channel:<id>` eller `user:<id>` (rått kanal-id accepteras)
- Mattermost (plugin): `channel:<id>`, `user:<id>` eller `@username` (nakna id:n behandlas som kanaler)
- Signal: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>` eller `username:<name>`/`u:<name>`
- iMessage: handle, `chat_id:<id>`, `chat_guid:<guid>` eller `chat_identifier:<id>`
- MS Teams: konversations-id (`19:...@thread.tacv2`) eller `conversation:<id>` eller `user:<aad-object-id>`

Namnuopslag:

- För leverantörer som stöds (Discord/Slack/etc) löses kanalnamn som `Help` eller `#help` via katalogcachen.
- Vid cachemiss försöker OpenClaw göra ett live-uppslag i katalogen när leverantören stöder det.

## Vanliga flaggor

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (målkanal eller användare för send/poll/read/etc)
- `--targets <name>` (upprepa; endast broadcast)
- `--json`
- `--dry-run`
- `--verbose`

## Åtgärder

### Kärna

- `send`
  - Kanaler: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams
  - Krävs: `--target`, plus `--message` eller `--media`
  - Valfritt: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - Endast Telegram: `--buttons` (kräver `channels.telegram.capabilities.inlineButtons` för att tillåta det)
  - Endast Telegram: `--thread-id` (forumämnes-id)
  - Endast Slack: `--thread-id` (trådtidsstämpel; `--reply-to` använder samma fält)
  - Endast WhatsApp: `--gif-playback`

- `poll`
  - Kanaler: WhatsApp/Discord/MS Teams
  - Krävs: `--target`, `--poll-question`, `--poll-option` (upprepa)
  - Valfritt: `--poll-multi`
  - Endast Discord: `--poll-duration-hours`, `--message`

- `react`
  - Kanaler: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - Krävs: `--message-id`, `--target`
  - Valfritt: `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - Obs: `--remove` kräver `--emoji` (utelämna `--emoji` för att rensa egna reaktioner där det stöds; se /tools/reactions)
  - Endast WhatsApp: `--participant`, `--from-me`
  - Signal-gruppreaktioner: `--target-author` eller `--target-author-uuid` krävs

- `reactions`
  - Kanaler: Discord/Google Chat/Slack
  - Krävs: `--message-id`, `--target`
  - Valfritt: `--limit`

- `read`
  - Kanaler: Discord/Slack
  - Krävs: `--target`
  - Valfritt: `--limit`, `--before`, `--after`
  - Endast Discord: `--around`

- `edit`
  - Kanaler: Discord/Slack
  - Krävs: `--message-id`, `--message`, `--target`

- `delete`
  - Kanaler: Discord/Slack/Telegram
  - Krävs: `--message-id`, `--target`

- `pin` / `unpin`
  - Kanaler: Discord/Slack
  - Krävs: `--message-id`, `--target`

- `pins` (lista)
  - Kanaler: Discord/Slack
  - Krävs: `--target`

- `permissions`
  - Kanaler: Discord
  - Krävs: `--target`

- `search`
  - Kanaler: Discord
  - Krävs: `--guild-id`, `--query`
  - Valfritt: `--channel-id`, `--channel-ids` (upprepa), `--author-id`, `--author-ids` (upprepa), `--limit`

### Trådar

- `thread create`
  - Kanaler: Discord
  - Krävs: `--thread-name`, `--target` (kanal-id)
  - Valfritt: `--message-id`, `--message`, `--auto-archive-min`

- `thread list`
  - Kanaler: Discord
  - Krävs: `--guild-id`
  - Valfritt: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - Kanaler: Discord
  - Krävs: `--target` (tråd-id), `--message`
  - Valfritt: `--media`, `--reply-to`

### Emojis

- `emoji list`
  - Discord: `--guild-id`
  - Slack: inga extra flaggor

- `emoji upload`
  - Kanaler: Discord
  - Krävs: `--guild-id`, `--emoji-name`, `--media`
  - Valfritt: `--role-ids` (upprepa)

### Klistermärken

- `sticker send`
  - Kanaler: Discord
  - Krävs: `--target`, `--sticker-id` (upprepa)
  - Valfritt: `--message`

- `sticker upload`
  - Kanaler: Discord
  - Krävs: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### Roller / Kanaler / Medlemmar / Röst

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`, `--user-id`, `--role-id`
- `channel info` (Discord): `--target`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (+ `--guild-id` för Discord)
- `voice status` (Discord): `--guild-id`, `--user-id`

### Händelser

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`, `--event-name`, `--start-time`
  - Valfritt: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### Moderering (Discord)

- `timeout`: `--guild-id`, `--user-id` (valfritt `--duration-min` eller `--until`; utelämna båda för att rensa timeout)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` stöder även `--reason`

### Broadcast

- `broadcast`
  - Kanaler: valfri konfigurerad kanal; använd `--channel all` för att rikta alla leverantörer
  - Krävs: `--targets` (upprepa)
  - Valfritt: `--message`, `--media`, `--dry-run`

## Exempel

Skicka ett Discord-svar:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

Skapa en Discord-omröstning:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Skicka ett proaktivt Teams-meddelande:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Skapa en Teams-omröstning:

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

Reagera i Slack:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

Reagera i en Signal-grupp:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

Skicka Telegram-inlineknappar:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
