---
name: discord
description: "Discord ops via the message tool (channel=discord)."
metadata: { "openclaw": { "emoji": "🎮", "requires": { "config": ["channels.discord.token"] } } }
allowed-tools: ["message"]
---

# Discord（通过 `message`）

使用 `message` 工具。没有向 agent 公开的特定于提供商的 `discord` 工具。

## 必须遵守

- 始终：`channel: "discord"`。
- 尊重门控：`channels.discord.actions.*`（一些默认关闭：`roles`、`moderation`、`presence`、`channels`）。
- 优先使用显式 id：`guildId`、`channelId`、`messageId`、`userId`。
- 多账户：可选 `accountId`。

## 指南

- 避免在出站 Discord 消息中使用 Markdown 表格。
- 提及其他用户为 `<@USER_ID>`。
- 优先使用 Discord components v2（`components`）实现富 UI；仅在必须时使用旧版 `embeds`。

## 目标

- 发送类操作：`to: "channel:<id>"` 或 `to: "user:<id>"`。
- 特定消息操作：`channelId: "<id>"`（或 `to`）+ `messageId: "<id>"`。

## 常用操作（示例）

发送消息：

```json
{
  "action": "send",
  "channel": "discord",
  "to": "channel:123",
  "message": "hello",
  "silent": true
}
```

带媒体发送：

```json
{
  "action": "send",
  "channel": "discord",
  "to": "channel:123",
  "message": "see attachment",
  "media": "file:///tmp/example.png"
}
```

- 可选 `silent: true` 以禁止 Discord 通知。

带 components v2 发送（推荐用于富 UI）：

```json
{
  "action": "send",
  "channel": "discord",
  "to": "channel:123",
  "message": "Status update",
  "components": "[Carbon v2 components]"
}
```

- `components` 期望来自 JS/TS 集成的 Carbon 组件实例（Container、TextDisplay 等）。
- 不要将 `components` 与 `embeds` 组合使用（Discord 拒绝 v2 + embeds）。

旧版 embeds（不推荐）：

```json
{
  "action": "send",
  "channel": "discord",
  "to": "channel:123",
  "message": "Status update",
  "embeds": [{ "title": "Legacy", "description": "Embeds are legacy." }]
}
```

- 当存在 components v2 时，`embeds` 被忽略。

反应：

```json
{
  "action": "react",
  "channel": "discord",
  "channelId": "123",
  "messageId": "456",
  "emoji": "✅"
}
```

读取：

```json
{
  "action": "read",
  "channel": "discord",
  "to": "channel:123",
  "limit": 20
}
```

编辑 / 删除：

```json
{
  "action": "edit",
  "channel": "discord",
  "channelId": "123",
  "messageId": "456",
  "message": "fixed typo"
}
```

```json
{
  "action": "delete",
  "channel": "discord",
  "channelId": "123",
  "messageId": "456"
}
```

投票：

```json
{
  "action": "poll",
  "channel": "discord",
  "to": "channel:123",
  "pollQuestion": "Lunch?",
  "pollOption": ["Pizza", "Sushi", "Salad"],
  "pollMulti": false,
  "pollDurationHours": 24
}
```

固定：

```json
{
  "action": "pin",
  "channel": "discord",
  "channelId": "123",
  "messageId": "456"
}
```

线程：

```json
{
  "action": "thread-create",
  "channel": "discord",
  "channelId": "123",
  "messageId": "456",
  "threadName": "bug triage"
}
```

搜索：

```json
{
  "action": "search",
  "channel": "discord",
  "guildId": "999",
  "query": "release notes",
  "channelIds": ["123", "456"],
  "limit": 10
}
```

在线状态（经常有门控）：

```json
{
  "action": "set-presence",
  "channel": "discord",
  "activityType": "playing",
  "activityName": "with fire",
  "status": "online"
}
```

## 写作风格（Discord）

- 简短、对话式、低仪式感。
- 不使用 markdown 表格。
- 提及其他用户为 `<@USER_ID>`。
