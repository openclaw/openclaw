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

---

## Custom bot name and avatar (`chat:write.customize`)

By default, OpenClaw posts to Slack under the app's display name and icon set in
[api.slack.com](https://api.slack.com). You can override this per-message so the
bot appears with your configured assistant name and avatar instead.

### What it does

When the bot token includes the `chat:write.customize` scope, OpenClaw
automatically adds `username` and `icon_emoji` (or `icon_url`) to every
`chat.postMessage` call made by the monitor (inbound-reply) path, so the bot
shows up in Slack channels with its configured identity.

The feature is **backward-compatible**: if the scope is absent, the message is
retried without the custom identity fields — no error is surfaced and delivery
is unaffected.

### Step 1 — Add the scope in api.slack.com

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and open your app.
2. Navigate to **OAuth & Permissions → Scopes → Bot Token Scopes**.
3. Click **Add an OAuth Scope** and add `chat:write.customize`.
4. Scroll to the top of the page and click **Reinstall to Workspace** (required
   after any scope change).

### Step 2 — Configure in openclaw.json

Set `ui.assistant.name` and optionally `ui.assistant.avatar`:

```json
{
  "ui": {
    "assistant": {
      "name": "Bernard",
      "avatar": "https://example.com/bernard-avatar.png"
    }
  }
}
```

| Field                | Effect in Slack                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `ui.assistant.name`  | Sets the `username` field — overrides the app's display name for this message.                  |
| `ui.assistant.avatar`| If an `https://` URL, sets `icon_url`. Otherwise `:robot_face:` is used as `icon_emoji` fallback.|

You can also configure identity at the agent level via `agents.<id>.identity.name`,
`agents.<id>.identity.avatar`, and `agents.<id>.identity.emoji`. `ui.assistant.*`
takes precedence over per-agent identity when both are set.
