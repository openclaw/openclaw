---
name: slack
description: Use when you need to control Slack from OpenClaw via the slack tool, including reacting to messages or pinning/unpinning items in Slack channels or DMs.
metadata: { "openclaw": { "emoji": "💬", "requires": { "config": ["channels.slack"] } } }
---

# Slack Actions

## Overview

Use `slack` to react, manage pins, send/edit/delete messages, and fetch member info. The tool uses the bot token configured for OpenClaw.

## Inputs to collect

- `channelId` and `messageId` (Slack message timestamp, e.g. `1712023032.1234`).
- For reactions, an `emoji` (Unicode or `:name:`).
- For message sends, a `to` target (`channel:<id>` or `user:<id>`) and `content`.

Message context lines include `slack message id` and `channel` fields you can reuse directly.

## Actions

### Action groups

| Action group | Default | Notes                  |
| ------------ | ------- | ---------------------- |
| reactions    | enabled | React + list reactions |
| messages     | enabled | Read/send/edit/delete  |
| pins         | enabled | Pin/unpin/list         |
| memberInfo   | enabled | Member info            |
| emojiList    | enabled | Custom emoji list      |

### React to a message

```json
{
  "action": "react",
  "channelId": "C123",
  "messageId": "1712023032.1234",
  "emoji": "✅"
}
```

### List reactions

```json
{
  "action": "reactions",
  "channelId": "C123",
  "messageId": "1712023032.1234"
}
```

### Send a message

```json
{
  "action": "sendMessage",
  "to": "channel:C123",
  "content": "Hello from OpenClaw"
}
```

### Edit a message

```json
{
  "action": "editMessage",
  "channelId": "C123",
  "messageId": "1712023032.1234",
  "content": "Updated text"
}
```

### Delete a message

```json
{
  "action": "deleteMessage",
  "channelId": "C123",
  "messageId": "1712023032.1234"
}
```

### Read recent messages

```json
{
  "action": "readMessages",
  "channelId": "C123",
  "limit": 20
}
```

### Pin a message

```json
{
  "action": "pinMessage",
  "channelId": "C123",
  "messageId": "1712023032.1234"
}
```

### Unpin a message

```json
{
  "action": "unpinMessage",
  "channelId": "C123",
  "messageId": "1712023032.1234"
}
```

### List pinned items

```json
{
  "action": "listPins",
  "channelId": "C123"
}
```

### Member info

```json
{
  "action": "memberInfo",
  "userId": "U123"
}
```

### Emoji list

```json
{
  "action": "emojiList"
}
```

## Ideas to try

- React with ✅ to mark completed tasks.
- Pin key decisions or weekly status updates.

## Integration and testing

### 1. Create Slack app and tokens

- In [Slack API](https://api.slack.com/apps): create an app (or use existing).
- Enable **Socket Mode**; create **App Token** (`xapp-...`) with `connections:write`.
- Install app to workspace; copy **Bot Token** (`xoxb-...`).
- Subscribe **Bot events**: `app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim`, `reaction_added`, `reaction_removed`, `member_joined_channel`, `member_left_channel`, `channel_rename`, `pin_added`, `pin_removed`.
- Enable App Home **Messages Tab** for DMs.
- Bot scopes: `chat:write`, `channels:history`, `channels:read`, `groups:history`, `im:history`, `mpim:history`, `users:read`, `app_mentions:read`, `reactions:read`, `reactions:write`, `pins:read`, `pins:write`, `emoji:read`, `commands`, `files:read`, `files:write` (and `assistant:write` if using streaming). See [Slack docs](/channels/slack) for full manifest.

### 2. Configure OpenClaw

**Option A – CLI (writes `~/.openclaw/openclaw.json`):**

```bash
openclaw channels add --channel slack --bot-token "xoxb-..." --app-token "xapp-..."
```

**Option B – Config file:**

```json5
// ~/.openclaw/openclaw.json
{
  channels: {
    slack: {
      enabled: true,
      mode: "socket",
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

**Option C – Env (default account only):** `SLACK_APP_TOKEN=xapp-...` and `SLACK_BOT_TOKEN=xoxb-...`.

### 3. Start gateway and verify

- Start gateway: **macOS** – use the OpenClaw menubar app (or `scripts/restart-mac.sh`); **CLI** – `openclaw gateway run`.
- Check status and probe credentials:

```bash
openclaw channels status
openclaw channels status --probe
```

- Resolve names to IDs (optional): `openclaw channels resolve --channel slack "#general" "@jane"`.
- Optional scope check: `openclaw channels capabilities --channel slack`.

### 4. Test in Slack

- **DM:** Open App Home → Messages; send a message. If using pairing (default), approve with `openclaw pairing approve slack <code>` (code shown in Slack).
- **Channel:** Invite the app to a channel, then mention the bot (`@OpenClaw` or your app name) and send a message.
- **Slack tool:** In an agent conversation, use the `slack` tool (react, sendMessage, readMessages, pinMessage, etc.) with `channelId` / `messageId` / `to` from message context.
