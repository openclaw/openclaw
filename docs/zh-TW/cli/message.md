---
summary: "CLI 參考文件，關於 `openclaw message` (發送 + 頻道動作)"
read_when:
  - 新增或修改訊息 CLI 動作時
  - 變更出站頻道行為時
title: "message"
---

# `openclaw message`

用於發送訊息和頻道動作的單一出站指令
(Discord/Google Chat/Slack/Mattermost (plugin)/Telegram/WhatsApp/Signal/iMessage/MS Teams)。

## Usage

```
openclaw message <subcommand> [flags]
```

頻道選擇：

- 如果配置了多個頻道，則 `--channel` 為必填項。
- 如果只配置了一個頻道，它將成為預設頻道。
- 值：`whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermost 需要外掛程式)

目標格式 (`--target`)：

- WhatsApp: E.164 or group JID
- Telegram: chat id or ` @username`
- Discord: `channel:<id>` or `user:<id>` (or `< @id>` mention; raw numeric ids are treated as channels)
- Google Chat: `spaces/<spaceId>` or `users/<userId>`
- Slack: `channel:<id>` or `user:<id>` (raw channel id is accepted)
- Mattermost (plugin): `channel:<id>`, `user:<id>`, or ` @username` (bare ids are treated as channels)
- Signal: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>`, or `username:<name>`/`u:<name>`
- iMessage: handle, `chat_id:<id>`, `chat_guid:<guid>`, or `chat_identifier:<id>`
- MS Teams: conversation id (`19:... @thread.tacv2`) or `conversation:<id>` or `user:<aad-object-id>`

名稱查詢：

- 對於支援的供應商 (Discord/Slack/等)，頻道名稱如 `Help` 或 `#help` 會透過目錄快取解析。
- 如果快取未命中，OpenClaw 將在供應商支援時嘗試即時目錄查詢。

## Common flags

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (用於發送/投票/讀取/等的目標頻道或使用者)
- `--targets <name>` (重複；僅限廣播)
- `--json`
- `--dry-run`
- `--verbose`

## Actions

### Core

- `send`
  - Channels: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams
  - 必填：`--target`，加上 `--message` 或 `--media`
  - Optional: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - 僅限 Telegram：`--buttons` (需要 `channels.telegram.capabilities.inlineButtons` 才能允許)
  - 僅限 Telegram：`--thread-id` (論壇話題 ID)
  - 僅限 Slack：`--thread-id` (執行緒時間戳記；`--reply-to` 使用相同欄位)
  - WhatsApp only: `--gif-playback`

- `poll`
  - Channels: WhatsApp/Discord/MS Teams
  - 必填：`--target`, `--poll-question`, `--poll-option` (重複)
  - Optional: `--poll-multi`
  - Discord only: `--poll-duration-hours`, `--message`

- `react`
  - Channels: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - 必填：`--message-id`, `--target`
  - Optional: `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - 注意：`--remove` 需要 `--emoji` (省略 `--emoji` 以清除在支援情況下自己的回應；請參閱 /tools/reactions)
  - WhatsApp only: `--participant`, `--from-me`
  - Signal 群組回應：`--target-author` 或 `--target-author-uuid` 為必填項

- `reactions`
  - Channels: Discord/Google Chat/Slack
  - 必填：`--message-id`, `--target`
  - Optional: `--limit`

- `read`
  - Channels: Discord/Slack
  - 必填：`--target`
  - Optional: `--limit`, `--before`, `--after`
  - Discord only: `--around`

- `edit`
  - Channels: Discord/Slack
  - 必填：`--message-id`, `--message`, `--target`

- `delete`
  - Channels: Discord/Slack/Telegram
  - 必填：`--message-id`, `--target`

- `pin` / `unpin`
  - Channels: Discord/Slack
  - 必填：`--message-id`, `--target`

- `pins` (list)
  - Channels: Discord/Slack
  - 必填：`--target`

- `permissions`
  - Channels: Discord
  - 必填：`--target`

- `search`
  - Channels: Discord
  - 必填：`--guild-id`, `--query`
  - Optional: `--channel-id`, `--channel-ids` (repeat), `--author-id`, `--author-ids` (repeat), `--limit`

### Threads

- `thread create`
  - Channels: Discord
  - 必填：`--thread-name`, `--target` (頻道 ID)
  - Optional: `--message-id`, `--message`, `--auto-archive-min`

- `thread list`
  - Channels: Discord
  - 必填：`--guild-id`
  - Optional: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - Channels: Discord
  - 必填：`--target` (執行緒 ID), `--message`
  - Optional: `--media`, `--reply-to`

### Emojis

- `emoji list`
  - Discord: `--guild-id`
  - Slack：無額外標誌

- `emoji upload`
  - Channels: Discord
  - 必填：`--guild-id`, `--emoji-name`, `--media`
  - Optional: `--role-ids` (repeat)

### Stickers

- `sticker send`
  - Channels: Discord
  - 必填：`--target`, `--sticker-id` (重複)
  - Optional: `--message`

- `sticker upload`
  - Channels: Discord
  - 必填：`--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### Roles / Channels / Members / Voice

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`, `--user-id`, `--role-id`
- `channel info` (Discord): `--target`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (+ `--guild-id` for Discord)
- `voice status` (Discord): `--guild-id`, `--user-id`

### Events

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`, `--event-name`, `--start-time`
  - Optional: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### Moderation (Discord)

- `timeout`: `--guild-id`, `--user-id` (optional `--duration-min` or `--until`; omit both to clear timeout)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` also supports `--reason`

### Broadcast

- `broadcast`
  - 頻道：任何已配置的頻道；使用 `--channel all` 以指定所有供應商
  - 必填：`--targets` (重複)
  - Optional: `--message`, `--media`, `--dry-run`

## Examples

發送 Discord 回覆：

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

建立 Discord 投票：

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

發送 Teams 主動訊息：

```
openclaw message send --channel msteams \
  --target conversation:19:abc @thread.tacv2 --message "hi"
```

建立 Teams 投票：

```
openclaw message poll --channel msteams \
  --target conversation:19:abc @thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

在 Slack 中回應：

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

在 Signal 群組中回應：

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

發送 Telegram 行內按鈕：

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
