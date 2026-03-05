---
summary: "Synology Chat webhook setup and OpenClaw config"
read_when:
  - Setting up Synology Chat with OpenClaw
  - Debugging Synology Chat webhook routing
title: "Synology Chat"
---

# Synology Chat (plugin)

Status: supported via plugin as a channel using Synology Chat webhooks.
The plugin supports both **direct messages** (DMs via bot integration) and **group/channel messages**
(via outgoing + incoming webhooks).

## Plugin required

Synology Chat is plugin-based and not part of the default core channel install.

Install from a local checkout:

```bash
openclaw plugins install ./extensions/synology-chat
```

Details: [Plugins](/tools/plugin)

## Quick setup — Direct Messages (DM)

1. Install and enable the Synology Chat plugin.
2. In Synology Chat integrations:
   - Create an incoming webhook and copy its URL.
   - Create an outgoing webhook with your secret token.
3. Point the outgoing webhook URL to your OpenClaw gateway:
   - `https://gateway-host/webhook/synology` by default.
   - Or your custom `channels.synology-chat.webhookPath`.
4. Configure `channels.synology-chat` in OpenClaw.
5. Restart gateway and send a DM to the Synology Chat bot.

Minimal DM config:

```json5
{
  channels: {
    "synology-chat": {
      enabled: true,
      token: "synology-outgoing-token",
      incomingUrl: "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=...",
      webhookPath: "/webhook/synology",
      dmPolicy: "allowlist",
      allowedUserIds: ["123456"],
      rateLimitPerMinute: 30,
      allowInsecureSsl: false,
    },
  },
}
```

## Quick setup — Group/Channel Messages

Group messaging uses a different pair of webhooks per channel (outgoing webhook for receiving, incoming webhook for sending).

1. In Synology Chat, go to a channel's settings:
   - Create an **outgoing webhook** with a trigger word (e.g., `Merlin`) and a secret token.
   - Create an **incoming webhook** and copy its URL.
2. Point the outgoing webhook URL to the same gateway endpoint as DMs.
3. Add the channel's token and webhook URL to your config.
4. Set `groupPolicy` to `"open"` or `"allowlist"`.

Group + DM config:

```json5
{
  channels: {
    "synology-chat": {
      enabled: true,
      // Bot token (for DMs)
      token: "bot-outgoing-token",
      incomingUrl: "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=...",
      // Channel tokens (keyed by channel_id)
      channelTokens: {
        "42": "channel-42-outgoing-token",
        "99": "channel-99-outgoing-token",
      },
      // Channel incoming webhooks (keyed by channel_id)
      channelWebhooks: {
        "42": "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=...",
        "99": "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=...",
      },
      // Group access control
      groupPolicy: "open", // "disabled" | "open" | "allowlist"
      groupAllowFrom: [], // user IDs (when groupPolicy="allowlist")
      // DM access control
      dmPolicy: "allowlist",
      allowedUserIds: ["123456"],
    },
  },
}
```

### How it works

- **Token-based detection**: The bot token identifies DMs. Channel outgoing webhook tokens identify group messages. No heuristics.
- **Session keys**: DMs use `synology-chat-{userId}`, groups use `synology-chat:group:{channelId}`.
- **Reply routing**: DM replies go to the bot's incoming webhook with `user_ids`. Group replies go to the channel's incoming webhook (no user targeting).
- **Trigger words**: Required for channels — Synology Chat only fires outgoing webhooks on trigger word matches.

## Environment variables

For the default account, you can use env vars:

- `SYNOLOGY_CHAT_TOKEN` — Bot outgoing webhook token
- `SYNOLOGY_CHAT_INCOMING_URL` — Bot incoming webhook URL
- `SYNOLOGY_NAS_HOST`
- `SYNOLOGY_ALLOWED_USER_IDS` (comma-separated)
- `SYNOLOGY_RATE_LIMIT`
- `OPENCLAW_BOT_NAME`

For channels, use per-channel env vars:

- `SYNOLOGY_CHANNEL_TOKEN_<channelId>` — Channel outgoing webhook token
- `SYNOLOGY_CHANNEL_WEBHOOK_<channelId>` — Channel incoming webhook URL

Config values override env vars.

## DM policy and access control

- `dmPolicy: "allowlist"` is the recommended default.
- `allowedUserIds` accepts a list (or comma-separated string) of Synology user IDs.
- In `allowlist` mode, an empty `allowedUserIds` list is treated as misconfiguration and the webhook route will not start (use `dmPolicy: "open"` for allow-all).
- `dmPolicy: "open"` allows any sender.
- `dmPolicy: "disabled"` blocks DMs.
- Pairing approvals work with:
  - `openclaw pairing list synology-chat`
  - `openclaw pairing approve synology-chat <CODE>`

## Group access control

- `groupPolicy: "disabled"` (default) blocks all group messages.
- `groupPolicy: "open"` allows any user in configured channels.
- `groupPolicy: "allowlist"` restricts to users listed in `groupAllowFrom`.

## Outbound delivery

Use numeric Synology Chat user IDs as targets.

Examples:

```bash
openclaw message send --channel synology-chat --target 123456 --text "Hello from OpenClaw"
openclaw message send --channel synology-chat --target synology-chat:123456 --text "Hello again"
```

Media sends are supported by URL-based file delivery.

## Multi-account

Multiple Synology Chat accounts are supported under `channels.synology-chat.accounts`.
Each account can override token, incoming URL, webhook path, DM policy, group config, and limits.

```json5
{
  channels: {
    "synology-chat": {
      enabled: true,
      accounts: {
        default: {
          token: "token-a",
          incomingUrl: "https://nas-a.example.com/...token=...",
        },
        alerts: {
          token: "token-b",
          incomingUrl: "https://nas-b.example.com/...token=...",
          webhookPath: "/webhook/synology-alerts",
          dmPolicy: "allowlist",
          allowedUserIds: ["987654"],
        },
      },
    },
  },
}
```

## Security notes

- Keep `token` secret and rotate it if leaked.
- Keep `allowInsecureSsl: false` unless you explicitly trust a self-signed local NAS cert.
- Inbound webhook requests are token-verified and rate-limited per sender.
- Prefer `dmPolicy: "allowlist"` for production.
- Group messages are disabled by default (`groupPolicy: "disabled"`).

## Troubleshooting

### Channel messages not working

1. Verify the channel's outgoing webhook URL points to your gateway.
2. Check that `channelTokens` contains the correct channel ID and token.
3. Check that `channelWebhooks` has a matching incoming webhook URL for replies.
4. Ensure `groupPolicy` is not `"disabled"`.
5. Check gateway logs for token validation errors.

### Bot replies in wrong place

- DM replies use the bot's `incomingUrl` with `user_ids`.
- Channel replies use the channel-specific URL in `channelWebhooks`.
- If `channelWebhooks` is missing for a channel, replies are silently dropped (check logs for warnings).
