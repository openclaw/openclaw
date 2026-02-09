---
summary: "用於 `openclaw message` 的 CLI 參考（傳送與頻道動作）"
read_when:
  - 新增或修改訊息 CLI 動作時
  - Changing outbound channel behavior
title: "message"
---

# `openclaw message`

用於傳送訊息與頻道動作的單一對外指令
（Discord/Google Chat/Slack/Mattermost（外掛）/Telegram/WhatsApp/Signal/iMessage/MS Teams）。

## Usage

```
openclaw message <subcommand> [flags]
```

頻道選擇：

- 若設定了多個頻道，則必須指定 `--channel`。
- If exactly one channel is configured, it becomes the default.
- 可用值：`whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`（Mattermost 需要外掛）

目標格式（`--target`）：

- WhatsApp：E.164 或群組 JID
- Telegram：chat id 或 `@username`
- Discord：`channel:<id>` 或 `user:<id>`（或 `<@id>` 提及；純數字 id 會被視為頻道）
- Google Chat：`spaces/<spaceId>` 或 `users/<userId>`
- Slack：`channel:<id>` 或 `user:<id>`（接受原始頻道 id）
- Mattermost（外掛）：`channel:<id>`、`user:<id>` 或 `@username`（裸 id 會被視為頻道）
- Signal：`+E.164`、`group:<id>`、`signal:+E.164`、`signal:group:<id>`，或 `username:<name>`/`u:<name>`
- iMessage：handle、`chat_id:<id>`、`chat_guid:<guid>` 或 `chat_identifier:<id>`
- MS Teams：對話 id（`19:...@thread.tacv2`）或 `conversation:<id>` 或 `user:<aad-object-id>`

名稱查找：

- 對於支援的提供者（Discord/Slack 等），像是 `Help` 或 `#help` 的頻道名稱會透過目錄快取解析。
- On cache miss, OpenClaw will attempt a live directory lookup when the provider supports it.

## Common flags

- `--channel <name>`
- `--account <id>`
- `--target <dest>`（用於 send/poll/read 等的目標頻道或使用者）
- `--targets <name>`（重複；僅廣播）
- `--json`
- `--dry-run`
- `--verbose`

## Actions

### Core

- `send`
  - 頻道：WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost（外掛）/Signal/iMessage/MS Teams
  - 必要：`--target`，以及 `--message` 或 `--media`
  - 選用：`--media`、`--reply-to`、`--thread-id`、`--gif-playback`
  - 僅 Telegram：`--buttons`（需要 `channels.telegram.capabilities.inlineButtons` 以允許）
  - 僅 Telegram：`--thread-id`（論壇主題 id）
  - 僅 Slack：`--thread-id`（執行緒時間戳；`--reply-to` 使用相同欄位）
  - 僅 WhatsApp：`--gif-playback`

- `poll`
  - 頻道：WhatsApp/Discord/MS Teams
  - 必要：`--target`、`--poll-question`、`--poll-option`（重複）
  - 選用：`--poll-multi`
  - 僅 Discord：`--poll-duration-hours`、`--message`

- `react`
  - 頻道：Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - 必要：`--message-id`、`--target`
  - 選用：`--emoji`、`--remove`、`--participant`、`--from-me`、`--target-author`、`--target-author-uuid`
  - 注意：`--remove` 需要 `--emoji`（省略 `--emoji` 以清除自身反應（若支援）；請參閱 /tools/reactions）
  - 僅 WhatsApp：`--participant`、`--from-me`
  - Signal 群組反應：需要 `--target-author` 或 `--target-author-uuid`

- `reactions`
  - 頻道：Discord/Google Chat/Slack
  - 必要：`--message-id`、`--target`
  - 選用：`--limit`

- `read`
  - 頻道：Discord/Slack
  - 必要：`--target`
  - 選用：`--limit`、`--before`、`--after`
  - 僅 Discord：`--around`

- `edit`
  - 頻道：Discord/Slack
  - 必要：`--message-id`、`--message`、`--target`

- `delete`
  - 頻道：Discord/Slack/Telegram
  - 必要：`--message-id`、`--target`

- `pin` / `unpin`
  - 頻道：Discord/Slack
  - 必要：`--message-id`、`--target`

- `pins`（list）
  - 頻道：Discord/Slack
  - 必要：`--target`

- `permissions`
  - 頻道：Discord
  - 必要：`--target`

- `search`
  - 頻道：Discord
  - 必要：`--guild-id`、`--query`
  - 選用：`--channel-id`、`--channel-ids`（重複）、`--author-id`、`--author-ids`（重複）、`--limit`

### Threads

- `thread create`
  - 頻道：Discord
  - 必要：`--thread-name`、`--target`（頻道 id）
  - 選用：`--message-id`、`--message`、`--auto-archive-min`

- `thread list`
  - 頻道：Discord
  - 必要：`--guild-id`
  - 選用：`--channel-id`、`--include-archived`、`--before`、`--limit`

- `thread reply`
  - 頻道：Discord
  - 必要：`--target`（執行緒 id）、`--message`
  - 選用：`--media`、`--reply-to`

### Emojis

- `emoji list`
  - Discord：`--guild-id`
  - Slack：無額外旗標

- `emoji upload`
  - 頻道：Discord
  - 必要：`--guild-id`、`--emoji-name`、`--media`
  - 選用：`--role-ids`（重複）

### Stickers

- `sticker send`
  - 頻道：Discord
  - 必要：`--target`、`--sticker-id`（重複）
  - 選用：`--message`

- `sticker upload`
  - 頻道：Discord
  - 必要：`--guild-id`、`--sticker-name`、`--sticker-desc`、`--sticker-tags`、`--media`

### Roles / Channels / Members / Voice

- `role info`（Discord）：`--guild-id`
- `role add` / `role remove`（Discord）：`--guild-id`、`--user-id`、`--role-id`
- `channel info`（Discord）：`--target`
- `channel list`（Discord）：`--guild-id`
- `member info`（Discord/Slack）：`--user-id`（Discord 另加 `--guild-id`）
- `voice status`（Discord）：`--guild-id`、`--user-id`

### Events

- `event list`（Discord）：`--guild-id`
- `event create`（Discord）：`--guild-id`、`--event-name`、`--start-time`
  - 選用：`--end-time`、`--desc`、`--channel-id`、`--location`、`--event-type`

### Moderation（Discord）

- `timeout`：`--guild-id`、`--user-id`（選用 `--duration-min` 或 `--until`；省略兩者以清除逾時）
- `kick`：`--guild-id`、`--user-id`（+ `--reason`）
- `ban`：`--guild-id`、`--user-id`（+ `--delete-days`、`--reason`）
  - `timeout` 也支援 `--reason`

### Broadcast

- `broadcast`
  - 頻道：任何已設定的頻道；使用 `--channel all` 以鎖定所有提供者
  - 必要：`--targets`（重複）
  - 選用：`--message`、`--media`、`--dry-run`

## Examples

傳送 Discord 回覆：

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

傳送 Teams 主動式訊息：

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

建立 Teams 投票：

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

在 Slack 中加入反應：

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

在 Signal 群組中加入反應：

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

傳送 Telegram 行內按鈕：

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
