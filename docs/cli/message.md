---
summary: "CLI reference for `clawdbot message` (send + provider actions)"
read_when:
  - Adding or modifying message CLI actions
  - Changing outbound provider behavior
---

# `clawdbot message`

Single outbound command for sending messages and provider actions
(Discord/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams).

## Usage

```
clawdbot message <subcommand> [flags]
```

Provider selection:
- `--provider` required if more than one provider is configured.
- If exactly one provider is configured, it becomes the default.
- Values: `whatsapp|telegram|discord|slack|signal|imessage|msteams`

Target formats (`--to`):
- WhatsApp: E.164 or group JID
- Telegram: chat id or `@username`
- Discord: `channel:<id>` or `user:<id>` (or `<@id>` mention; raw numeric ids are rejected)
- Slack: `channel:<id>` or `user:<id>` (raw channel id is accepted)
- Signal: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>`, or `username:<name>`/`u:<name>`
- iMessage: handle, `chat_id:<id>`, `chat_guid:<guid>`, or `chat_identifier:<id>`
- MS Teams: conversation id (`19:...@thread.tacv2`) or `conversation:<id>` or `user:<aad-object-id>`

## Common flags

- `--provider <name>`
- `--account <id>`
- `--json`
- `--dry-run`
- `--verbose`

## Actions

### Core

- `send`
  - Providers: WhatsApp/Telegram/Discord/Slack/Signal/iMessage/MS Teams
  - Required: `--to`, `--message`
  - Optional: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - Telegram only: `--buttons-json` (requires `"inlineButtons"` in `telegram.capabilities` or `telegram.accounts.<id>.capabilities`)
  - Telegram only: `--thread-id` (forum topic id)
  - Slack only: `--thread-id` (thread timestamp; `--reply-to` uses the same field)
  - WhatsApp only: `--gif-playback`

- `poll`
  - Providers: WhatsApp/Discord/MS Teams
  - Required: `--to`, `--poll-question`, `--poll-option` (repeat)
  - Optional: `--poll-multi`
  - Discord only: `--poll-duration-hours`, `--message`

- `react`
  - Providers: Discord/Slack/Telegram/WhatsApp
  - Required: `--to`, `--message-id`
  - Optional: `--emoji`, `--remove`, `--participant`, `--from-me`, `--channel-id`
  - WhatsApp only: `--participant`, `--from-me`

- `reactions`
  - Providers: Discord/Slack
  - Required: `--to`, `--message-id`
  - Optional: `--limit`, `--channel-id`

- `read`
  - Providers: Discord/Slack
  - Required: `--to`
  - Optional: `--limit`, `--before`, `--after`, `--channel-id`
  - Discord only: `--around`

- `edit`
  - Providers: Discord/Slack
  - Required: `--to`, `--message-id`, `--message`
  - Optional: `--channel-id`

- `delete`
  - Providers: Discord/Slack
  - Required: `--to`, `--message-id`
  - Optional: `--channel-id`

- `pin` / `unpin`
  - Providers: Discord/Slack
  - Required: `--to`, `--message-id`
  - Optional: `--channel-id`

- `pins` (list)
  - Providers: Discord/Slack
  - Required: `--to`
  - Optional: `--channel-id`

- `permissions`
  - Providers: Discord
  - Required: `--to`
  - Optional: `--channel-id`

- `search`
  - Providers: Discord
  - Required: `--guild-id`, `--query`
  - Optional: `--channel-id`, `--channel-ids` (repeat), `--author-id`, `--author-ids` (repeat), `--limit`

### Threads

- `thread create`
  - Providers: Discord
  - Required: `--thread-name`, `--to` (channel id) or `--channel-id`
  - Optional: `--message-id`, `--auto-archive-min`

- `thread list`
  - Providers: Discord
  - Required: `--guild-id`
  - Optional: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - Providers: Discord
  - Required: `--to` (thread id), `--message`
  - Optional: `--media`, `--reply-to`

### Emojis

- `emoji list`
  - Discord: `--guild-id`
  - Slack: no extra flags

- `emoji upload`
  - Providers: Discord
  - Required: `--guild-id`, `--emoji-name`, `--media`
  - Optional: `--role-ids` (repeat)

### Stickers

- `sticker send`
  - Providers: Discord
  - Required: `--to`, `--sticker-id` (repeat)
  - Optional: `--message`

- `sticker upload`
  - Providers: Discord
  - Required: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### Roles / Channels / Members / Voice

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`, `--user-id`, `--role-id`
- `channel info` (Discord): `--channel-id`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (+ `--guild-id` for Discord)
- `voice status` (Discord): `--guild-id`, `--user-id`

### Events

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`, `--event-name`, `--start-time`
  - Optional: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### Moderation (Discord)

- `timeout`: `--guild-id`, `--user-id` (+ `--duration-min` or `--until`)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` also supports `--reason`

## Examples

Send a Discord reply:
```
clawdbot message send --provider discord \
  --to channel:123 --message "hi" --reply-to 456
```

Create a Discord poll:
```
clawdbot message poll --provider discord \
  --to channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Send a Teams proactive message:
```
clawdbot message send --provider msteams \
  --to conversation:19:abc@thread.tacv2 --message "hi"
```

Create a Teams poll:
```
clawdbot message poll --provider msteams \
  --to conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

React in Slack:
```
clawdbot message react --provider slack \
  --to C123 --message-id 456 --emoji "✅"
```

Send Telegram inline buttons:
```
clawdbot message send --provider telegram --to @mychat --message "Choose:" \
  --buttons-json '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
