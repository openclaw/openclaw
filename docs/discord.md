---
summary: "Discord bot support status, capabilities, and configuration"
read_when:
  - Working on Discord surface features
---
# Discord (Bot API)

Updated: 2025-12-07

Status: ready for DM and guild text channels via the official Discord bot gateway.

## Goals
- Talk to Clawdis via Discord DMs or guild channels.
- Share the same `main` session used by WhatsApp/Telegram/WebChat; guild channels stay isolated as `group:<channelId>`.
- Keep routing deterministic: replies always go back to the surface they arrived on.

## How it works
1. Create a Discord application → Bot, enable the intents you need (DMs + guild messages + message content), and grab the bot token.
2. Invite the bot to your server with the permissions required to read/send messages where you want to use it.
3. Configure Clawdis with `DISCORD_BOT_TOKEN` (or `discord.token` in `~/.clawdis/clawdis.json`).
4. Run the gateway; it auto-starts the Discord provider when the token is set.
5. Direct chats: use `user:<id>` (or a `<@id>` mention) when delivering; all turns land in the shared `main` session.
6. Guild channels: use `channel:<channelId>` for delivery. Mentions are required by default; disable with `discord.requireMention = false`.
7. Optional DM allowlist: reuse `discord.allowFrom` with user ids (`1234567890` or `discord:1234567890`). Use `"*"` to allow all DMs.
8. Optional guild allowlist: set `discord.guildAllowFrom` with `guilds` and/or `users` to gate who can invoke the bot in servers.

Note: Discord does not provide a simple username → id lookup without extra guild context, so prefer ids or `<@id>` mentions for DM delivery targets.

## Capabilities & limits
- DMs and guild text channels (threads are treated as separate channels; voice not supported).
- Typing indicators sent best-effort; message chunking honors Discord’s 2k character limit.
- File uploads supported up to the configured `discord.mediaMaxMb` (default 8 MB).
- Mention-gated guild replies by default to avoid noisy bots.

## Config

```json5
{
  discord: {
    token: "abc.123",
    allowFrom: ["123456789012345678"],
    guildAllowFrom: {
      guilds: ["123456789012345678"],
      users: ["987654321098765432"]
    },
    requireMention: true,
    mediaMaxMb: 8
  }
}
```

- `allowFrom`: DM allowlist (user ids). Omit or set to `["*"]` to allow any DM sender.
- `guildAllowFrom`: Optional allowlist for guild messages. Set `guilds` and/or `users` (ids). When both are set, both must match.
- `requireMention`: when `true`, messages in guild channels must mention the bot.
- `mediaMaxMb`: clamp inbound media saved to disk.

## Safety & ops
- Treat the bot token like a password; prefer the `DISCORD_BOT_TOKEN` env var on supervised hosts or lock down the config file permissions.
- Only grant the bot permissions it needs (typically Read/Send Messages).
- If the bot is stuck or rate limited, restart the gateway (`clawdis gateway --force`) after confirming no other processes own the Discord session.
