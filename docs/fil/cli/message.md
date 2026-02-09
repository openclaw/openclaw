---
summary: "Sanggunian ng CLI para sa `openclaw message` (send + mga aksyon sa channel)"
read_when:
  - Pagdaragdag o pagbabago ng mga aksyon ng message sa CLI
  - Pagbabago ng outbound na gawi ng channel
title: "mensahe"
---

# `openclaw message`

Isang outbound na command para sa pagpapadala ng mga mensahe at mga aksyon sa channel
(Discord/Google Chat/Slack/Mattermost (plugin)/Telegram/WhatsApp/Signal/iMessage/MS Teams).

## Paggamit

```
openclaw message <subcommand> [flags]
```

Pagpili ng channel:

- `--channel` kinakailangan kung higit sa isang channel ang naka-configure.
- Kung eksaktong isang channel ang naka-configure, ito ang nagiging default.
- Mga value: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (nangangailangan ng plugin ang Mattermost)

Mga format ng target (`--target`):

- WhatsApp: E.164 o group JID
- Telegram: chat id o `@username`
- Discord: `channel:<id>` o `user:<id>` (o `<@id>` mention; itinuturing na channels ang mga raw numeric id)
- Google Chat: `spaces/<spaceId>` o `users/<userId>`
- Slack: `channel:<id>` o `user:<id>` (tinatanggap ang raw channel id)
- Mattermost (plugin): `channel:<id>`, `user:<id>`, o `@username` (ang mga bare id ay itinuturing na channels)
- Signal: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>`, o `username:<name>`/`u:<name>`
- iMessage: handle, `chat_id:<id>`, `chat_guid:<guid>`, o `chat_identifier:<id>`
- MS Teams: conversation id (`19:...@thread.tacv2`) o `conversation:<id>` o `user:<aad-object-id>`

Pag-lookup ng pangalan:

- Para sa mga suportadong provider (Discord/Slack/etc), ang mga pangalan ng channel gaya ng `Help` o `#help` ay nireresolba sa pamamagitan ng directory cache.
- Kapag nag-miss ang cache, susubukan ng OpenClaw ang live directory lookup kapag sinusuportahan ito ng provider.

## Mga karaniwang flag

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (target na channel o user para sa send/poll/read/etc)
- `--targets <name>` (ulit; para sa broadcast lamang)
- `--json`
- `--dry-run`
- `--verbose`

## Mga aksyon

### Core

- `send`
  - Mga channel: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams
  - Kinakailangan: `--target`, kasama ang `--message` o `--media`
  - Opsyonal: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - Telegram lamang: `--buttons` (nangangailangan ng `channels.telegram.capabilities.inlineButtons` para payagan ito)
  - Telegram lamang: `--thread-id` (forum topic id)
  - Slack lamang: `--thread-id` (thread timestamp; ginagamit ng `--reply-to` ang parehong field)
  - WhatsApp lamang: `--gif-playback`

- `poll`
  - Mga channel: WhatsApp/Discord/MS Teams
  - Kinakailangan: `--target`, `--poll-question`, `--poll-option` (ulit)
  - Opsyonal: `--poll-multi`
  - Discord lamang: `--poll-duration-hours`, `--message`

- `react`
  - Mga channel: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - Kinakailangan: `--message-id`, `--target`
  - Opsyonal: `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - Tala: Ang `--remove` ay nangangailangan ng `--emoji` (alisin ang `--emoji` para i-clear ang sariling reactions kung sinusuportahan; tingnan ang /tools/reactions)
  - WhatsApp lamang: `--participant`, `--from-me`
  - Mga reaction sa Signal group: kinakailangan ang `--target-author` o `--target-author-uuid`

- `reactions`
  - Mga channel: Discord/Google Chat/Slack
  - Kinakailangan: `--message-id`, `--target`
  - Opsyonal: `--limit`

- `read`
  - Mga channel: Discord/Slack
  - Kinakailangan: `--target`
  - Opsyonal: `--limit`, `--before`, `--after`
  - Discord lamang: `--around`

- `edit`
  - Mga channel: Discord/Slack
  - Kinakailangan: `--message-id`, `--message`, `--target`

- `delete`
  - Mga channel: Discord/Slack/Telegram
  - Kinakailangan: `--message-id`, `--target`

- `pin` / `unpin`
  - Mga channel: Discord/Slack
  - Kinakailangan: `--message-id`, `--target`

- `pins` (list)
  - Mga channel: Discord/Slack
  - Kinakailangan: `--target`

- `permissions`
  - Mga channel: Discord
  - Kinakailangan: `--target`

- `search`
  - Mga channel: Discord
  - Kinakailangan: `--guild-id`, `--query`
  - Opsyonal: `--channel-id`, `--channel-ids` (ulit), `--author-id`, `--author-ids` (ulit), `--limit`

### Mga thread

- `thread create`
  - Mga channel: Discord
  - Kinakailangan: `--thread-name`, `--target` (channel id)
  - Opsyonal: `--message-id`, `--message`, `--auto-archive-min`

- `thread list`
  - Mga channel: Discord
  - Kinakailangan: `--guild-id`
  - Opsyonal: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - Mga channel: Discord
  - Kinakailangan: `--target` (thread id), `--message`
  - Opsyonal: `--media`, `--reply-to`

### Mga emoji

- `emoji list`
  - Discord: `--guild-id`
  - Slack: walang dagdag na flag

- `emoji upload`
  - Mga channel: Discord
  - Kinakailangan: `--guild-id`, `--emoji-name`, `--media`
  - Opsyonal: `--role-ids` (ulit)

### Mga sticker

- `sticker send`
  - Mga channel: Discord
  - Kinakailangan: `--target`, `--sticker-id` (ulit)
  - Opsyonal: `--message`

- `sticker upload`
  - Mga channel: Discord
  - Kinakailangan: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### Mga role / channel / miyembro / voice

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`, `--user-id`, `--role-id`
- `channel info` (Discord): `--target`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (+ `--guild-id` para sa Discord)
- `voice status` (Discord): `--guild-id`, `--user-id`

### Mga event

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`, `--event-name`, `--start-time`
  - Opsyonal: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### Moderation (Discord)

- `timeout`: `--guild-id`, `--user-id` (opsyonal na `--duration-min` o `--until`; alisin ang pareho para i-clear ang timeout)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - Sinusuportahan din ng `timeout` ang `--reason`

### Broadcast

- `broadcast`
  - Mga channel: anumang naka-configure na channel; gamitin ang `--channel all` para i-target ang lahat ng provider
  - Kinakailangan: `--targets` (ulit)
  - Opsyonal: `--message`, `--media`, `--dry-run`

## Mga halimbawa

Magpadala ng Discord reply:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

Gumawa ng Discord poll:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Magpadala ng Teams proactive message:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Gumawa ng Teams poll:

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

Mag-react sa Slack:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

Mag-react sa isang Signal group:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

Magpadala ng Telegram inline buttons:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
