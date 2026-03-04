---
summary: "Mattermost bot setup and OpenClaw config"
read_when:
  - Setting up Mattermost
  - Debugging Mattermost routing
title: "Mattermost"
---

# Mattermost (plugin)

Status: supported via plugin (bot token + WebSocket events). Channels, groups, and DMs are supported.
Mattermost is a self-hostable team messaging platform; see the official site at
[mattermost.com](https://mattermost.com) for product details and downloads.

## Plugin required

Mattermost ships as a plugin and is not bundled with the core install.

Install via CLI (npm registry):

```bash
openclaw plugins install @openclaw/mattermost
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./extensions/mattermost
```

If you choose Mattermost during configure/onboarding and a git checkout is detected,
OpenClaw will offer the local install path automatically.

Details: [Plugins](/tools/plugin)

## Quick setup

1. Install the Mattermost plugin.
2. Create a Mattermost bot account and copy the **bot token**.
3. Copy the Mattermost **base URL** (e.g., `https://chat.example.com`).
4. Configure OpenClaw and start the gateway.

Minimal config:

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

## Native slash commands

Native slash commands are opt-in. When enabled, OpenClaw registers `oc_*` slash commands via
the Mattermost API and receives callback POSTs on the gateway HTTP server.

```json5
{
  channels: {
    mattermost: {
      commands: {
        native: true,
        nativeSkills: true,
        callbackPath: "/api/channels/mattermost/command",
        // Use when Mattermost cannot reach the gateway directly (reverse proxy/public URL).
        callbackUrl: "https://gateway.example.com/api/channels/mattermost/command",
      },
    },
  },
}
```

Notes:

- `native: "auto"` defaults to disabled for Mattermost. Set `native: true` to enable.
- If `callbackUrl` is omitted, OpenClaw derives one from gateway host/port + `callbackPath`.
- For multi-account setups, `commands` can be set at the top level or under
  `channels.mattermost.accounts.<id>.commands` (account values override top-level fields).
- Command callbacks are validated with per-command tokens and fail closed when token checks fail.
- Reachability requirement: the callback endpoint must be reachable from the Mattermost server.
  - Do not set `callbackUrl` to `localhost` unless Mattermost runs on the same host/network namespace as OpenClaw.
  - Do not set `callbackUrl` to your Mattermost base URL unless that URL reverse-proxies `/api/channels/mattermost/command` to OpenClaw.
  - A quick check is `curl https://<gateway-host>/api/channels/mattermost/command`; a GET should return `405 Method Not Allowed` from OpenClaw, not `404`.
- Mattermost egress allowlist requirement:
  - If your callback targets private/tailnet/internal addresses, set Mattermost
    `ServiceSettings.AllowedUntrustedInternalConnections` to include the callback host/domain.
  - Use host/domain entries, not full URLs.
    - Good: `gateway.tailnet-name.ts.net`
    - Bad: `https://gateway.tailnet-name.ts.net`

## Environment variables (default account)

Set these on the gateway host if you prefer env vars:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

Env vars apply only to the **default** account (`default`). Other accounts must use config values.

## Chat modes

Mattermost responds to DMs automatically. Channel behavior is controlled by `chatmode`:

- `oncall` (default): respond only when @mentioned in channels.
- `onmessage`: respond to every channel message.
- `always`: same delivery intent as `onmessage` (always eligible in channels).
- `onchar`: respond when a message starts with a trigger prefix.

Config example:

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"],
    },
  },
}
```

Notes:

- `onchar` still responds to explicit @mentions.
- `channels.mattermost.requireMention` is honored for legacy configs but `chatmode` is preferred.
- Current runtime behavior: for `onmessage`/`always`, set `groups."*".requireMention=false` to disable mention gating for channel replies.

```json5
{
  channels: {
    mattermost: {
      chatmode: "onmessage",
      groupPolicy: "open",
      groups: {
        "*": { requireMention: false },
      },
    },
  },
}
```

## Access control (DMs)

- Default: `channels.mattermost.dmPolicy = "pairing"` (unknown senders get a pairing code).
- Approve via:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- Public DMs: `channels.mattermost.dmPolicy="open"` plus `channels.mattermost.allowFrom=["*"]`.

## Channels (groups)

- Default: `channels.mattermost.groupPolicy = "allowlist"` (mention-gated).
- Allowlist senders with `channels.mattermost.groupAllowFrom` (user IDs recommended).
- `@username` matching is mutable and only enabled when `channels.mattermost.dangerouslyAllowNameMatching: true`.
- Open channels: `channels.mattermost.groupPolicy="open"` (mention-gated).
- Runtime note: if `channels.mattermost` is completely missing, runtime falls back to `groupPolicy="allowlist"` for group checks (even if `channels.defaults.groupPolicy` is set).

## Targets for outbound delivery

Use these target formats with `openclaw message send` or cron/webhooks:

- `channel:<id>` for a channel
- `user:<id>` for a DM
- `@username` for a DM (resolved via the Mattermost API)

Bare IDs are treated as channels.

## Reactions (message tool)

- Use `message action=react` with `channel=mattermost`.
- `messageId` is the Mattermost post id.
- `emoji` accepts names like `thumbsup` or `:+1:` (colons are optional).
- Set `remove=true` (boolean) to remove a reaction.
- Reaction add/remove events are forwarded as system events to the routed agent session.

Examples:

```
message action=react channel=mattermost target=channel:<channelId> messageId=<postId> emoji=thumbsup
message action=react channel=mattermost target=channel:<channelId> messageId=<postId> emoji=thumbsup remove=true
```

Config:

- `channels.mattermost.actions.reactions`: enable/disable reaction actions (default true).
- Per-account override: `channels.mattermost.accounts.<id>.actions.reactions`.

## Multi-account

Mattermost supports multiple accounts under `channels.mattermost.accounts`:

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## Troubleshooting

- No replies in channels: ensure the bot is in the channel and mention it (oncall), use a trigger prefix (onchar), or for `onmessage`/`always` also set `groups."*".requireMention=false`.
- Auth errors: check the bot token, base URL, and whether the account is enabled.
- Multi-account issues: env vars only apply to the `default` account.
