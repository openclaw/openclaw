---
name: kook
description: Use when you need to control KOOK from Moltbot via the kook tool ,for example like these - send messages, react, manage channels, roles, emojis, and moderation features in KOOK guilds and channels.
metadata: { "openclaw": { "emoji": "🎮", "requires": { "config": ["channels.kook"] } } }
---

# KOOK Actions

## Overview

Use `kook` to manage messages, reactions, channels, roles, emojis, and moderation in KOOK guilds and channels. You can disable action groups via `kook.actions.*` (defaults to enabled, except moderation). The tool uses the bot token configured for Moltbot.

## Inputs to collect

- For reactions: `channelId`, `messageId`, and an `emoji`.
- For message operations: `channelId`, `messageId`, or a `to` target (`channel:<id>` or `user:<id>`).
- For guild operations: `guildId` is typically required.
- For role management: `guildId`, `userId`, and `roleId`.
- For channel management: `guildId`, `channelId`, and channel properties.

**Note:** `sendMessage` uses `to: "channel:<id>"` format, not `channelId`. Other actions like `react`, `readMessages`, `editMessage` use `channelId` directly.

## Actions

### User Operations

#### Get bot user info

```json
{
  "action": "getMe"
}
```

#### Get user info

```json
{
  "action": "getUser",
  "userId": "1234567890",
  "guildId": "0987654321"
}
```

### Message Operations

#### Send a message

```json
{
  "action": "sendMessage",
  "to": "channel:1234567890",
  "content": "Hello KOOK!"
}
```

**With KMarkdown formatting:**

```json
{
  "action": "sendMessage",
  "to": "channel:1234567890",
  "content": "**Bold** *Italic* `Code`",
  "type": 9
}
```

**With reply:**

```json
{
  "action": "sendMessage",
  "to": "channel:1234567890",
  "content": "Replying to your message",
  "quote": "msg_id_here"
}
```

#### Read recent messages

```json
{
  "action": "readMessages",
  "channelId": "1234567890",
  "limit": 20
}
```

#### Fetch a single message

```json
{
  "action": "fetchMessage",
  "msgId": "message_id_here"
}
```

#### Edit/delete a message

```json
{
  "action": "editMessage",
  "channelId": "1234567890",
  "messageId": "msg_id_here",
  "content": "Updated message content"
}
```

```json
{
  "action": "deleteMessage",
  "channelId": "1234567890",
  "messageId": "msg_id_here"
}
```

### Reactions

#### React to a message

```json
{
  "action": "react",
  "channelId": "1234567890",
  "messageId": "msg_id_here",
  "emoji": "👍"
}
```

#### List reactions

```json
{
  "action": "reactions",
  "channelId": "1234567890",
  "messageId": "msg_id_here",
  "emoji": "👍"
}
```

#### Remove reaction

```json
{
  "action": "removeReaction",
  "channelId": "1234567890",
  "messageId": "msg_id_here",
  "emoji": "👍"
}
```

### Guild Operations

#### Get guild info

```json
{
  "action": "getGuild",
  "guildId": "1234567890"
}
```

#### Get guild list

```json
{
  "action": "getGuildList"
}
```

#### Get guild user count

```json
{
  "action": "getGuildUserCount",
  "guildId": "1234567890"
}
```

#### Get guild users

```json
{
  "action": "getGuildUsers",
  "guildId": "1234567890",
  "page": 1,
  "pageSize": 50
}
```

#### Update user nickname

```json
{
  "action": "updateNickname",
  "guildId": "1234567890",
  "userId": "user_id_here",
  "nickname": "New Nickname"
}
```

#### Kick user from guild

```json
{
  "action": "kickUser",
  "guildId": "1234567890",
  "userId": "user_id_here"
}
```

#### Leave guild

```json
{
  "action": "leaveGuild",
  "guildId": "1234567890"
}
```

### Channel Management

#### Get channel info

```json
{
  "action": "getChannel",
  "channelId": "1234567890"
}
```

#### Get channel list

```json
{
  "action": "getChannelList",
  "guildId": "1234567890",
  "type": 1
}
```

#### Create channel

```json
{
  "action": "createChannel",
  "guildId": "1234567890",
  "name": "new-channel",
  "type": 1,
  "parentId": "parent_channel_id"
}
```

#### Update channel

```json
{
  "action": "updateChannel",
  "channelId": "1234567890",
  "name": "updated-name",
  "topic": "Channel topic",
  "slowMode": 10
}
```

#### Delete channel

```json
{
  "action": "deleteChannel",
  "channelId": "1234567890"
}
```

