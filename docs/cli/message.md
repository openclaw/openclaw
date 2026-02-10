---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI reference for `openclaw message` (send + channel actions)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding or modifying message CLI actions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing outbound channel behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "message"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw message`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Single outbound command for sending messages and channel actions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(Discord/Google Chat/Slack/Mattermost (plugin)/Telegram/WhatsApp/Signal/iMessage/MS Teams).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message <subcommand> [flags]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Channel selection:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--channel` required if more than one channel is configured.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If exactly one channel is configured, it becomes the default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Values: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermost requires plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Target formats (`--target`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp: E.164 or group JID（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: chat id or `@username`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: `channel:<id>` or `user:<id>` (or `<@id>` mention; raw numeric ids are treated as channels)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Google Chat: `spaces/<spaceId>` or `users/<userId>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack: `channel:<id>` or `user:<id>` (raw channel id is accepted)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mattermost (plugin): `channel:<id>`, `user:<id>`, or `@username` (bare ids are treated as channels)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Signal: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>`, or `username:<name>`/`u:<name>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iMessage: handle, `chat_id:<id>`, `chat_guid:<guid>`, or `chat_identifier:<id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- MS Teams: conversation id (`19:...@thread.tacv2`) or `conversation:<id>` or `user:<aad-object-id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Name lookup:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For supported providers (Discord/Slack/etc), channel names like `Help` or `#help` are resolved via the directory cache.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On cache miss, OpenClaw will attempt a live directory lookup when the provider supports it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common flags（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--channel <name>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--account <id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--target <dest>` (target channel or user for send/poll/read/etc)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--targets <name>` (repeat; broadcast only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--dry-run`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--verbose`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Actions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Core（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `send`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Channels: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Required: `--target`, plus `--message` or `--media`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Optional: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Telegram only: `--buttons` (requires `channels.telegram.capabilities.inlineButtons` to allow it)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Telegram only: `--thread-id` (forum topic id)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Slack only: `--thread-id` (thread timestamp; `--reply-to` uses the same field)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - WhatsApp only: `--gif-playback`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `poll`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Channels: WhatsApp/Discord/MS Teams（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Required: `--target`, `--poll-question`, `--poll-option` (repeat)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Optional: `--poll-multi`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Discord only: `--poll-duration-hours`, `--message`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `react`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Channels: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Required: `--message-id`, `--target`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Optional: `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Note: `--remove` requires `--emoji` (omit `--emoji` to clear own reactions where supported; see /tools/reactions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - WhatsApp only: `--participant`, `--from-me`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Signal group reactions: `--target-author` or `--target-author-uuid` required（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `reactions`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Channels: Discord/Google Chat/Slack（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Required: `--message-id`, `--target`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Optional: `--limit`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `read`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Channels: Discord/Slack（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Required: `--target`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Optional: `--limit`, `--before`, `--after`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Discord only: `--around`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `edit`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Channels: Discord/Slack（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Required: `--message-id`, `--message`, `--target`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `delete`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Channels: Discord/Slack/Telegram（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Required: `--message-id`, `--target`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pin` / `unpin`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Channels: Discord/Slack（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Required: `--message-id`, `--target`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pins` (list)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Channels: Discord/Slack（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Required: `--target`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `permissions`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Channels: Discord（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Required: `--target`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `search`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Channels: Discord（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Required: `--guild-id`, `--query`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Optional: `--channel-id`, `--channel-ids` (repeat), `--author-id`, `--author-ids` (repeat), `--limit`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Threads（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `thread create`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Channels: Discord（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Required: `--thread-name`, `--target` (channel id)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Optional: `--message-id`, `--message`, `--auto-archive-min`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `thread list`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Channels: Discord（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Required: `--guild-id`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Optional: `--channel-id`, `--include-archived`, `--before`, `--limit`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `thread reply`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Channels: Discord（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Required: `--target` (thread id), `--message`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Optional: `--media`, `--reply-to`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Emojis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `emoji list`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Discord: `--guild-id`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Slack: no extra flags（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `emoji upload`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Channels: Discord（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Required: `--guild-id`, `--emoji-name`, `--media`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Optional: `--role-ids` (repeat)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Stickers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sticker send`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Channels: Discord（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Required: `--target`, `--sticker-id` (repeat)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Optional: `--message`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sticker upload`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Channels: Discord（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Required: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Roles / Channels / Members / Voice（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `role info` (Discord): `--guild-id`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `role add` / `role remove` (Discord): `--guild-id`, `--user-id`, `--role-id`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channel info` (Discord): `--target`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channel list` (Discord): `--guild-id`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `member info` (Discord/Slack): `--user-id` (+ `--guild-id` for Discord)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `voice status` (Discord): `--guild-id`, `--user-id`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Events（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `event list` (Discord): `--guild-id`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `event create` (Discord): `--guild-id`, `--event-name`, `--start-time`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Optional: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Moderation (Discord)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timeout`: `--guild-id`, `--user-id` (optional `--duration-min` or `--until`; omit both to clear timeout)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `timeout` also supports `--reason`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Broadcast（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `broadcast`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Channels: any configured channel; use `--channel all` to target all providers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Required: `--targets` (repeat)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Optional: `--message`, `--media`, `--dry-run`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Send a Discord reply:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message send --channel discord \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --target channel:123 --message "hi" --reply-to 456（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create a Discord poll:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message poll --channel discord \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --target channel:123 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --poll-question "Snack?" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --poll-option Pizza --poll-option Sushi \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --poll-multi --poll-duration-hours 48（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Send a Teams proactive message:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message send --channel msteams \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --target conversation:19:abc@thread.tacv2 --message "hi"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create a Teams poll:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message poll --channel msteams \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --target conversation:19:abc@thread.tacv2 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --poll-question "Lunch?" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --poll-option Pizza --poll-option Sushi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
React in Slack:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message react --channel slack \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --target C123 --message-id 456 --emoji "✅"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
React in a Signal group:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message react --channel signal \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --target signal:group:abc123 --message-id 1737630212345 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Send Telegram inline buttons:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message send --channel telegram --target @mychat --message "Choose:" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
