---
summary: "openclaw message 的 CLI 參考文件（發送 + 頻道操作）"
read_when:
  - 新增或修改訊息 CLI 操作時
  - 變更外送頻道行為時
title: "message"
---

# `openclaw message`

用於發送訊息與頻道操作（Discord/Google Chat/Slack/Mattermost (plugin)/Telegram/WhatsApp/Signal/iMessage/MS Teams）的單一外送指令。

## 用法

```
openclaw message <subcommand> [flags]
```

頻道選擇：

- 若設定了多個頻道，則 `--channel` 為必填。
- 若僅設定了一個頻道，該頻道將成為預設值。
- 值：`whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`（Mattermost 需要 plugin）

目標格式 (`--target`)：

- WhatsApp: E.164 或群組 JID
- Telegram: chat id 或 `@username`
- Discord: `channel:<id>` 或 `user:<id>`（或 `< @id>` 提及；原始數字 ID 會被視為頻道）
- Google Chat: `spaces/<spaceId>` 或 `users/<userId>`
- Slack: `channel:<id>` 或 `user:<id>`（接受原始頻道 ID）
- Mattermost (plugin): `channel:<id>`、`user:<id>` 或 `@username`（單純的 ID 會被視為頻道）
- Signal: `+E.164`、`group:<id>`、`signal:+E.164`、`signal:group:<id>` 或 `username:<name>`/`u:<name>`
- iMessage: handle、`chat_id:<id>`、`chat_guid:<guid>` 或 `chat_identifier:<id>`
- MS Teams: 交談 ID（`19:... @thread.tacv2`）或 `conversation:<id>` 或 `user:<aad-object-id>`

名稱查詢：

- 對於支援的供應商（Discord/Slack 等），像 `Help` 或 `#help` 這樣的頻道名稱會透過文件目錄快取解析。
- 若快取未命中，OpenClaw 會在供應商支援時嘗試進行即時目錄查詢。

## 常用標記

- `--channel <name>`
- `--account <id>`
- `--target <dest>`（發送/輪詢/讀取等動作的目標頻道或使用者）
- `--targets <name>`（可重複；僅限廣播）
- `--json`
- `--dry-run`
- `--verbose`

## 操作

### 核心

- `send`
  - 頻道：WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams
  - 必填：`--target`，以及 `--message` 或 `--media`
  - 選填：`--media`、`--reply-to`、`--thread-id`、`--gif-playback`
  - 僅限 Telegram：`--buttons`（需要設定 `channels.telegram.capabilities.inlineButtons` 允許使用）
  - 僅限 Telegram：`--thread-id`（討論群組主題 ID）
  - 僅限 Slack：`--thread-id`（執行緒時間戳記；`--reply-to` 使用相同欄位）
  - 僅限 WhatsApp：`--gif-playback`

- `poll`
  - 頻道：WhatsApp/Discord/MS Teams
  - 必填：`--target`、`--poll-question`、`--poll-option`（可重複）
  - 選填：`--poll-multi`
  - 僅限 Discord：`--poll-duration-hours`、`--message`

- `react`
  - 頻道：Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - 必填：`--message-id`、`--target`
  - 選填：`--emoji`、`--remove`、`--participant`、`--from-me`、`--target-author`、`--target-author-uuid`
  - 注意：`--remove` 需要配合 `--emoji`（在支援的頻道中，省略 `--emoji` 可清除自己的所有回應；參閱 /tools/reactions）
  - 僅限 WhatsApp：`--participant`、`--from-me`
  - Signal 群組回應：需要 `--target-author` 或 `--target-author-uuid`

- `reactions`
  - 頻道：Discord/Google Chat/Slack
  - 必填：`--message-id`、`--target`
  - 選填：`--limit`

- `read`
  - 頻道：Discord/Slack
  - 必填：`--target`
  - 選填：`--limit`、`--before`、`--after`
  - 僅限 Discord：`--around`

