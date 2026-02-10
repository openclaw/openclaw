---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Mattermost bot setup and OpenClaw config"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Setting up Mattermost（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging Mattermost routing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Mattermost"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Mattermost (plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Status: supported via plugin (bot token + WebSocket events). Channels, groups, and DMs are supported.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Mattermost is a self-hostable team messaging platform; see the official site at（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[mattermost.com](https://mattermost.com) for product details and downloads.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Plugin required（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Mattermost ships as a plugin and is not bundled with the core install.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install via CLI (npm registry):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install @openclaw/mattermost（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Local checkout (when running from a git repo):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install ./extensions/mattermost（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you choose Mattermost during configure/onboarding and a git checkout is detected,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw will offer the local install path automatically.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Details: [Plugins](/tools/plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Install the Mattermost plugin.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Create a Mattermost bot account and copy the **bot token**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Copy the Mattermost **base URL** (e.g., `https://chat.example.com`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Configure OpenClaw and start the gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Minimal config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mattermost: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      botToken: "mm-token",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      baseUrl: "https://chat.example.com",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dmPolicy: "pairing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Environment variables (default account)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set these on the gateway host if you prefer env vars:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `MATTERMOST_BOT_TOKEN=...`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `MATTERMOST_URL=https://chat.example.com`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Env vars apply only to the **default** account (`default`). Other accounts must use config values.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Chat modes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Mattermost responds to DMs automatically. Channel behavior is controlled by `chatmode`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `oncall` (default): respond only when @mentioned in channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `onmessage`: respond to every channel message.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `onchar`: respond when a message starts with a trigger prefix.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mattermost: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      chatmode: "onchar",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      oncharPrefixes: [">", "!"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `onchar` still responds to explicit @mentions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.mattermost.requireMention` is honored for legacy configs but `chatmode` is preferred.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Access control (DMs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: `channels.mattermost.dmPolicy = "pairing"` (unknown senders get a pairing code).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Approve via:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw pairing list mattermost`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw pairing approve mattermost <CODE>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Public DMs: `channels.mattermost.dmPolicy="open"` plus `channels.mattermost.allowFrom=["*"]`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Channels (groups)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: `channels.mattermost.groupPolicy = "allowlist"` (mention-gated).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Allowlist senders with `channels.mattermost.groupAllowFrom` (user IDs or `@username`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Open channels: `channels.mattermost.groupPolicy="open"` (mention-gated).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Targets for outbound delivery（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use these target formats with `openclaw message send` or cron/webhooks:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channel:<id>` for a channel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `user:<id>` for a DM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `@username` for a DM (resolved via the Mattermost API)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bare IDs are treated as channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Multi-account（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Mattermost supports multiple accounts under `channels.mattermost.accounts`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mattermost: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No replies in channels: ensure the bot is in the channel and mention it (oncall), use a trigger prefix (onchar), or set `chatmode: "onmessage"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth errors: check the bot token, base URL, and whether the account is enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multi-account issues: env vars only apply to the `default` account.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
