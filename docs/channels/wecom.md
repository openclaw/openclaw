---
summary: "WeCom setup, config, and usage"
read_when:
  - You want to connect OpenClaw to WeCom (企业微信)
  - You need WeCom Bot credential setup
title: WeCom
---

# WeCom (企业微信)

WeCom connects to OpenClaw via **Bot WebSocket** long-connection, using the
official WeCom Bot API for real-time bidirectional messaging.

The plugin supports direct messages, group chats, media (images, voice, video,
files), and MCP tool integration.

Status: bundled plugin. Direct messages, group chats, and media are supported.

## Bundled plugin

Current OpenClaw releases bundle WeCom, so normal packaged builds do not need
a separate `openclaw plugins install` step.

## Setup

1. Log in to the [WeCom Admin Console](https://work.weixin.qq.com/wework_admin/frame#/aiHelper/list?from=openclaw)
   and navigate to **Smart Bots** (智能机器人).
2. Click **Create Bot** to create a new bot.
3. Find **Bot ID** and **Secret** on the bot's settings page and copy them.

> The Secret is only shown once during creation. If you leave the page without
> saving, you will need to regenerate it.

4. Add the channel:

```bash
openclaw channels add --channel wecom --token "YOUR_BOT_ID" --private-key "YOUR_SECRET"
```

> `--token` maps to the Bot ID, and `--private-key` maps to the Secret.
> For interactive setup, simply run `openclaw channels add` and follow the prompts.

5. Restart the Gateway.

Interactive setup paths:

```bash
openclaw channels add
openclaw configure --section channels
```

## Configure

### Minimal config

```json5
{
  channels: {
    wecom: {
      enabled: true,
      botId: "YOUR_BOT_ID",
      secret: "YOUR_SECRET",
    },
  },
}
```

Default-account env vars:

- `WECOM_BOT_ID`
- `WECOM_SECRET`

### DM policy

Control who can interact with the bot:

```json5
{
  channels: {
    wecom: {
      dmPolicy: "open", // "open" | "allowlist" | "pairing" | "disabled"
      allowFrom: ["userid1", "userid2"],
    },
  },
}
```

- `open`: allow all users (default for quick setup)
- `allowlist`: only users in `allowFrom` can interact
- `pairing`: treated the same as `allowlist` (WeCom does not support CLI pairing)
- `disabled`: reject all commands

### Group policy

```json5
{
  channels: {
    wecom: {
      groupPolicy: "open", // "open" | "allowlist" | "disabled"
      groupAllowFrom: ["CHATID1"], // required when groupPolicy is "allowlist"
    },
  },
}
```

### Multi-account setup

Run multiple WeCom bots under a single OpenClaw instance:

```json5
{
  channels: {
    wecom: {
      enabled: true,
      botId: "BOT_1_ID",
      secret: "BOT_1_SECRET",
      accounts: {
        bot2: {
          enabled: true,
          botId: "BOT_2_ID",
          secret: "BOT_2_SECRET",
        },
      },
    },
  },
}
```

Each account launches its own WebSocket connection and maintains an independent
session (isolated by `accountId`).

Add a second bot via CLI:

```bash
openclaw channels add --channel wecom --account bot2 --token "BOT_2_ID" --private-key "BOT_2_SECRET"
```

## Target formats

| Format                | Description |
| --------------------- | ----------- |
| `wecom:direct:USERID` | Direct chat |
| `wecom:group:CHATID`  | Group chat  |

## MCP tool integration

WeCom includes a built-in `wecom_mcp` tool that provides access to WeCom MCP
Server capabilities (documents, contacts, meetings, calendar, etc.):

```
wecom_mcp list <category>
wecom_mcp call <category> <method> '<jsonArgs>'
```

Example:

```
wecom_mcp list contact
wecom_mcp call contact getContact '{}'
```

## Troubleshooting

- **Bot not responding:** verify `botId` and `secret` are correct. Check the
  Gateway logs for `WSAuthFailureError`.
- **"bundled channel entry wecom missing contract" log:** this is expected if
  the channel is not yet loaded. It does not affect functionality.
- **Media not sending:** check that the media URL is accessible and file size
  is within WeCom limits (image: 10MB, voice: 2MB, video: 10MB, file: 20MB).
- **Multi-account MCP routing issues:** pass `accountId` in the `wecom_mcp`
  tool parameters to route to a specific account.
