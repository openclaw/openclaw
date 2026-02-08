---
summary: "Zulip bot setup and OpenClaw config"
read_when:
  - Setting up Zulip
  - Debugging Zulip routing
title: "Zulip"
---

# Zulip (plugin)

Status: supported via plugin (bot API + events). Streams, topics (threads), and DMs are supported.

Capabilities:

- Threads: **true** (Zulip topics)
- Reactions: **true** (👀 ack)
- Media: **false**

## Plugin required

Zulip ships as a plugin and is not bundled with the core install.

Install via CLI (npm registry):

```bash
openclaw plugins install @openclaw/zulip
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./extensions/zulip
```

Details: [Plugins](/plugin)

## Quick setup

You need:

- Zulip **realm/site URL** (e.g. `https://zulip.example.com`)
- Bot **email**
- Bot **API key** (from Zulip settings)

Minimal config:

```json5
{
  channels: {
    zulip: {
      enabled: true,
      realm: "https://zulip.example.com", // or site
      email: "bot@example.com",
      apiKey: "zulip-api-key",

      // DM security (recommended default)
      dmPolicy: "pairing",

      // Streams are mention-gated by default
      groupPolicy: "allowlist",
    },
  },
}
```

## Environment variables (default account)

If you prefer env vars (apply only to the **default** account):

- `ZULIP_REALM=https://zulip.example.com` (or `ZULIP_SITE=...`)
- `ZULIP_EMAIL=bot@example.com`
- `ZULIP_API_KEY=...`

Example with env substitution:

```json5
{
  channels: {
    zulip: {
      enabled: true,
      realm: "${ZULIP_REALM}",
      email: "${ZULIP_EMAIL}",
      apiKey: "${ZULIP_API_KEY}",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
    },
  },
}
```

## Cloudflare Access / SSO-protected Zulip

If `/api/v1/*` is protected behind Cloudflare Access (or another SSO proxy), the bot may receive HTML instead of JSON.

OpenClaw supports Cloudflare Access **Service Tokens** via environment variables:

- `ZULIP_CF_ACCESS_CLIENT_ID=...`
- `ZULIP_CF_ACCESS_CLIENT_SECRET=...`

Use these when the Zulip API is reachable only through Access and you want to allow the bot without interactive login.

## Access control

### DMs

- Default: `channels.zulip.dmPolicy = "pairing"` (unknown senders get a pairing code).
- Approve via:
  - `openclaw pairing list zulip`
  - `openclaw pairing approve zulip <CODE>`
- Open DMs: `channels.zulip.dmPolicy="open"` plus `channels.zulip.allowFrom=["*"]`.

### Streams (groups)

Streams are **mention-gated** (OpenClaw responds when @mentioned).

- Default: `channels.zulip.groupPolicy = "allowlist"`.
- Allowlist senders with `channels.zulip.groupAllowFrom` (list of Zulip sender emails).
- If `groupAllowFrom` is not set, the plugin falls back to `allowFrom`.

## Targets for outbound delivery

Use these target formats with `openclaw message send` / cron / webhooks:

- `pm:<email>` (DM)
- `stream:<stream>/<topic>`
- `<stream>#<topic>` (shorthand)

Examples:

```bash
openclaw message send --channel zulip --to 'pm:alice@example.com' --text 'hi'
openclaw message send --channel zulip --to 'stream:Engineering/Alerts' --text 'deploy done'
openclaw message send --channel zulip --to 'Engineering#Alerts' --text 'deploy done'
```

## Note: delivery_email vs email

Some Zulip servers redact `email` in the `/api/v1/users` response and expose `delivery_email` instead.

For DMs, OpenClaw resolves recipient emails to numeric `user_id` values by fetching `/api/v1/users` and matching **either** `email` or `delivery_email`.
This avoids sending to a redacted email and ensures private message delivery works reliably.
