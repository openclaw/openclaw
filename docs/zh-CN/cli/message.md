---
read_when:
  - 添加或修改消息 CLI 操作
  - 更改出站渠道行为
summary: "`openclaw message`（发送 + 渠道操作）的 CLI 参考"
title: message
x-i18n:
  generated_at: "2026-02-01T20:21:30Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 35159baf1ef7136252e3ab1e5e03881ebc4196dd43425e2319a39306ced7f48c
  source_path: cli/message.md
  workflow: 14
---

# `openclaw message`

用于发送消息和渠道操作的单一出站命令
（Discord/Google Chat/Slack/Mattermost（插件）/Telegram/WhatsApp/Signal/iMessage/MS Teams）。

## 用法

```
openclaw message <subcommand> [flags]
```

渠道选择：

- 如果配置了多个渠道，则必须指定 `--channel`。
- 如果只配置了一个渠道，则该渠道为默认值。
- 可选值：`whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`（Mattermost 需要插件）

目标格式（`--target`）：

- WhatsApp：E.164 或群组 JID
- Telegram：聊天 ID 或 `@username`
- Discord：`channel:<id>` 或 `user:<id>`（或 `<@id>` 提及；纯数字 ID 被视为频道）
- Google Chat：`spaces/<spaceId>` 或 `users/<userId>`
- Slack：`channel:<id>` 或 `user:<id>`（接受纯频道 ID）
- Mattermost（插件）：`channel:<id>`、`user:<id>` 或 `@username`（纯 ID 被视为频道）
- Signal：`+E.164`、`group:<id>`、`signal:+E.164`、`signal:group:<id>` 或 `username:<name>`/`u:<name>`
- iMessage：句柄、`chat_id:<id>`、`chat_guid:<guid>` 或 `chat_identifier:<id>`
- MS Teams：会话 ID（`19:...@thread.tacv2`）或 `conversation:<id>` 或 `user:<aad-object-id>`

名称查找：

- 对于支持的提供商（Discord/Slack 等），如 `Help` 或 `#help` 之类的频道名称会通过目录缓存进行解析。
- 缓存未命中时，如果提供商支持，OpenClaw 将尝试实时目录查找。

## 通用标志

- `--channel <name>`
- `--account <id>`
- `--target <dest>`（用于 send/poll/read 等的目标渠道或用户）
- `--targets <name>`（可重复；仅限广播）
- `--json`
- `--dry-run`
- `--verbose`

## 操作

### 核心

- `send`
  - 渠道：WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost（插件）/Signal/iMessage/MS Teams
  - 必需：`--target`，以及 `--message` 或 `--media`
  - 可选：`--media`、`--reply-to`、`--thread-id`、`--gif-playback`
  - 仅限 Telegram：`--buttons`（需要 `channels.telegram.capabilities.inlineButtons` 以启用）
  - 仅限 Telegram：`--thread-id`（论坛主题 ID）
  - 仅限 Slack：`--thread-id`（线程时间戳；`--reply-to` 使用相同字段）
  - 仅限 WhatsApp：`--gif-playback`

- `poll`
  - 渠道：WhatsApp/Discord/MS Teams
  - 必需：`--target`、`--poll-question`、`--poll-option`（可重复）
  - 可选：`--poll-multi`
  - 仅限 Discord：`--poll-duration-hours`、`--message`

- `react`
  - 渠道：Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - 必需：`--message-id`、`--target`
  - 可选：`--emoji`、`--remove`、`--participant`、`--from-me`、`--target-author`、`--target-author-uuid`
  - 注意：`--remove` 需要 `--emoji`（省略 `--emoji` 可清除自己的表情回应（如果支持）；参见 /tools/reactions）
  - 仅限 WhatsApp：`--participant`、`--from-me`
  - Signal 群组表情回应：需要 `--target-author` 或 `--target-author-uuid`

- `reactions`
  - 渠道：Discord/Google Chat/Slack
  - 必需：`--message-id`、`--target`
  - 可选：`--limit`

- `read`
  - 渠道：Discord/Slack
  - 必需：`--target`
  - 可选：`--limit`、`--before`、`--after`
  - 仅限 Discord：`--around`

- `edit`
  - 渠道：Discord/Slack
  - 必需：`--message-id`、`--message`、`--target`

- `delete`
  - 渠道：Discord/Slack/Telegram
  - 必需：`--message-id`、`--target`

- `pin` / `unpin`
  - 渠道：Discord/Slack
  - 必需：`--message-id`、`--target`

- `pins`（列表）
  - 渠道：Discord/Slack
  - 必需：`--target`

- `permissions`
  - 渠道：Discord
  - 必需：`--target`

- `search`
  - 渠道：Discord
  - 必需：`--guild-id`、`--query`
  - 可选：`--channel-id`、`--channel-ids`（可重复）、`--author-id`、`--author-ids`（可重复）、`--limit`

### 线程

- `thread create`
  - 渠道：Discord
  - 必需：`--thread-name`、`--target`（频道 ID）
  - 可选：`--message-id`、`--auto-archive-min`

- `thread list`
  - 渠道：Discord
  - 必需：`--guild-id`
  - 可选：`--channel-id`、`--include-archived`、`--before`、`--limit`

- `thread reply`
  - 渠道：Discord
  - 必需：`--target`（线程 ID）、`--message`
  - 可选：`--media`、`--reply-to`

### 表情符号

- `emoji list`
  - Discord：`--guild-id`
  - Slack：无需额外标志

- `emoji upload`
  - 渠道：Discord
  - 必需：`--guild-id`、`--emoji-name`、`--media`
  - 可选：`--role-ids`（可重复）

### 贴纸

- `sticker send`
  - 渠道：Discord
  - 必需：`--target`、`--sticker-id`（可重复）
  - 可选：`--message`

- `sticker upload`
  - 渠道：Discord
  - 必需：`--guild-id`、`--sticker-name`、`--sticker-desc`、`--sticker-tags`、`--media`

### 角色 / 频道 / 成员 / 语音

- `role info`（Discord）：`--guild-id`
- `role add` / `role remove`（Discord）：`--guild-id`、`--user-id`、`--role-id`
- `channel info`（Discord）：`--target`
- `channel list`（Discord）：`--guild-id`
- `member info`（Discord/Slack）：`--user-id`（Discord 还需要 `--guild-id`）
- `voice status`（Discord）：`--guild-id`、`--user-id`

### 事件

- `event list`（Discord）：`--guild-id`
- `event create`（Discord）：`--guild-id`、`--event-name`、`--start-time`
  - 可选：`--end-time`、`--desc`、`--channel-id`、`--location`、`--event-type`

### 管理（Discord）

- `timeout`：`--guild-id`、`--user-id`（可选 `--duration-min` 或 `--until`；两者都省略则清除超时）
- `kick`：`--guild-id`、`--user-id`（+ `--reason`）
- `ban`：`--guild-id`、`--user-id`（+ `--delete-days`、`--reason`）
  - `timeout` 也支持 `--reason`

### 广播

- `broadcast`
  - 渠道：任何已配置的渠道；使用 `--channel all` 可针对所有提供商
  - 必需：`--targets`（可重复）
  - 可选：`--message`、`--media`、`--dry-run`

## 示例

发送 Discord 回复：

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

创建 Discord 投票：

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

发送 Teams 主动消息：

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

创建 Teams 投票：

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

在 Slack 中添加表情回应：

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

在 Signal 群组中添加表情回应：

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

发送 Telegram 内联按钮：

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
