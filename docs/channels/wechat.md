---
title: WeChat
description: Connect OpenClaw to WeChat personal accounts via Wechaty.
summary: "WeChat plugin setup via Wechaty, QR login, access controls, and troubleshooting"
read_when:
  - You want to connect OpenClaw to WeChat personal messages or group chats
  - You are configuring WeChat allowlists, group policy, or Wechaty puppet
---

Use WeChat when you want OpenClaw to handle personal WeChat messages and group chats.
WeChat connects via [Wechaty](https://github.com/wechaty/wechaty), a conversational RPA SDK that supports multiple puppet implementations.

## Prerequisites

1. A WeChat account for the bot to log in with.
2. Install the Wechaty puppet of your choice (default: `wechaty-puppet-wechat4`).

## Quick start

1. Run the onboarding wizard:

```bash
openclaw setup wechat
```

Or manually set config in `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "wechat": {
      "enabled": true
    }
  }
}
```

2. Start/restart gateway:

```bash
openclaw gateway run
```

3. Scan the QR code displayed in the terminal with your WeChat app to log in.

## Security defaults

| Setting        | Default      | Notes                                         |
| -------------- | ------------ | --------------------------------------------- |
| `dmPolicy`     | `pairing`    | New DM senders must pair first                |
| `groupPolicy`  | `allowlist`  | Only listed groups (by room topic) are served |
| Authentication | QR code scan | No token or password needed                   |

## Puppets

Wechaty uses a "puppet" abstraction to connect to WeChat. The default puppet is `wechaty-puppet-wechat4` (web protocol). You can switch to other puppets:

- `wechaty-puppet-wechat4` - Web protocol (default, free)
- `wechaty-puppet-padlocal` - iPad protocol (requires token)
- `wechaty-puppet-xp` - Windows desktop protocol

Set the puppet in config:

```json
{
  "channels": {
    "wechat": {
      "puppet": "wechaty-puppet-padlocal",
      "puppetOptions": {
        "token": "your-padlocal-token"
      }
    }
  }
}
```

## Configuration reference

See [Configuration](/configuration) for general options. WeChat-specific keys live under `channels.wechat`:

- `puppet` - Wechaty puppet name (default `wechaty-puppet-wechat4`)
- `puppetOptions` - Puppet-specific options (e.g. token)
- `dmPolicy` - DM access policy: `pairing` (default), `allowlist`, `open`, `disabled`
- `groupPolicy` - Group access policy: `allowlist` (default), `open`, `disabled`
- `allowFrom` - List of allowed WeChat IDs for DMs
- `groupAllowFrom` - List of allowed WeChat IDs for group commands
- `groups` - Per-group configuration (keyed by room topic)
- `defaultTo` - Default reply target