#### Move user between voice channels

```json
{
  "action": "moveUser",
  "userId": "user_id_here",
  "targetChannelId": "voice_channel_id"
}
```

### Role Management

#### Get role list

```json
{
  "action": "roleInfo",
  "guildId": "1234567890"
}
```

#### Create role

```json
{
  "action": "roleCreate",
  "guildId": "1234567890",
  "name": "New Role",
  "color": 16711680,
  "permissions": 0
}
```

#### Update role

```json
{
  "action": "roleUpdate",
  "guildId": "1234567890",
  "roleId": 12345,
  "name": "Updated Role",
  "color": 65280
}
```

#### Delete role

```json
{
  "action": "roleDelete",
  "guildId": "1234567890",
  "roleId": 12345
}
```

#### Grant role to user

```json
{
  "action": "roleGrant",
  "guildId": "1234567890",
  "userId": "user_id_here",
  "roleId": 12345
}
```

#### Revoke role from user

```json
{
  "action": "roleRevoke",
  "guildId": "1234567890",
  "userId": "user_id_here",
  "roleId": 12345
}
```

### Emoji Management

#### Get emoji list

```json
{
  "action": "emojiList",
  "guildId": "1234567890"
}
```

#### Create emoji

```json
{
  "action": "emojiCreate",
  "guildId": "1234567890",
  "name": "new_emoji",
  "emoji": "😀"
}
```

#### Update emoji

```json
{
  "action": "emojiUpdate",
  "guildId": "1234567890",
  "emojiId": "emoji_id_here",
  "name": "updated_emoji",
  "emoji": "😄"
}
```

#### Delete emoji

```json
{
  "action": "emojiDelete",
  "guildId": "1234567890",
  "emojiId": "emoji_id_here"
}
```

### Moderation

#### Get mute list

```json
{
  "action": "muteList",
  "guildId": "1234567890"
}
```

#### Create mute

```json
{
  "action": "muteCreate",
  "guildId": "1234567890",
  "userId": "user_id_here",
  "type": 1,
  "duration": 3600
}
```

#### Delete mute

```json
{
  "action": "muteDelete",
  "guildId": "1234567890",
  "userId": "user_id_here",
  "type": 1
}
```

## Action Gating

Use `kook.actions.*` to disable action groups:

- `reactions` (react + reactions list)
- `messages` (sendMessage, readMessages, editMessage, deleteMessage, fetchMessage)
- `memberInfo` (getUser, getGuildUsers, updateNickname)
- `roleInfo` (roleInfo)
- `roles` (roleCreate, roleUpdate, roleDelete, roleGrant, roleRevoke, default: false)
- `channelInfo` (getChannel, getChannelList, getChannelUserList)
- `channels` (createChannel, updateChannel, deleteChannel, default: false)
- `voiceStatus` (moveUser)
- `emojiList` (emojiList)
- `emojiUploads` (emojiCreate, emojiUpdate, emojiDelete, default: false)
- `moderation` (kickUser, muteCreate, muteDelete, default: false)
- `guildInfo` (getGuild, getGuildList, getGuildUserCount, getGuildUsers, leaveGuild)

## Message Types

| Type      | Value | Description             |
| --------- | ----- | ----------------------- |
| Text      | 1     | Plain text message      |
| Image     | 2     | Image message           |
| Video     | 3     | Video message           |
| File      | 4     | File message            |
| KMarkdown | 9     | Markdown format message |
| Card      | 10    | Card message            |
| Item      | 12    | Item message            |

## Ideas to try

- Send interactive KMarkdown messages with bold and italic formatting.
- React to messages with KOOK's emoji system.
- Manage server structure by creating and organizing channels.
- Set up role hierarchies with custom colors and permissions.
- Moderate servers by muting problematic users.
- Create and manage custom emojis for your guild.
- Track member activity with nickname updates.
- Build channel hierarchies with categories and voice channels.

## KOOK Writing Style Guide

**Keep it conversational!** KOOK is a gaming-focused chat platform.

### Do

- Use gaming language and emojis 🎮
- Be casual and friendly
- Use KMarkdown for emphasis: **bold**, _italic_, `code`
- Reference games and gaming culture
- Keep messages concise and actionable

### Don't

- Be overly formal or corporate
- Use complex markdown tables
- Write long essays
- Ignore the gaming community vibe

### KOOK-specific features

- KMarkdown for rich formatting: `**bold**`, `*italic*`, `||spoiler||`
- Card messages for interactive content
- Emoji reactions for quick responses
- Voice channel management for gaming sessions
