---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Zalo bot support status, capabilities, and configuration"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Working on Zalo features or webhooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Zalo"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Zalo (Bot API)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Status: experimental. Direct messages only; groups coming soon per Zalo docs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Plugin required（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Zalo ships as a plugin and is not bundled with the core install.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install via CLI: `openclaw plugins install @openclaw/zalo`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Or select **Zalo** during onboarding and confirm the install prompt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Details: [Plugins](/tools/plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick setup (beginner)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Install the Zalo plugin:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - From a source checkout: `openclaw plugins install ./extensions/zalo`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - From npm (if published): `openclaw plugins install @openclaw/zalo`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Or pick **Zalo** in onboarding and confirm the install prompt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Set the token:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Env: `ZALO_BOT_TOKEN=...`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Or config: `channels.zalo.botToken: "..."`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Restart the gateway (or finish onboarding).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. DM access is pairing by default; approve the pairing code on first contact.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Minimal config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    zalo: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      botToken: "12345689:abc-xyz",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dmPolicy: "pairing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What it is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Zalo is a Vietnam-focused messaging app; its Bot API lets the Gateway run a bot for 1:1 conversations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It is a good fit for support or notifications where you want deterministic routing back to Zalo.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A Zalo Bot API channel owned by the Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Deterministic routing: replies go back to Zalo; the model never chooses channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DMs share the agent's main session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Groups are not yet supported (Zalo docs state "coming soon").（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Setup (fast path)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1) Create a bot token (Zalo Bot Platform)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Go to [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) and sign in.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Create a new bot and configure its settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Copy the bot token (format: `12345689:abc-xyz`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2) Configure the token (env or config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    zalo: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      botToken: "12345689:abc-xyz",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dmPolicy: "pairing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Env option: `ZALO_BOT_TOKEN=...` (works for the default account only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multi-account support: use `channels.zalo.accounts` with per-account tokens and optional `name`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Restart the gateway. Zalo starts when a token is resolved (env or config).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. DM access defaults to pairing. Approve the code when the bot is first contacted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How it works (behavior)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Inbound messages are normalized into the shared channel envelope with media placeholders.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Replies always route back to the same Zalo chat.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Long-polling by default; webhook mode available with `channels.zalo.webhookUrl`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Outbound text is chunked to 2000 characters (Zalo API limit).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media downloads/uploads are capped by `channels.zalo.mediaMaxMb` (default 5).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Streaming is blocked by default due to the 2000 char limit making streaming less useful.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Access control (DMs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### DM access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: `channels.zalo.dmPolicy = "pairing"`. Unknown senders receive a pairing code; messages are ignored until approved (codes expire after 1 hour).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Approve via:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw pairing list zalo`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw pairing approve zalo <CODE>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pairing is the default token exchange. Details: [Pairing](/channels/pairing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.allowFrom` accepts numeric user IDs (no username lookup available).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Long-polling vs webhook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: long-polling (no public URL required).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Webhook mode: set `channels.zalo.webhookUrl` and `channels.zalo.webhookSecret`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - The webhook secret must be 8-256 characters.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Webhook URL must use HTTPS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Zalo sends events with `X-Bot-Api-Secret-Token` header for verification.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Gateway HTTP handles webhook requests at `channels.zalo.webhookPath` (defaults to the webhook URL path).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Note:** getUpdates (polling) and webhook are mutually exclusive per Zalo API docs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Supported message types（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Text messages**: Full support with 2000 character chunking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Image messages**: Download and process inbound images; send images via `sendPhoto`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Stickers**: Logged but not fully processed (no agent response).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Unsupported types**: Logged (e.g., messages from protected users).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Capabilities（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Feature         | Status                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------------- | ------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Direct messages | ✅ Supported                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Groups          | ❌ Coming soon (per Zalo docs) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Media (images)  | ✅ Supported                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Reactions       | ❌ Not supported               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Threads         | ❌ Not supported               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Polls           | ❌ Not supported               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Native commands | ❌ Not supported               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Streaming       | ⚠️ Blocked (2000 char limit)   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Delivery targets (CLI/cron)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use a chat id as the target.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example: `openclaw message send --channel zalo --target 123456789 --message "hi"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Bot doesn't respond:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check that the token is valid: `openclaw channels status --probe`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Verify the sender is approved (pairing or allowFrom)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check gateway logs: `openclaw logs --follow`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Webhook not receiving events:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ensure webhook URL uses HTTPS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Verify secret token is 8-256 characters（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Confirm the gateway HTTP endpoint is reachable on the configured path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check that getUpdates polling is not running (they're mutually exclusive)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration reference (Zalo)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full configuration: [Configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Provider options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.enabled`: enable/disable channel startup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.botToken`: bot token from Zalo Bot Platform.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.tokenFile`: read token from file path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.allowFrom`: DM allowlist (user IDs). `open` requires `"*"`. The wizard will ask for numeric IDs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.mediaMaxMb`: inbound/outbound media cap (MB, default 5).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.webhookUrl`: enable webhook mode (HTTPS required).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.webhookSecret`: webhook secret (8-256 chars).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.webhookPath`: webhook path on the gateway HTTP server.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.proxy`: proxy URL for API requests.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multi-account options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.accounts.<id>.botToken`: per-account token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.accounts.<id>.tokenFile`: per-account token file.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.accounts.<id>.name`: display name.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.accounts.<id>.enabled`: enable/disable account.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.accounts.<id>.dmPolicy`: per-account DM policy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.accounts.<id>.allowFrom`: per-account allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.accounts.<id>.webhookUrl`: per-account webhook URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.accounts.<id>.webhookSecret`: per-account webhook secret.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.accounts.<id>.webhookPath`: per-account webhook path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.zalo.accounts.<id>.proxy`: per-account proxy URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
