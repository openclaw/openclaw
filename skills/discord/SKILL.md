---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: discord（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Use when you need to control Discord from OpenClaw via the discord tool: send messages, react, post or upload stickers, upload emojis, run polls, manage threads/pins/search, create/edit/delete channels and categories, fetch permissions or member/role/channel info, set bot presence/activity, or handle moderation actions in Discord DMs or channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata: {"openclaw":{"emoji":"🎮","requires":{"config":["channels.discord"]}}}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Discord Actions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `discord` to manage messages, reactions, threads, polls, and moderation. You can disable groups via `discord.actions.*` (defaults to enabled, except roles/moderation). The tool uses the bot token configured for OpenClaw.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Inputs to collect（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For reactions: `channelId`, `messageId`, and an `emoji`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For fetchMessage: `guildId`, `channelId`, `messageId`, or a `messageLink` like `https://discord.com/channels/<guildId>/<channelId>/<messageId>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For stickers/polls/sendMessage: a `to` target (`channel:<id>` or `user:<id>`). Optional `content` text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Polls also need a `question` plus 2–10 `answers`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For media: `mediaUrl` with `file:///path` for local files or `https://...` for remote.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For emoji uploads: `guildId`, `name`, `mediaUrl`, optional `roleIds` (limit 256KB, PNG/JPG/GIF).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For sticker uploads: `guildId`, `name`, `description`, `tags`, `mediaUrl` (limit 512KB, PNG/APNG/Lottie JSON).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Message context lines include `discord message id` and `channel` fields you can reuse directly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Note:** `sendMessage` uses `to: "channel:<id>"` format, not `channelId`. Other actions like `react`, `readMessages`, `editMessage` use `channelId` directly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Note:** `fetchMessage` accepts message IDs or full links like `https://discord.com/channels/<guildId>/<channelId>/<messageId>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Actions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### React to a message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "react",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channelId": "123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "messageId": "456",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "emoji": "✅"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### List reactions + users（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "reactions",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channelId": "123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "messageId": "456",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "limit": 100（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Send a sticker（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "sticker",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "to": "channel:123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "stickerIds": ["9876543210"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "content": "Nice work!"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Up to 3 sticker IDs per message.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `to` can be `user:<id>` for DMs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Upload a custom emoji（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "emojiUpload",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "guildId": "999",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "name": "party_blob",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "mediaUrl": "file:///tmp/party.png",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "roleIds": ["222"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Emoji images must be PNG/JPG/GIF and <= 256KB.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `roleIds` is optional; omit to make the emoji available to everyone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Upload a sticker（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "stickerUpload",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "guildId": "999",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "name": "openclaw_wave",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "description": "OpenClaw waving hello",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "tags": "👋",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "mediaUrl": "file:///tmp/wave.png"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Stickers require `name`, `description`, and `tags`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uploads must be PNG/APNG/Lottie JSON and <= 512KB.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Create a poll（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "poll",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "to": "channel:123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "question": "Lunch?",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "answers": ["Pizza", "Sushi", "Salad"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "allowMultiselect": false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "durationHours": 24,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "content": "Vote now"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `durationHours` defaults to 24; max 32 days (768 hours).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Check bot permissions for a channel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "permissions",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channelId": "123"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Ideas to try（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- React with ✅/⚠️ to mark status updates.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Post a quick poll for release decisions or meeting times.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send celebratory stickers after successful deploys.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Upload new emojis/stickers for release moments.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run weekly “priority check” polls in team channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DM stickers as acknowledgements when a user’s request is completed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Action gating（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `discord.actions.*` to disable action groups:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `reactions` (react + reactions list + emojiList)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `stickers`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `emojiUploads`, `stickerUploads`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `roles` (role add/remove, default `false`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels` (channel/category create/edit/delete/move, default `false`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `moderation` (timeout/kick/ban, default `false`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `presence` (bot status/activity, default `false`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Read recent messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "readMessages",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channelId": "123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "limit": 20（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fetch a single message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "fetchMessage",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "guildId": "999",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channelId": "123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "messageId": "456"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "fetchMessage",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "messageLink": "https://discord.com/channels/999/123/456"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Send/edit/delete a message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "sendMessage",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "to": "channel:123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "content": "Hello from OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**With media attachment:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "sendMessage",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "to": "channel:123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "content": "Check out this audio!",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "mediaUrl": "file:///tmp/audio.mp3"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `to` uses format `channel:<id>` or `user:<id>` for DMs (not `channelId`!)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `mediaUrl` supports local files (`file:///path/to/file`) and remote URLs (`https://...`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional `replyTo` with a message ID to reply to a specific message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "editMessage",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channelId": "123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "messageId": "456",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "content": "Fixed typo"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "deleteMessage",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channelId": "123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "messageId": "456"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Threads（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "threadCreate",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channelId": "123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "name": "Bug triage",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "messageId": "456"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "threadList",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "guildId": "999"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "threadReply",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channelId": "777",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "content": "Replying in thread"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Pins（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "pinMessage",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channelId": "123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "messageId": "456"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "listPins",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channelId": "123"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Search messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "searchMessages",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "guildId": "999",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "content": "release notes",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channelIds": ["123", "456"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "limit": 10（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Member + role info（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "memberInfo",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "guildId": "999",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "userId": "111"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "roleInfo",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "guildId": "999"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### List available custom emojis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "emojiList",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "guildId": "999"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Role changes (disabled by default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "roleAdd",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "guildId": "999",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "userId": "111",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "roleId": "222"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Channel info（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "channelInfo",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channelId": "123"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "channelList",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "guildId": "999"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Channel management (disabled by default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create, edit, delete, and move channels and categories. Enable via `discord.actions.channels: true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Create a text channel:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "channelCreate",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "guildId": "999",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "name": "general-chat",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "type": 0,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "parentId": "888",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "topic": "General discussion"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `type`: Discord channel type integer (0 = text, 2 = voice, 4 = category; other values supported)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `parentId`: category ID to nest under (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `topic`, `position`, `nsfw`: optional（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Create a category:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "categoryCreate",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "guildId": "999",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "name": "Projects"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Edit a channel:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "channelEdit",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channelId": "123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "name": "new-name",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "topic": "Updated topic"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Supports `name`, `topic`, `position`, `parentId` (null to remove from category), `nsfw`, `rateLimitPerUser`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Move a channel:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "channelMove",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "guildId": "999",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channelId": "123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "parentId": "888",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "position": 2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `parentId`: target category (null to move to top level)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Delete a channel:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "channelDelete",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channelId": "123"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Edit/delete a category:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "categoryEdit",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "categoryId": "888",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "name": "Renamed Category"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "categoryDelete",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "categoryId": "888"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Voice status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "voiceStatus",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "guildId": "999",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "userId": "111"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Scheduled events（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "eventList",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "guildId": "999"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Moderation (disabled by default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "timeout",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "guildId": "999",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "userId": "111",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "durationMinutes": 10（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Bot presence/activity (disabled by default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set the bot's online status and activity. Enable via `discord.actions.presence: true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Discord bots can only set `name`, `state`, `type`, and `url` on an activity. Other Activity fields (details, emoji, assets) are accepted by the gateway but silently ignored by Discord for bots.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**How fields render by activity type:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **playing, streaming, listening, watching, competing**: `activityName` is shown in the sidebar under the bot's name (e.g. "**with fire**" for type "playing" and name "with fire"). `activityState` is shown in the profile flyout.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **custom**: `activityName` is ignored. Only `activityState` is displayed as the status text in the sidebar.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **streaming**: `activityUrl` may be displayed or embedded by the client.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Set playing status:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "setPresence",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "activityType": "playing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "activityName": "with fire"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Result in sidebar: "**with fire**". Flyout shows: "Playing: with fire"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**With state (shown in flyout):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "setPresence",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "activityType": "playing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "activityName": "My Game",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "activityState": "In the lobby"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Result in sidebar: "**My Game**". Flyout shows: "Playing: My Game (newline) In the lobby".（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Set streaming (optional URL, may not render for bots):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "setPresence",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "activityType": "streaming",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "activityName": "Live coding",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "activityUrl": "https://twitch.tv/example"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Set listening/watching:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "setPresence",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "activityType": "listening",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "activityName": "Spotify"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "setPresence",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "activityType": "watching",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "activityName": "the logs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Set a custom status (text in sidebar):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "setPresence",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "activityType": "custom",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "activityState": "Vibing"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Result in sidebar: "Vibing". Note: `activityName` is ignored for custom type.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Set bot status only (no activity/clear status):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "setPresence",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "status": "dnd"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Parameters:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `activityType`: `playing`, `streaming`, `listening`, `watching`, `competing`, `custom`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `activityName`: text shown in the sidebar for non-custom types (ignored for `custom`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `activityUrl`: Twitch or YouTube URL for streaming type (optional; may not render for bots)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `activityState`: for `custom` this is the status text; for other types it shows in the profile flyout（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `status`: `online` (default), `dnd`, `idle`, `invisible`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Discord Writing Style Guide（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Keep it conversational!** Discord is a chat platform, not documentation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Do（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Short, punchy messages (1-3 sentences ideal)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multiple quick replies > one wall of text（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use emoji for tone/emphasis 🦞（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Lowercase casual style is fine（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Break up info into digestible chunks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Match the energy of the conversation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Don't（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No markdown tables (Discord renders them as ugly raw `| text |`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No `## Headers` for casual chat (use **bold** or CAPS for emphasis)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Avoid multi-paragraph essays（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Don't over-explain simple things（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skip the "I'd be happy to help!" fluff（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Formatting that works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **bold** for emphasis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `code` for technical terms（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Lists for multiple items（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- > quotes for referencing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Wrap multiple links in `<>` to suppress embeds（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Example transformations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
❌ Bad:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
I'd be happy to help with that! Here's a comprehensive overview of the versioning strategies available:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Semantic Versioning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Semver uses MAJOR.MINOR.PATCH format where...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Calendar Versioning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CalVer uses date-based versions like...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
✅ Good:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
versioning options: semver (1.2.3), calver (2026.01.04), or yolo (`latest` forever). what fits your release cadence?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
