---
summary: CLI reference for `openclaw message` (send + channel actions)
read_when:
  - Adding or modifying message CLI actions
  - Changing outbound channel behavior
title: message
---

# `openclaw message`

單一的外發指令用於發送訊息和頻道動作
(Discord/Google Chat/Slack/Mattermost (插件)/Telegram/WhatsApp/Signal/iMessage/MS Teams)。

## 使用方式

```
openclaw message <subcommand> [flags]
```

Channel selection:

- `--channel` 在設定多於一個通道時是必需的。
- 如果只設定了一個通道，則該通道將成為預設通道。
- 值: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` （Mattermost 需要插件）

Target formats (`--target`):

- WhatsApp: E.164 或群組 JID
- Telegram: 聊天 ID 或 `@username`
- Discord: `channel:<id>` 或 `user:<id>`（或 `<@id>` 提及；原始數字 ID 被視為頻道）
- Google Chat: `spaces/<spaceId>` 或 `users/<userId>`
- Slack: `channel:<id>` 或 `user:<id>`（接受原始頻道 ID）
- Mattermost（插件）: `channel:<id>`、`user:<id>` 或 `@username`（裸 ID 被視為頻道）
- Signal: `+E.164`、`group:<id>`、`signal:+E.164`、`signal:group:<id>` 或 `username:<name>`/`u:<name>`
- iMessage: 處理程序、`chat_id:<id>`、`chat_guid:<guid>` 或 `chat_identifier:<id>`
- MS Teams: 會話 ID (`19:...@thread.tacv2`) 或 `conversation:<id>` 或 `user:<aad-object-id>`

Name lookup:

- 對於支援的提供者（Discord/Slack等），像 `Help` 或 `#help` 的頻道名稱會透過目錄快取解析。
- 在快取未命中時，OpenClaw 將嘗試在提供者支援的情況下進行即時目錄查詢。

## Common flags

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (目標頻道或用戶，用於發送/投票/讀取等)
- `--targets <name>` (重複；僅限廣播)
- `--json`
- `--dry-run`
- `--verbose`

## Actions

### Core

- `send`
  - 通道: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (插件)/Signal/iMessage/MS Teams
  - 必需: `--target`，加上 `--message` 或 `--media`
  - 可選: `--media`，`--reply-to`，`--thread-id`，`--gif-playback`
  - 僅限 Telegram: `--buttons` (需要 `channels.telegram.capabilities.inlineButtons` 來允許)
  - 僅限 Telegram: `--thread-id` (論壇主題 ID)
  - 僅限 Slack: `--thread-id` (主題時間戳; `--reply-to` 使用相同的欄位)
  - 僅限 WhatsApp: `--gif-playback`

- `poll`
  - 頻道: WhatsApp/Telegram/Discord/Matrix/MS Teams
  - 必需: `--target`, `--poll-question`, `--poll-option` (重複)
  - 可選: `--poll-multi`
  - 僅限 Discord: `--poll-duration-hours`, `--silent`, `--message`
  - 僅限 Telegram: `--poll-duration-seconds` (5-600), `--silent`, `--poll-anonymous` / `--poll-public`, `--thread-id`

- `react`
  - 頻道：Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - 必需：`--message-id`, `--target`
  - 可選：`--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - 注意：`--remove` 需要 `--emoji`（省略 `--emoji` 以清除支援的自我反應；請參見 /tools/reactions）
  - 僅限 WhatsApp：`--participant`, `--from-me`
  - Signal 群組反應：`--target-author` 或 `--target-author-uuid` 必需

- `reactions`
  - 頻道: Discord/Google Chat/Slack
  - 必要: `--message-id`, `--target`
  - 可選: `--limit`

- `read`
  - 頻道: Discord/Slack
  - 必需: `--target`
  - 可選: `--limit`, `--before`, `--after`
  - 僅限 Discord: `--around`

- `edit`
  - 頻道: Discord/Slack
  - 必需: `--message-id`, `--message`, `--target`

- `delete`
  - 頻道: Discord/Slack/Telegram
  - 必需: `--message-id`, `--target`

- `pin` / `unpin`
  - 頻道: Discord/Slack
  - 必需: `--message-id`, `--target`

- `pins` (清單)
  - 頻道: Discord/Slack
  - 必需: `--target`

- `permissions`
  - 頻道: Discord
  - 必需: `--target`

- `search`
  - 頻道: Discord
  - 必需: `--guild-id`, `--query`
  - 可選: `--channel-id`, `--channel-ids` (重複), `--author-id`, `--author-ids` (重複), `--limit`

### Threads

- `thread create`
  - 頻道: Discord
  - 必要: `--thread-name`, `--target` (頻道 ID)
  - 可選: `--message-id`, `--message`, `--auto-archive-min`

- `thread list`
  - 頻道: Discord
  - 必需: `--guild-id`
  - 可選: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - 頻道: Discord
  - 必需: `--target` (線程 ID), `--message`
  - 可選: `--media`, `--reply-to`

### Emojis

- `emoji list`
  - Discord: `--guild-id`
  - Slack: 無額外標誌

- `emoji upload`
  - 頻道: Discord
  - 必需: `--guild-id`, `--emoji-name`, `--media`
  - 可選: `--role-ids` (重複)

### 貼紙

- `sticker send`
  - 頻道: Discord
  - 必需: `--target`, `--sticker-id` (重複)
  - 可選: `--message`

- `sticker upload`
  - 頻道: Discord
  - 必需: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### 角色 / 頻道 / 成員 / 語音

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`, `--user-id`, `--role-id`
- `channel info` (Discord): `--target`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (+ `--guild-id` for Discord)
- `voice status` (Discord): `--guild-id`, `--user-id`

### Events

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`, `--event-name`, `--start-time`
  - 可選: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### Moderation (Discord)

- `timeout`: `--guild-id`, `--user-id` (可選 `--duration-min` 或 `--until`; 若不使用則清除超時)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` 也支援 `--reason`

### Broadcast

- `broadcast`
  - 頻道：任何已設定的頻道；使用 `--channel all` 來針對所有提供者
  - 必需：`--targets`（重複）
  - 可選：`--message`、`--media`、`--dry-run`

## Examples

[[BLOCK_1]]

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

發送帶有元件的 Discord 訊息：

```
openclaw message send --channel discord \
  --target channel:123 --message "Choose:" \
  --components '{"text":"Choose a path","blocks":[{"type":"actions","buttons":[{"label":"Approve","style":"success"},{"label":"Decline","style":"danger"}]}]}'
```

請參閱 [Discord components](/channels/discord#interactive-components) 以獲取完整的架構。

[[BLOCK_1]]  
建立一個 Discord 投票：  
[[INLINE_1]]

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

建立一個 Telegram 投票（自動在 2 分鐘後關閉）：

```
openclaw message poll --channel telegram \
  --target @mychat \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-duration-seconds 120 --silent
```

發送 Teams 主動訊息：

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

[[BLOCK_1]]  
在 Slack 中使用 React：  
[[BLOCK_2]]

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

[[BLOCK_1]]  
在 Signal 群組中回應：  
[[BLOCK_1]]

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

發送 Telegram 內聯按鈕：

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
