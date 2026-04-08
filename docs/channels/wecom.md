---
summary: "WeCom setup, config, and usage"
read_when:
  - You want to connect OpenClaw to WeCom (企业微信)
  - You need WeCom Bot credential setup
  - You want WeCom Bot, Agent, or Webhook mode support
title: WeCom
---

# WeCom (企业微信)

WeCom connects to OpenClaw via three connection modes:

- **Bot WebSocket** (primary): real-time bidirectional messaging via the official WeCom Bot API
- **Agent HTTP API** (fallback): automatic fallback when Bot WS is unavailable, using a self-built app's HTTP API
- **Webhook** (passive): HTTP callback endpoint for custom app integration

The plugin supports direct messages, group chats, media (images, voice, video,
files), template card messages, and MCP tool integration.

Status: bundled plugin. Direct messages, group chats, and media are supported.

## Bundled plugin

Current OpenClaw releases bundle WeCom, so normal packaged builds do not need
a separate `openclaw plugins install` step.

## Setup

### Bot mode (recommended)

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

### Agent mode (self-built app)

Agent mode uses a WeCom self-built application (自建应用) for HTTP-based
messaging. It serves as an automatic fallback when Bot WebSocket is unavailable.

1. Go to the [WeCom Admin Console](https://work.weixin.qq.com/wework_admin/frame#/apps)
   → **App Management** → **Create App**.
2. Note the **CorpID** (from the enterprise info page), **AgentID**, and **CorpSecret**.
3. Under **Receive Messages**, set the callback URL and note the **Token** and **EncodingAESKey**.
4. Configure in `openclaw.json5`:

```json5
{
  channels: {
    wecom: {
      enabled: true,
      agent: {
        corpId: "YOUR_CORP_ID",
        corpSecret: "YOUR_CORP_SECRET",
        agentId: 1000002,
        token: "YOUR_CALLBACK_TOKEN",
        encodingAESKey: "YOUR_ENCODING_AES_KEY",
      },
    },
  },
}
```

### Webhook mode

Webhook mode provides a passive HTTP callback endpoint. WeCom pushes encrypted
messages to OpenClaw, which decrypts and processes them.

1. Create a self-built app (same as Agent mode steps 1–3).
2. Configure:

```json5
{
  channels: {
    wecom: {
      enabled: true,
      token: "YOUR_CALLBACK_TOKEN",
      encodingAESKey: "YOUR_ENCODING_AES_KEY",
      receiveId: "YOUR_CORP_ID",
    },
  },
}
```

3. Set the callback URL in WeCom Admin Console to
   `https://YOUR_HOST/api/wecom/webhook/BOT_ACCOUNT_ID`.

## Configure

### Minimal config (Bot mode)

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
- **Agent fallback not working:** ensure `agent.corpId`, `agent.corpSecret`,
  `agent.token`, and `agent.encodingAESKey` are all configured.
- **Webhook messages not arriving:** verify the callback URL is reachable from
  WeCom servers and the `token` + `encodingAESKey` match.
- **"bundled channel entry wecom missing contract" log:** this is expected if
  the channel is not yet loaded. It does not affect functionality.
- **Media not sending:** check that the media URL is accessible and file size
  is within WeCom limits (image: 10MB, voice: 2MB, video: 10MB, file: 20MB).
- **Multi-account MCP routing issues:** pass `accountId` in the `wecom_mcp`
  tool parameters to route to a specific account.
