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
- Share the same `main` session used by WhatsApp/Telegram/WebChat; guild channels stay isolated as `discord:group:<channelId>`.
- Group DMs are treated as group sessions (separate from `main`) and show up with a `discord:g-...` display label.
- Keep routing deterministic: replies always go back to the surface they arrived on.

## How it works
1. Create a Discord application → Bot, enable the intents you need (DMs + guild messages + message content), and grab the bot token.
2. Invite the bot to your server with the permissions required to read/send messages where you want to use it.
3. Configure Clawdis with `DISCORD_BOT_TOKEN` (or `discord.token` in `~/.clawdis/clawdis.json`).
4. Run the gateway; it auto-starts the Discord provider when the token is set (unless `discord.enabled = false`).
5. Direct chats: use `user:<id>` (or a `<@id>` mention) when delivering; all turns land in the shared `main` session.
6. Guild channels: use `channel:<channelId>` for delivery. Mentions are required by default; disable with `discord.guild.requireMention = false` (legacy: `discord.requireMention`).
7. Optional DM control: set `discord.dm.enabled = false` to ignore all DMs, or `discord.dm.allowFrom` to allow specific users (ids or names). Legacy: `discord.allowFrom`.
8. Optional guild allowlist: set `discord.guild.allowFrom` with `guilds` and/or `users` (ids or names) to gate who can invoke the bot in servers. Legacy: `discord.guildAllowFrom`.
9. Optional guild channel allowlist: set `discord.guild.channels` with channel ids or names to restrict where the bot listens.
10. Optional guild context history: set `discord.guild.historyLimit` (default 20) to include the last N guild messages as context when replying to a mention. Set `0` to disable (legacy: `discord.historyLimit`).
11. Reactions (default on): set `discord.enableReactions = false` to disable agent-triggered reactions via the `clawdis_discord` tool.

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
    enabled: true,
    token: "abc.123",
    mediaMaxMb: 8,
    enableReactions: true,
    dm: {
      enabled: true,
      allowFrom: ["123456789012345678", "steipete"]
    },
    guild: {
      channels: ["general", "help"],
      allowFrom: {
        guilds: ["123456789012345678", "My Server"],
        users: ["987654321098765432", "steipete"]
      },
      requireMention: true,
      historyLimit: 20
    }
  }
}
```

- `dm.enabled`: set `false` to ignore all DMs (default `true`).
- `dm.allowFrom`: DM allowlist (user ids or names). Omit or set to `["*"]` to allow any DM sender.
- `guild.allowFrom`: Optional allowlist for guild messages. Set `guilds` and/or `users` (ids or names). When both are set, both must match.
- `guild.channels`: Optional allowlist for channel ids or names.
- `guild.requireMention`: when `true`, messages in guild channels must mention the bot.
- `mediaMaxMb`: clamp inbound media saved to disk.
- `guild.historyLimit`: number of recent guild messages to include as context when replying to a mention (default 20, `0` disables).
- `enableReactions`: allow agent-triggered reactions via the `clawdis_discord` tool (default `true`).

## Reactions
When `discord.enableReactions = true`, the agent can call `clawdis_discord` with:
- `action: "react"`
- `channelId`, `messageId`, `emoji`

Discord message ids are surfaced in the injected context (`[discord message id: …]` and history lines) so the agent can target them.

## Safety & ops
- Treat the bot token like a password; prefer the `DISCORD_BOT_TOKEN` env var on supervised hosts or lock down the config file permissions.
- Only grant the bot permissions it needs (typically Read/Send Messages).
- If the bot is stuck or rate limited, restart the gateway (`clawdis gateway --force`) after confirming no other processes own the Discord session.
