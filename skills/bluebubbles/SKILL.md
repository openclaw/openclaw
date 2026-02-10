---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: bluebubbles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Use when you need to send or manage iMessages via BlueBubbles (recommended iMessage integration). Calls go through the generic message tool with channel="bluebubbles".（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata: { "openclaw": { "emoji": "🫧", "requires": { "config": ["channels.bluebubbles"] } } }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# BlueBubbles Actions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
BlueBubbles is OpenClaw’s recommended iMessage integration. Use the `message` tool with `channel: "bluebubbles"` to send messages and manage iMessage conversations: send texts and attachments, react (tapbacks), edit/unsend, reply in threads, and manage group participants/names/icons.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Inputs to collect（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `target` (prefer `chat_guid:...`; also `+15551234567` in E.164 or `user@example.com`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message` text for send/edit/reply（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `messageId` for react/edit/unsend/reply（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Attachment `path` for local files, or `buffer` + `filename` for base64（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the user is vague ("text my mom"), ask for the recipient handle or chat guid and the exact message content.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Actions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Send a message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "send",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channel": "bluebubbles",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "target": "+15551234567",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "message": "hello from OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### React (tapback)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "react",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channel": "bluebubbles",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "target": "+15551234567",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "messageId": "<message-guid>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "emoji": "❤️"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Remove a reaction（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "react",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channel": "bluebubbles",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "target": "+15551234567",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "messageId": "<message-guid>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "emoji": "❤️",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "remove": true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Edit a previously sent message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "edit",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channel": "bluebubbles",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "target": "+15551234567",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "messageId": "<message-guid>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "message": "updated text"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Unsend a message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "unsend",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channel": "bluebubbles",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "target": "+15551234567",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "messageId": "<message-guid>"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Reply to a specific message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "reply",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channel": "bluebubbles",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "target": "+15551234567",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "replyTo": "<message-guid>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "message": "replying to that"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Send an attachment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "sendAttachment",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channel": "bluebubbles",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "target": "+15551234567",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "path": "/tmp/photo.jpg",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "caption": "here you go"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Send with an iMessage effect（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "sendWithEffect",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channel": "bluebubbles",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "target": "+15551234567",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "message": "big news",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "effect": "balloons"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requires gateway config `channels.bluebubbles` (serverUrl/password/webhookPath).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer `chat_guid` targets when you have them (especially for group chats).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- BlueBubbles supports rich actions, but some are macOS-version dependent (for example, edit may be broken on macOS 26 Tahoe).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The gateway may expose both short and full message ids; full ids are more durable across restarts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Developer reference for the underlying plugin lives in `extensions/bluebubbles/README.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Ideas to try（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- React with a tapback to acknowledge a request.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reply in-thread when a user references a specific message.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send a file attachment with a short caption.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
