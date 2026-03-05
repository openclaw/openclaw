---
summary: "Pumble bot setup and OpenClaw config"
read_when:
  - Setting up Pumble
  - Debugging Pumble routing
title: "Pumble"
---

# Pumble (plugin)

Status: supported via plugin (bot token + WebSocket events). Channels, groups, and DMs are supported.
Pumble is a Slack-style team messaging platform by CAKE.com; see the official site at
[pumble.com](https://pumble.com) for product details.

## Plugin required

Pumble ships as a plugin and is not bundled with the core install.

Install via CLI (npm registry):

```bash
openclaw plugins install @openclaw/pumble
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./extensions/pumble
```

If you choose Pumble during configure/onboarding and a git checkout is detected,
OpenClaw will offer the local install path automatically.

Details: [Plugins](/tools/plugin)

## Quick setup

1. Install the Pumble plugin.
2. Create a Pumble app in the [Pumble developer console](https://pumble.com/help/integrations/add-pumble-apps/guide-to-pumble-integrations/).
3. Copy the four app credentials: **App ID**, **App Key**, **Client Secret**, **Signing Secret**.
4. Install the app into your workspace and copy the **Bot Token**.
5. Configure OpenClaw and start the gateway.

Minimal config (WebSocket mode — all five credentials):

```json5
{
  channels: {
    pumble: {
      enabled: true,
      appId: "your-app-id",
      appKey: "your-app-key",
      clientSecret: "your-client-secret",
      signingSecret: "your-signing-secret",
      botToken: "your-bot-token",
      dmPolicy: "pairing",
    },
  },
}
```

REST-only config (outbound sends only, no real-time inbound):

```json5
{
  channels: {
    pumble: {
      enabled: true,
      botToken: "your-bot-token",
      dmPolicy: "pairing",
    },
  },
}
```

<Note>
WebSocket mode requires all four SDK credentials (`appId`, `appKey`, `clientSecret`, `signingSecret`) plus `botToken`. Without the SDK credentials, the monitor starts in REST-only mode (outbound sends work, but inbound messages are not received in real-time).
</Note>

## Environment variables (default account)

Set these on the gateway host if you prefer env vars:

- `PUMBLE_APP_ID=...`
- `PUMBLE_APP_KEY=...`
- `PUMBLE_APP_CLIENT_SECRET=...`
- `PUMBLE_APP_SIGNING_SECRET=...`
- `PUMBLE_BOT_TOKEN=...`

Env vars apply only to the **default** account (`default`). Other accounts must use config values.

## Access control (DMs)

- Default: `channels.pumble.dmPolicy = "pairing"` (unknown senders get a pairing code).
- Approve via:
  - `openclaw pairing list pumble`
  - `openclaw pairing approve pumble <CODE>`
- Public DMs: `channels.pumble.dmPolicy="open"` plus `channels.pumble.allowFrom=["*"]`.

## Channels (groups)

- Default: `channels.pumble.groupPolicy = "allowlist"` (mention-gated).
- Allowlist senders with `channels.pumble.groupAllowFrom` (user IDs).
- Open channels: `channels.pumble.groupPolicy="open"` (mention-gated).
- Channel allowlist: `channels.pumble.channelAllowlist` restricts which channels the bot listens to (empty = all channels).

## Mentions

Channel messages are mention-gated by default (`requireMention: true`).

Configure mention patterns via `messages.groupChat.mentionPatterns` or per-agent `agents.list[].groupChat.mentionPatterns`.

Per-account override: `channels.pumble.accounts.<id>.requireMention`.

## Targets for outbound delivery

Use these target formats with `openclaw message send` or cron/webhooks:

- `channel:<id>` for a channel message
- `user:<id>` for a DM
- `pumble:<id>` for a DM (alias)
- `#<name>` for a channel by name

Bare IDs are treated as channels.

## Threading

Thread replies are supported. Inbound messages with a thread root ID are routed to thread-scoped sessions. Outbound replies are sent as thread replies when the inbound message was in a thread.

## Multi-account

Pumble supports multiple accounts under `channels.pumble.accounts`:

```json5
{
  channels: {
    pumble: {
      accounts: {
        default: {
          name: "Primary",
          appId: "app-1",
          appKey: "key-1",
          clientSecret: "secret-1",
          signingSecret: "sig-1",
          botToken: "token-1",
        },
        alerts: {
          name: "Alerts",
          appId: "app-2",
          appKey: "key-2",
          clientSecret: "secret-2",
          signingSecret: "sig-2",
          botToken: "token-2",
        },
      },
    },
  },
}
```

## Webhook port

The Pumble plugin starts a local HTTP server for receiving webhook events. The default port is **5111**.

Override per-account with `channels.pumble.webhookPort` (or `channels.pumble.accounts.<id>.webhookPort`):

```json5
{
  channels: {
    pumble: {
      webhookPort: 5200,
    },
  },
}
```

If you provide a `webhookUrl` (static public URL, e.g. via ngrok or Cloudflare Tunnel), the local HTTP server still binds to `webhookPort` but the tunnel is skipped.

## Troubleshooting

- **No inbound messages**: ensure all four SDK credentials are configured (`appId`, `appKey`, `clientSecret`, `signingSecret`). Without them the monitor runs in REST-only mode and cannot receive messages. Check logs for `pumble: SDK credentials missing, running in REST-only mode`.
- **Auth errors**: verify the bot token is valid with `openclaw channels status --probe`.
- **No replies in channels**: check `groupPolicy`, `channelAllowlist`, and `requireMention` settings.
- **DM messages ignored**: check `dmPolicy` and pairing approvals (`openclaw pairing list pumble`).
- **Multi-account issues**: env vars only apply to the `default` account.

## Related

- [Pairing](/channels/pairing)
- [Channel routing](/channels/channel-routing)
- [Groups](/channels/groups)
- [Troubleshooting](/channels/troubleshooting)
