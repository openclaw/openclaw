---
name: bluebubbles
<<<<<<< HEAD
description: Build or update the BlueBubbles external channel plugin for OpenClaw (extension package, REST send/probe, webhook inbound).
---

# BlueBubbles plugin

Use this skill when working on the BlueBubbles channel plugin.

## Layout

- Extension package: `extensions/bluebubbles/` (entry: `index.ts`).
- Channel implementation: `extensions/bluebubbles/src/channel.ts`.
- Webhook handling: `extensions/bluebubbles/src/monitor.ts` (register via `api.registerHttpHandler`).
- REST helpers: `extensions/bluebubbles/src/send.ts` + `extensions/bluebubbles/src/probe.ts`.
- Runtime bridge: `extensions/bluebubbles/src/runtime.ts` (set via `api.runtime`).
- Catalog entry for onboarding: `src/channels/plugins/catalog.ts`.

## Internal helpers (use these, not raw API calls)

- `probeBlueBubbles` in `extensions/bluebubbles/src/probe.ts` for health checks.
- `sendMessageBlueBubbles` in `extensions/bluebubbles/src/send.ts` for text delivery.
- `resolveChatGuidForTarget` in `extensions/bluebubbles/src/send.ts` for chat lookup.
- `sendBlueBubblesReaction` in `extensions/bluebubbles/src/reactions.ts` for tapbacks.
- `sendBlueBubblesTyping` + `markBlueBubblesChatRead` in `extensions/bluebubbles/src/chat.ts`.
- `downloadBlueBubblesAttachment` in `extensions/bluebubbles/src/attachments.ts` for inbound media.
- `buildBlueBubblesApiUrl` + `blueBubblesFetchWithTimeout` in `extensions/bluebubbles/src/types.ts` for shared REST plumbing.

## Webhooks

- BlueBubbles posts JSON to the gateway HTTP server.
- Normalize sender/chat IDs defensively (payloads vary by version).
- Skip messages marked as from self.
- Route into core reply pipeline via the plugin runtime (`api.runtime`) and `openclaw/plugin-sdk` helpers.
- For attachments/stickers, use `<media:...>` placeholders when text is empty and attach media paths via `MediaUrl(s)` in the inbound context.

## Config (core)

- `channels.bluebubbles.serverUrl` (base URL), `channels.bluebubbles.password`, `channels.bluebubbles.webhookPath`.
- Action gating: `channels.bluebubbles.actions.reactions` (default true).

## Message tool notes

- **Reactions:** The `react` action requires a `target` (phone number or chat identifier) in addition to `messageId`. Example: `action=react target=+15551234567 messageId=ABC123 emoji=❤️`
=======
description: Use when you need to send or manage iMessages via BlueBubbles (recommended iMessage integration). Calls go through the generic message tool with channel="bluebubbles".
metadata: { "openclaw": { "emoji": "🫧", "requires": { "config": ["channels.bluebubbles"] } } }
---

# BlueBubbles Actions

## Overview

BlueBubbles is OpenClaw’s recommended iMessage integration. Use the `message` tool with `channel: "bluebubbles"` to send messages and manage iMessage conversations: send texts and attachments, react (tapbacks), edit/unsend, reply in threads, and manage group participants/names/icons.

## Inputs to collect

- `target` (prefer `chat_guid:...`; also `+15551234567` in E.164 or `user@example.com`)
- `message` text for send/edit/reply
- `messageId` for react/edit/unsend/reply
- Attachment `path` for local files, or `buffer` + `filename` for base64

If the user is vague ("text my mom"), ask for the recipient handle or chat guid and the exact message content.

## Actions

### Send a message

```json
{
  "action": "send",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "message": "hello from OpenClaw"
}
```

### React (tapback)

```json
{
  "action": "react",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "messageId": "<message-guid>",
  "emoji": "❤️"
}
```

### Remove a reaction

```json
{
  "action": "react",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "messageId": "<message-guid>",
  "emoji": "❤️",
  "remove": true
}
```

### Edit a previously sent message

```json
{
  "action": "edit",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "messageId": "<message-guid>",
  "message": "updated text"
}
```

### Unsend a message

```json
{
  "action": "unsend",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "messageId": "<message-guid>"
}
```

### Reply to a specific message

```json
{
  "action": "reply",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "replyTo": "<message-guid>",
  "message": "replying to that"
}
```

### Send an attachment

```json
{
  "action": "sendAttachment",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "path": "/tmp/photo.jpg",
  "caption": "here you go"
}
```

### Send with an iMessage effect

```json
{
  "action": "sendWithEffect",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "message": "big news",
  "effect": "balloons"
}
```

## Notes

- Requires gateway config `channels.bluebubbles` (serverUrl/password/webhookPath).
- Prefer `chat_guid` targets when you have them (especially for group chats).
- BlueBubbles supports rich actions, but some are macOS-version dependent (for example, edit may be broken on macOS 26 Tahoe).
- The gateway may expose both short and full message ids; full ids are more durable across restarts.
- Developer reference for the underlying plugin lives in `extensions/bluebubbles/README.md`.

## Ideas to try

- React with a tapback to acknowledge a request.
- Reply in-thread when a user references a specific message.
- Send a file attachment with a short caption.
>>>>>>> upstream/main
