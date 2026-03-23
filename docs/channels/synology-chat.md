---
summary: "Synology Chat webhook setup and OpenClaw config"
read_when:
  - Setting up Synology Chat with OpenClaw
  - Debugging Synology Chat webhook routing
title: "Synology Chat"
---

# Synology Chat (plugin)

Status: supported via plugin as a direct-message channel using Synology Chat webhooks.
The plugin accepts inbound messages from Synology Chat outgoing webhooks and sends replies
through a Synology Chat incoming webhook.

## Plugin required

Synology Chat is plugin-based and not part of the default core channel install.

Install from a local checkout:

```bash
openclaw plugins install ./extensions/synology-chat
```

Details: [Plugins](/tools/plugin)

## Quick setup

1. Install and enable the Synology Chat plugin.
   - `openclaw onboard` now shows Synology Chat in the same channel setup list as `openclaw channels add`.
   - Non-interactive setup: `openclaw channels add --channel synology-chat --token <token> --url <incoming-webhook-url>`
2. In Synology Chat integrations:
   - Create an incoming webhook and copy its URL.
   - Create an outgoing webhook with your secret token.
3. Point the outgoing webhook URL to your OpenClaw gateway:
   - `https://gateway-host/webhook/synology` by default.
   - Or your custom `channels.synology-chat.webhookPath`.
4. Finish setup in OpenClaw.
   - Guided: `openclaw onboard`
   - Direct: `openclaw channels add --channel synology-chat --token <token> --url <incoming-webhook-url>`
5. Restart gateway and send a DM to the Synology Chat bot.

Minimal config:

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

## Environment variables

For the default account, you can use env vars:

- `SYNOLOGY_CHAT_TOKEN`
- `SYNOLOGY_CHAT_INCOMING_URL`
- `SYNOLOGY_NAS_HOST`
- `SYNOLOGY_ALLOWED_USER_IDS` (comma-separated)
- `SYNOLOGY_RATE_LIMIT`
- `OPENCLAW_BOT_NAME`

Config values override env vars.

## DM policy and access control

- `dmPolicy: "allowlist"` is the recommended default.
- `allowedUserIds` accepts a list (or comma-separated string) of Synology user IDs.
- In `allowlist` mode, an empty `allowedUserIds` list is treated as misconfiguration and the webhook route will not start (use `dmPolicy: "open"` for allow-all).
- `dmPolicy: "open"` allows any sender.
- `dmPolicy: "disabled"` blocks DMs.
- Reply recipient binding stays on stable numeric `user_id` by default. `channels.synology-chat.dangerouslyAllowNameMatching: true` is break-glass compatibility mode that re-enables mutable username/nickname lookup for reply delivery.
- Pairing approvals work with:
  - `openclaw pairing list synology-chat`
  - `openclaw pairing approve synology-chat <CODE>`

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
Each account can override token, incoming URL, webhook path, DM policy, and limits.
Direct-message sessions are isolated per account and user, so the same numeric `user_id`
on two different Synology accounts does not share transcript state.

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
- Keep `dangerouslyAllowNameMatching` off unless you explicitly need legacy username-based reply delivery.