- `edit`
  - 頻道：Discord/Slack
  - 必填：`--message-id`、`--message`、`--target`

- `delete`
  - 頻道：Discord/Slack/Telegram
  - 必填：`--message-id`、`--target`

- `pin` / `unpin`
  - 頻道：Discord/Slack
  - 必填：`--message-id`、`--target`

- `pins`（列表）
  - 頻道：Discord/Slack
  - 必填：`--target`

- `permissions`
  - 頻道：Discord
  - 必填：`--target`

- `search`
  - 頻道：Discord
  - 必填：`--guild-id`、`--query`
  - 選填：`--channel-id`、`--channel-ids`（可重複）、`--author-id`、`--author-ids`（可重複）、`--limit`

### 執行緒 (Threads)

- `thread create`
  - 頻道：Discord
  - 必填：`--thread-name`、`--target`（頻道 ID）
  - 選填：`--message-id`、`--message`、`--auto-archive-min`

- `thread list`
  - 頻道：Discord
  - 必填：`--guild-id`
  - 選填：`--channel-id`、`--include-archived`、`--before`、`--limit`

- `thread reply`
  - 頻道：Discord
  - 必填：`--target`（執行緒 ID）、`--message`
  - 選填：`--media`、`--reply-to`

### 表情符號 (Emojis)

- `emoji list`
  - Discord：`--guild-id`
  - Slack：無需額外標記

- `emoji upload`
  - 頻道：Discord
  - 必填：`--guild-id`、`--emoji-name`、`--media`
  - 選填：`--role-ids`（可重複）

### 貼圖 (Stickers)

- `sticker send`
  - 頻道：Discord
  - 必填：`--target`、`--sticker-id`（可重複）
  - 選填：`--message`

- `sticker upload`
  - 頻道：Discord
  - 必填：`--guild-id`、`--sticker-name`、`--sticker-desc`、`--sticker-tags`、`--media`

### 身分組 / 頻道 / 成員 / 語音

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`、`--user-id`、`--role-id`
- `channel info` (Discord): `--target`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (Discord 需額外加上 `--guild-id`)
- `voice status` (Discord): `--guild-id`、`--user-id`

### 活動 (Events)

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`、`--event-name`、`--start-time`
  - 選填：`--end-time`、`--desc`、`--channel-id`、`--location`、`--event-type`

### 管理 (Discord Moderation)

- `timeout`: `--guild-id`、`--user-id`（選填 `--duration-min` 或 `--until`；若兩者皆省略則清除禁言）
- `kick`: `--guild-id`、`--user-id`（+ `--reason`）
- `ban`: `--guild-id`、`--user-id`（+ `--delete-days`、`--reason`）
  - `timeout` 亦支援 `--reason`

### 廣播 (Broadcast)

- `broadcast`
  - 頻道：任何已設定的頻道；使用 `--channel all` 以所有供應商為目標
  - 必填：`--targets`（可重複）
  - 選填：`--message`、`--media`、`--dry-run`

## 範例

發送 Discord 回覆：

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

建立 Discord 投票：

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "要吃什麼零食？" \
  --poll-option 披薩 --poll-option 壽司 \
  --poll-multi --poll-duration-hours 48
```

發送 Teams 主動訊息：

```
openclaw message send --channel msteams \
  --target conversation:19:abc @thread.tacv2 --message "你好"
```

建立 Teams 投票：

```
openclaw message poll --channel msteams \
  --target conversation:19:abc @thread.tacv2 \
  --poll-question "午餐吃什麼？" \
  --poll-option 披薩 --poll-option 壽司
```

在 Slack 中加入回應：

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

在 Signal 群組中加入回應：

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

發送 Telegram 內嵌按鈕：

```
openclaw message send --channel telegram --target @mychat --message "請選擇：" \
  --buttons '[ [{"text":"是","callback_data":"cmd:yes"}], [{"text":"否","callback_data":"cmd:no"}] ]'
```
