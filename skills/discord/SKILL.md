---
name: discord
description: Use when you need to control Discord from Clawdis via the discord tool: add reactions, send stickers, or create polls in Discord DMs or channels. Trigger for tasks like reacting to a message, posting a sticker, or running a quick poll for a decision.
---

# Discord Actions

## Overview

Use `discord` to manage messages, reactions, threads, and moderation. Reactions are gated by `discord.enableReactions` (default `true`). You can disable groups via `discord.actions.*`. The tool uses the bot token configured for Clawdis.

## Inputs to collect

- For reactions: `channelId`, `messageId`, and an `emoji`.
- For stickers/polls: a `to` target (`channel:<id>` or `user:<id>`). Optional `content` text.
- Polls also need a `question` plus 2–10 `answers`.

Message context lines include `discord message id` and `channel` fields you can reuse directly.

## Actions

### React to a message

```json
{
  "action": "react",
  "channelId": "123",
  "messageId": "456",
  "emoji": "✅"
}
```

### List reactions + users

```json
{
  "action": "reactions",
  "channelId": "123",
  "messageId": "456",
  "limit": 100
}
```

### Send a sticker

```json
{
  "action": "sticker",
  "to": "channel:123",
  "stickerIds": ["9876543210"],
  "content": "Nice work!"
}
```

- Up to 3 sticker IDs per message.
- `to` can be `user:<id>` for DMs.

### Create a poll

```json
{
  "action": "poll",
  "to": "channel:123",
  "question": "Lunch?",
  "answers": ["Pizza", "Sushi", "Salad"],
  "allowMultiselect": false,
  "durationHours": 24,
  "content": "Vote now"
}
```

- `durationHours` defaults to 24; max 32 days (768 hours).

### Check bot permissions for a channel

```json
{
  "action": "permissions",
  "channelId": "123"
}
```

## Ideas to try

- React with ✅/⚠️ to mark status updates.
- Post a quick poll for release decisions or meeting times.
- Send celebratory stickers after successful deploys.
- Run weekly “priority check” polls in team channels.
- DM stickers as acknowledgements when a user’s request is completed.

## Action gating

Use `discord.actions.*` to disable action groups:
- `reactions` (react + reactions list)
- `stickers`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`
- `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
- `roles` (role add/remove, default `false`)
- `moderation` (timeout/kick/ban, default `false`)
### Read recent messages

```json
{
  "action": "readMessages",
  "channelId": "123",
  "limit": 20
}
```

### Send/edit/delete a message

```json
{
  "action": "sendMessage",
  "to": "channel:123",
  "content": "Hello from Clawdis"
}
```

```json
{
  "action": "editMessage",
  "channelId": "123",
  "messageId": "456",
  "content": "Fixed typo"
}
```

```json
{
  "action": "deleteMessage",
  "channelId": "123",
  "messageId": "456"
}
```

### Threads

```json
{
  "action": "threadCreate",
  "channelId": "123",
  "name": "Bug triage",
  "messageId": "456"
}
```

```json
{
  "action": "threadList",
  "guildId": "999"
}
```

```json
{
  "action": "threadReply",
  "channelId": "777",
  "content": "Replying in thread"
}
```

### Pins

```json
{
  "action": "pinMessage",
  "channelId": "123",
  "messageId": "456"
}
```

```json
{
  "action": "listPins",
  "channelId": "123"
}
```

### Search messages

```json
{
  "action": "searchMessages",
  "guildId": "999",
  "content": "release notes",
  "channelIds": ["123", "456"],
  "limit": 10
}
```

### Member + role info

```json
{
  "action": "memberInfo",
  "guildId": "999",
  "userId": "111"
}
```

```json
{
  "action": "roleInfo",
  "guildId": "999"
}
```

### List available custom emojis

```json
{
  "action": "emojiList",
  "guildId": "999"
}
```

### Role changes (disabled by default)

```json
{
  "action": "roleAdd",
  "guildId": "999",
  "userId": "111",
  "roleId": "222"
}
```

### Channel info

```json
{
  "action": "channelInfo",
  "channelId": "123"
}
```

```json
{
  "action": "channelList",
  "guildId": "999"
}
```

### Voice status

```json
{
  "action": "voiceStatus",
  "guildId": "999",
  "userId": "111"
}
```

### Scheduled events

```json
{
  "action": "eventList",
  "guildId": "999"
}
```

### Moderation (disabled by default)

```json
{
  "action": "timeout",
  "guildId": "999",
  "userId": "111",
  "durationMinutes": 10
}
```
