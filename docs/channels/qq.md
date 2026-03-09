---
title: QQ
description: Connect OpenClaw to QQ via Official QQ Bot API.
summary: "QQ plugin setup via Official Bot API, access controls, and troubleshooting"
read_when:
  - You want to connect OpenClaw to QQ private messages or group chats
  - You are configuring QQ allowlists, group policy, or mention gating
---

Use QQ when you want OpenClaw to handle QQ private messages, group chats, and guild channels.
QQ connects via the [Official QQ Bot API](https://bot.q.qq.com/wiki/develop/api-v2/) using WebSocket for inbound events and REST for outbound messages.

## Prerequisites

1. Register at the [QQ Open Platform](https://q.qq.com) and create a bot application.
2. Note your bot's `AppID` and `AppSecret`.
3. Enable the required intents (C2C messages and/or group messages) in the bot settings.

## Quick start

1. Run the onboarding wizard:

```bash
openclaw setup qq
```

Or manually set config in `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "qq": {
      "enabled": true,
      "appId": "your-app-id",
      "appSecret": "your-app-secret"
    }
  }
}
```

2. Start/restart gateway:

```bash
openclaw gateway run
```

## Security defaults

| Setting       | Default     | Notes                               |
| ------------- | ----------- | ----------------------------------- |
| `dmPolicy`    | `pairing`   | New DM senders must pair first      |
| `groupPolicy` | `allowlist` | Only listed groups are served       |
| Auth          | Automatic   | Token refreshed via AppID/AppSecret |

## Environment variables

| Variable        | Description             |
| --------------- | ----------------------- |
| `QQ_APP_ID`     | Bot AppID from q.qq.com |
| `QQ_APP_SECRET` | Bot AppSecret           |

## Rate limits

The official API enforces strict rate limits:

- **Active messages**: 4 per month per user or group (bot-initiated).
- **Passive replies**: Must reply within 5 minutes (group) or 60 minutes (C2C), max 5 replies per inbound message.
- **User IDs**: The API uses `openid` (platform-assigned opaque IDs), not QQ numbers.

## Configuration reference

See [Configuration](/configuration) for general options. QQ-specific keys live under `channels.qq`:

- `appId` - Bot application ID from QQ Open Platform
- `appSecret` - Bot application secret
- `dmPolicy` - DM access policy: `pairing` (default), `allowlist`, `open`, `disabled`
- `groupPolicy` - Group access policy: `allowlist` (default), `open`, `disabled`
- `allowFrom` - List of allowed sender openids for DMs
- `groupAllowFrom` - List of allowed sender openids for group commands
- `groups` - Per-group configuration (keyed by group openid)
- `defaultTo` - Default reply target (openid)
