---
name: slack
description: "Slack tool actions: send/read/edit/delete messages, react, pin/unpin, list pins/reactions/emoji, member info."
metadata: { "openclaw": { "emoji": "💬", "requires": { "config": ["channels.slack"] } } }
---

# Slack

Use the `slack` tool. Reuse `channelId` and Slack timestamp message IDs from context when present.

Harnesses that only see `mcp__openclaw__*` tools (Claude Code, etc.) reach the same surface as `mcp__openclaw__slack` via the OpenClaw-tools MCP bridge; the tool name stays `slack` and the `action` parameter selects the operation. The bridge routes through the Slack channel plugin and uses the configured Slack account credentials.

Admin actions (`createConversation`, `lookupUserByEmail`, `inviteUsers`, `listMembers`) are **disabled by default**. The host operator opts in per account by setting `channels.slack.actions.admin: true` and granting the bot the required scopes (`channels:manage` / `groups:write`, `users:read.email`, `conversations:write`, `channels:read`).

App manifest actions (`manifestCreate`, `manifestUpdate`, `manifestExport`, `manifestValidate`) are also **disabled by default** and gated separately on `channels.slack.actions.appManifest: true`. They additionally require `channels.slack.appConfigToken` (Slack `xoxe.xoxp-…` app configuration token) because they mutate the workspace app definition itself rather than channel state.

## Inputs

- `channelId`: Slack channel ID.
- `messageId`: Slack timestamp, e.g. `1712023032.1234`.
- `to`: `channel:<id>` or `user:<id>` for sends.
- `emoji`: Unicode or `:name:` for reactions.

## Actions

```json
{ "action": "sendMessage", "to": "channel:C123", "content": "Hello" }
```

```json
{ "action": "readMessages", "channelId": "C123", "limit": 20 }
```

```json
{
  "action": "react",
  "channelId": "C123",
  "messageId": "1712023032.1234",
  "emoji": ":white_check_mark:"
}
```

```json
{ "action": "reactions", "channelId": "C123", "messageId": "1712023032.1234" }
```

```json
{
  "action": "editMessage",
  "channelId": "C123",
  "messageId": "1712023032.1234",
  "content": "Updated text"
}
```

```json
{ "action": "deleteMessage", "channelId": "C123", "messageId": "1712023032.1234" }
```

```json
{ "action": "pinMessage", "channelId": "C123", "messageId": "1712023032.1234" }
```

```json
{ "action": "unpinMessage", "channelId": "C123", "messageId": "1712023032.1234" }
```

```json
{ "action": "listPins", "channelId": "C123" }
```

```json
{ "action": "memberInfo", "userId": "U123" }
```

```json
{ "action": "emojiList" }
```

### Admin actions (opt-in)

These only work when the host has set `channels.slack.actions.admin: true`. Call them with the same `slack` tool; the bridge errors with `Slack admin actions are disabled.` when the gate is off.

```json
{ "action": "lookupUserByEmail", "email": "alice@example.com" }
```

```json
{ "action": "createConversation", "name": "team-x", "isPrivate": false }
```

```json
{ "action": "inviteUsers", "channelId": "C123", "userIds": ["U1", "U2"] }
```

```json
{ "action": "listMembers", "channelId": "C123", "limit": 100 }
```

### App manifest actions (opt-in, separate gate)

These only work when `channels.slack.actions.appManifest: true` _and_ `channels.slack.appConfigToken` is set. They mutate the Slack app definition itself, so they stay behind a stricter gate than the channel admin actions.

```json
{ "action": "manifestCreate", "manifest": { "display_information": { "name": "Demo Bot" } } }
```

```json
{
  "action": "manifestUpdate",
  "appId": "A012345",
  "manifest": { "display_information": { "name": "Demo Bot v2" } }
}
```

```json
{ "action": "manifestExport", "appId": "A012345" }
```

```json
{ "action": "manifestValidate", "manifest": { "display_information": { "name": "Demo Bot" } } }
```

## Safety

- Confirm destructive deletes when context is unclear.
- Keep outbound messages short; avoid Markdown tables.
- Prefer thread/message IDs over fuzzy channel names.
