---
title: WeCom
description: Connect OpenClaw to WeCom (Enterprise WeChat).
summary: "WeCom plugin setup, webhook configuration, access controls, and troubleshooting"
read_when:
  - You want to connect OpenClaw to WeCom (Enterprise WeChat) messages
  - You are configuring WeCom allowlists, group policy, or callback verification
---

Use WeCom when you want OpenClaw to handle Enterprise WeChat messages from your organization.
WeCom connects via the official [WeCom API](https://developer.work.weixin.qq.com/document/path/90664) using HTTP webhooks for inbound and REST API for outbound.

## Prerequisites

1. A WeCom enterprise account with admin access.
2. Create a self-built application in the WeCom admin console.
3. Note your `corpId`, `corpSecret`, and `agentId`.
4. Configure a callback URL for receiving messages.

## Quick start

1. Run the onboarding wizard:

```bash
openclaw setup wecom
```

Or manually set config in `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "wecom": {
      "enabled": true,
      "corpId": "your-corp-id",
      "corpSecret": "your-corp-secret",
      "agentId": "your-agent-id",
      "token": "your-callback-token",
      "encodingAESKey": "your-encoding-aes-key"
    }
  }
}
```

2. Start/restart gateway:

```bash
openclaw gateway run
```

3. Set the callback URL in WeCom admin console to `https://your-gateway-host/api/webhook/wecom`.

## Security defaults

| Setting               | Default     | Notes                                   |
| --------------------- | ----------- | --------------------------------------- |
| `dmPolicy`            | `pairing`   | New DM senders must pair first          |
| `groupPolicy`         | `allowlist` | Only listed groups are served           |
| Callback verification | Required    | AES-256-CBC encryption + SHA1 signature |

## Environment variables

| Variable                 | Description                    |
| ------------------------ | ------------------------------ |
| `WECOM_CORP_ID`          | Enterprise corp ID             |
| `WECOM_CORP_SECRET`      | Application secret             |
| `WECOM_AGENT_ID`         | Application agent ID           |
| `WECOM_TOKEN`            | Callback verification token    |
| `WECOM_ENCODING_AES_KEY` | AES key for message encryption |

## Configuration reference

See [Configuration](/configuration) for general options. WeCom-specific keys live under `channels.wecom`:

- `corpId` - Enterprise corp ID
- `corpSecret` - Application secret
- `agentId` - Application agent ID
- `token` - Callback verification token
- `encodingAESKey` - 43-character Base64 AES key
- `webhookPath` - Custom webhook path (default `/api/webhook/wecom`)
- `dmPolicy` - DM access policy: `pairing` (default), `allowlist`, `open`, `disabled`
- `groupPolicy` - Group access policy: `allowlist` (default), `open`, `disabled`
- `allowFrom` - List of allowed WeCom user IDs for DMs
- `groupAllowFrom` - List of allowed user IDs for group commands
- `groups` - Per-group configuration (keyed by group chat ID)
- `defaultTo` - Default reply target
