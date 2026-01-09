---
summary: "CLI reference for `clawdbot message` (send + provider actions)"
read_when:
  - Adding or modifying message CLI actions
  - Changing outbound provider behavior
---

# `clawdbot message`

Single outbound command for sending messages and provider actions
(Discord/Slack/Telegram/WhatsApp/Signal/iMessage).

## Usage

```
clawdbot message --action <action> [--provider <name>] [flags]
```

Defaults:
- `--action send`

Provider selection:
- `--provider` required if more than one provider is configured.
- If exactly one provider is configured, it becomes the default.
- Values: `whatsapp|telegram|discord|slack|signal|imessage`

Target formats (`--to`):
- WhatsApp: E.164 or group JID
- Telegram: chat id or `@username`
- Discord/Slack: `channel:<id>` or `user:<id>` (raw id ok)
- Signal: E.164, `group:<id>`, or `signal:+E.164`
- iMessage: handle or `chat_id:<id>`

## Common flags

- `--to <dest>`
- `--message <text>`
- `--media <url>`
- `--message-id <id>`
- `--reply-to <id>`
- `--thread-id <id>` (Telegram forum thread)
- `--account <id>` (multi-account providers)
- `--dry-run`
- `--json`
- `--verbose`

## Actions

### `send`
Providers: whatsapp, telegram, discord, slack, signal, imessage  
Required: `--to`, `--message`  
Optional: `--media`, `--reply-to`, `--thread-id`, `--account`, `--gif-playback`

### `react`
Providers: discord, slack, telegram, whatsapp  
Required: `--to`, `--message-id`  
Optional: `--emoji`, `--remove`, `--participant`, `--from-me`, `--account`

### `reactions`
Providers: discord, slack  
Required: `--to`, `--message-id`  
Optional: `--limit`

### `read`
Providers: discord, slack  
Required: `--to`  
Optional: `--limit`, `--before`, `--after`, `--around`

### `edit`
Providers: discord, slack  
Required: `--to`, `--message-id`, `--message`

### `delete`
Providers: discord, slack  
Required: `--to`, `--message-id`

### `pin`
Providers: discord, slack  
Required: `--to`, `--message-id`

### `unpin`
Providers: discord, slack  
Required: `--to`, `--message-id`

### `list-pins`
Providers: discord, slack  
Required: `--to`

### `poll`
Providers: whatsapp, discord  
Required: `--to`, `--poll-question`, `--poll-option` (repeat)  
Optional: `--poll-multi`, `--poll-duration-hours`, `--message`

### `sticker`
Providers: discord  
Required: `--to`, `--sticker-id` (repeat)  
Optional: `--message`

### `permissions`
Providers: discord  
Required: `--to` (channel id)

### `thread-create`
Providers: discord  
Required: `--to` (channel id), `--thread-name`  
Optional: `--message-id`, `--auto-archive-min`

### `thread-list`
Providers: discord  
Required: `--guild-id`  
Optional: `--channel-id`, `--include-archived`, `--before`, `--limit`

### `thread-reply`
Providers: discord  
Required: `--to` (thread id), `--message`  
Optional: `--media`, `--reply-to`

### `search`
Providers: discord  
Required: `--guild-id`, `--query`  
Optional: `--channel-id`, `--channel-ids`, `--author-id`, `--author-ids`, `--limit`

### `member-info`
Providers: discord, slack  
Required: `--user-id`  
Discord only: also `--guild-id`

### `role-info`
Providers: discord  
Required: `--guild-id`

### `emoji-list`
Providers: discord, slack  
Discord only: `--guild-id`

### `emoji-upload`
Providers: discord  
Required: `--guild-id`, `--emoji-name`, `--media`  
Optional: `--role-ids` (repeat)

### `sticker-upload`
Providers: discord  
Required: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### `role-add`
Providers: discord  
Required: `--guild-id`, `--user-id`, `--role-id`

### `role-remove`
Providers: discord  
Required: `--guild-id`, `--user-id`, `--role-id`

### `channel-info`
Providers: discord  
Required: `--channel-id`

### `channel-list`
Providers: discord  
Required: `--guild-id`

### `voice-status`
Providers: discord  
Required: `--guild-id`, `--user-id`

### `event-list`
Providers: discord  
Required: `--guild-id`

### `event-create`
Providers: discord  
Required: `--guild-id`, `--event-name`, `--start-time`  
Optional: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### `timeout`
Providers: discord  
Required: `--guild-id`, `--user-id`  
Optional: `--duration-min`, `--until`, `--reason`

### `kick`
Providers: discord  
Required: `--guild-id`, `--user-id`  
Optional: `--reason`

### `ban`
Providers: discord  
Required: `--guild-id`, `--user-id`  
Optional: `--reason`, `--delete-days`

## Examples

Send a Discord reply:
```
clawdbot message --action send --provider discord \
  --to channel:123 --message "hi" --reply-to 456
```

Create a Discord poll:
```
clawdbot message --action poll --provider discord \
  --to channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

React in Slack:
```
clawdbot message --action react --provider slack \
  --to C123 --message-id 456 --emoji "✅"
```
