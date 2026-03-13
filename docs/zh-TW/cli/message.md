---
summary: CLI reference for `openclaw message` (send + channel actions)
read_when:
  - Adding or modifying message CLI actions
  - Changing outbound channel behavior
title: message
---

# `openclaw message`

單一外發指令，用於發送訊息及頻道操作
(Discord/Google Chat/Slack/Mattermost（外掛）/Telegram/WhatsApp/Signal/iMessage/MS Teams)。

## 使用說明

```
openclaw message <subcommand> [flags]
```

頻道選擇：

- `--channel` 當設定多於一個頻道時為必填。
- 若僅設定一個頻道，該頻道將成為預設。
- 值：`whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`（Mattermost 需要插件）

目標格式 (`--target`)：

- WhatsApp：E.164 或群組 JID
- Telegram：聊天 ID 或 `@username`
- Discord：`channel:<id>` 或 `user:<id>`（或 `<@id>` 提及；純數字 ID 視為頻道）
- Google Chat：`spaces/<spaceId>` 或 `users/<userId>`
- Slack：`channel:<id>` 或 `user:<id>`（接受純頻道 ID）
- Mattermost（插件）：`channel:<id>`、`user:<id>` 或 `@username`（純 ID 視為頻道）
- Signal：`+E.164`、`group:<id>`、`signal:+E.164`、`signal:group:<id>`，或 `username:<name>`/`u:<name>`
- iMessage：帳號、`chat_id:<id>`、`chat_guid:<guid>` 或 `chat_identifier:<id>`
- MS Teams：會話 ID（`19:...@thread.tacv2`）或 `conversation:<id>` 或 `user:<aad-object-id>`

名稱查詢：

- 對於支援的服務提供者（Discord/Slack 等），頻道名稱如 `Help` 或 `#help` 會透過目錄快取解析。
- 若快取未命中，OpenClaw 將在服務提供者支援時嘗試即時目錄查詢。

## 常用參數旗標

- `--channel <name>`
- `--account <id>`
- `--target <dest>`（發送/輪詢/讀取等的目標頻道或使用者）
- `--targets <name>`（重複；僅限廣播）
- `--json`
- `--dry-run`
- `--verbose`

## 動作

### 核心

- `send`
  - 支援頻道：WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost（外掛）/Signal/iMessage/MS Teams
  - 必填：`--target`，以及 `--message` 或 `--media`
  - 選填：`--media`、`--reply-to`、`--thread-id`、`--gif-playback`
  - 僅限 Telegram：`--buttons`（需 `channels.telegram.capabilities.inlineButtons` 允許）
  - 僅限 Telegram：`--thread-id`（論壇主題 ID）
  - 僅限 Slack：`--thread-id`（討論串時間戳；`--reply-to` 也使用此欄位）
  - 僅限 WhatsApp：`--gif-playback`

- `poll`
  - 支援頻道：WhatsApp/Telegram/Discord/Matrix/MS Teams
  - 必填專案：`--target`、`--poll-question`、`--poll-option`（可重複）
  - 選填專案：`--poll-multi`
  - 僅限 Discord：`--poll-duration-hours`、`--silent`、`--message`
  - 僅限 Telegram：`--poll-duration-seconds`（5-600）、`--silent`、`--poll-anonymous` / `--poll-public`、`--thread-id`

- `react`
  - 支援頻道：Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - 必填專案：`--message-id`、`--target`
  - 選填專案：`--emoji`、`--remove`、`--participant`、`--from-me`、`--target-author`、`--target-author-uuid`
  - 注意：`--remove` 需要 `--emoji`（若支援，省略 `--emoji` 可清除自己的回應；詳見 /tools/reactions）
  - 僅限 WhatsApp：`--participant`、`--from-me`
  - Signal 群組回應：需 `--target-author` 或 `--target-author-uuid`

- `reactions`
  - 支援頻道：Discord/Google Chat/Slack
  - 必填專案：`--message-id`、`--target`
  - 選填專案：`--limit`

- `read`
  - 支援頻道：Discord/Slack
  - 必填專案：`--target`
  - 選填專案：`--limit`、`--before`、`--after`
  - 僅限 Discord：`--around`

- `edit`
  - 支援頻道：Discord/Slack
  - 必填專案：`--message-id`、`--message`、`--target`

- `delete`
  - 支援頻道：Discord/Slack/Telegram
  - 必填欄位：`--message-id`、`--target`

- `pin` / `unpin`
  - 支援頻道：Discord/Slack
  - 必填欄位：`--message-id`、`--target`

- `pins`（列表）
  - 支援頻道：Discord/Slack
  - 必填欄位：`--target`

- `permissions`
  - 支援頻道：Discord
  - 必填欄位：`--target`

- `search`
  - 支援頻道：Discord
  - 必填欄位：`--guild-id`、`--query`
  - 選填欄位：`--channel-id`、`--channel-ids`（可重複）、`--author-id`、`--author-ids`（可重複）、`--limit`

### 主題討論串

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
  - 必填：`--target`（討論串 ID）、`--message`
  - 選填：`--media`、`--reply-to`

### 表情符號

- `emoji list`
  - Discord：`--guild-id`
  - Slack：無需額外標記

- `emoji upload`
  - 頻道：Discord
  - 必填：`--guild-id`、`--emoji-name`、`--media`
  - 選填：`--role-ids`（可重複）

### 貼圖

- `sticker send`
  - 頻道：Discord
  - 必填：`--target`、`--sticker-id`（可重複）
  - 選填：`--message`

- `sticker upload`
  - 頻道：Discord
  - 必填：`--guild-id`、`--sticker-name`、`--sticker-desc`、`--sticker-tags`、`--media`

### 角色 / 頻道 / 成員 / 語音

- `role info`（Discord）：`--guild-id`
- `role add` / `role remove`（Discord）：`--guild-id`、`--user-id`、`--role-id`
- `channel info`（Discord）：`--target`
- `channel list`（Discord）：`--guild-id`
- `member info`（Discord/Slack）：`--user-id`（Discord另加`--guild-id`）
- `voice status`（Discord）：`--guild-id`、`--user-id`

### 活動

- `event list`（Discord）：`--guild-id`
- `event create`（Discord）：`--guild-id`、`--event-name`、`--start-time`
  - 選用：`--end-time`、`--desc`、`--channel-id`、`--location`、`--event-type`

### 管理（Discord）

- `timeout`：`--guild-id`，`--user-id`（可選 `--duration-min` 或 `--until`；兩者皆省略則清除逾時設定）
- `kick`：`--guild-id`，`--user-id`（+ `--reason`）
- `ban`：`--guild-id`，`--user-id`（+ `--delete-days`，`--reason`）
  - `timeout` 也支援 `--reason`

### 廣播

- `broadcast`
  - 頻道：任一已設定頻道；使用 `--channel all` 以針對所有供應商
  - 必填：`--targets`（可重複）
  - 選填：`--message`、`--media`、`--dry-run`

## 範例

發送 Discord 回覆：

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

完整結構請參考 [Discord 元件](/channels/discord#interactive-components)。

建立 Discord 投票：

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

建立一個 Telegram 投票（2 分鐘後自動關閉）：

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

發送 Telegram 內嵌按鈕：

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
