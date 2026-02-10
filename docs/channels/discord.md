---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Discord bot support status, capabilities, and configuration"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Working on Discord channel features（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Discord"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Discord (Bot API)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Status: ready for DM and guild text channels via the official Discord bot gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick setup (beginner)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create a Discord bot and copy the bot token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. In the Discord app settings, enable **Message Content Intent** (and **Server Members Intent** if you plan to use allowlists or name lookups).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Set the token for OpenClaw:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Env: `DISCORD_BOT_TOKEN=...`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Or config: `channels.discord.token: "..."`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - If both are set, config takes precedence (env fallback is default-account only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Invite the bot to your server with message permissions (create a private server if you just want DMs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Start the gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. DM access is pairing by default; approve the pairing code on first contact.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Minimal config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    discord: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      token: "YOUR_BOT_TOKEN",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Goals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Talk to OpenClaw via Discord DMs or guild channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Direct chats collapse into the agent's main session (default `agent:main:main`); guild channels stay isolated as `agent:<agentId>:discord:channel:<channelId>` (display names use `discord:<guildSlug>#<channelSlug>`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group DMs are ignored by default; enable via `channels.discord.dm.groupEnabled` and optionally restrict by `channels.discord.dm.groupChannels`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep routing deterministic: replies always go back to the channel they arrived on.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How it works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create a Discord application → Bot, enable the intents you need (DMs + guild messages + message content), and grab the bot token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Invite the bot to your server with the permissions required to read/send messages where you want to use it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Configure OpenClaw with `channels.discord.token` (or `DISCORD_BOT_TOKEN` as a fallback).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Run the gateway; it auto-starts the Discord channel when a token is available (config first, env fallback) and `channels.discord.enabled` is not `false`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - If you prefer env vars, set `DISCORD_BOT_TOKEN` (a config block is optional).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Direct chats: use `user:<id>` (or a `<@id>` mention) when delivering; all turns land in the shared `main` session. Bare numeric IDs are ambiguous and rejected.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Guild channels: use `channel:<channelId>` for delivery. Mentions are required by default and can be set per guild or per channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. Direct chats: secure by default via `channels.discord.dm.policy` (default: `"pairing"`). Unknown senders get a pairing code (expires after 1 hour); approve via `openclaw pairing approve discord <code>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - To keep old “open to anyone” behavior: set `channels.discord.dm.policy="open"` and `channels.discord.dm.allowFrom=["*"]`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - To hard-allowlist: set `channels.discord.dm.policy="allowlist"` and list senders in `channels.discord.dm.allowFrom`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - To ignore all DMs: set `channels.discord.dm.enabled=false` or `channels.discord.dm.policy="disabled"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
8. Group DMs are ignored by default; enable via `channels.discord.dm.groupEnabled` and optionally restrict by `channels.discord.dm.groupChannels`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
9. Optional guild rules: set `channels.discord.guilds` keyed by guild id (preferred) or slug, with per-channel rules.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
10. Optional native commands: `commands.native` defaults to `"auto"` (on for Discord/Telegram, off for Slack). Override with `channels.discord.commands.native: true|false|"auto"`; `false` clears previously registered commands. Text commands are controlled by `commands.text` and must be sent as standalone `/...` messages. Use `commands.useAccessGroups: false` to bypass access-group checks for commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Full command list + config: [Slash commands](/tools/slash-commands)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
11. Optional guild context history: set `channels.discord.historyLimit` (default 20, falls back to `messages.groupChat.historyLimit`) to include the last N guild messages as context when replying to a mention. Set `0` to disable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
12. Reactions: the agent can trigger reactions via the `discord` tool (gated by `channels.discord.actions.*`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Reaction removal semantics: see [/tools/reactions](/tools/reactions).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - The `discord` tool is only exposed when the current channel is Discord.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
13. Native commands use isolated session keys (`agent:<agentId>:discord:slash:<userId>`) rather than the shared `main` session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: Name → id resolution uses guild member search and requires Server Members Intent; if the bot can’t search members, use ids or `<@id>` mentions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: Slugs are lowercase with spaces replaced by `-`. Channel names are slugged without the leading `#`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: Guild context `[from:]` lines include `author.tag` + `id` to make ping-ready replies easy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config writes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, Discord is allowed to write config updates triggered by `/config set|unset` (requires `commands.config: true`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Disable with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: { discord: { configWrites: false } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How to create your own bot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is the “Discord Developer Portal” setup for running OpenClaw in a server (guild) channel like `#help`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1) Create the Discord app + bot user（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Discord Developer Portal → **Applications** → **New Application**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. In your app:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **Bot** → **Add Bot**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Copy the **Bot Token** (this is what you put in `DISCORD_BOT_TOKEN`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2) Enable the gateway intents OpenClaw needs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Discord blocks “privileged intents” unless you explicitly enable them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In **Bot** → **Privileged Gateway Intents**, enable:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Message Content Intent** (required to read message text in most guilds; without it you’ll see “Used disallowed intents” or the bot will connect but not react to messages)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Server Members Intent** (recommended; required for some member/user lookups and allowlist matching in guilds)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You usually do **not** need **Presence Intent**. Setting the bot's own presence (`setPresence` action) uses gateway OP3 and does not require this intent; it is only needed if you want to receive presence updates about other guild members.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3) Generate an invite URL (OAuth2 URL Generator)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In your app: **OAuth2** → **URL Generator**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Scopes**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ `bot`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ `applications.commands` (required for native commands)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Bot Permissions** (minimal baseline)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ View Channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ Send Messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ Read Message History（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ Embed Links（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ Attach Files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ Add Reactions (optional but recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ Use External Emojis / Stickers (optional; only if you want them)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Avoid **Administrator** unless you’re debugging and fully trust the bot.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Copy the generated URL, open it, pick your server, and install the bot.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 4) Get the ids (guild/user/channel)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Discord uses numeric ids everywhere; OpenClaw config prefers ids.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Discord (desktop/web) → **User Settings** → **Advanced** → enable **Developer Mode**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Right-click:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Server name → **Copy Server ID** (guild id)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Channel (e.g. `#help`) → **Copy Channel ID**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Your user → **Copy User ID**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 5) Configure OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set the bot token via env var (recommended on servers):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `DISCORD_BOT_TOKEN=...`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Or via config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    discord: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      token: "YOUR_BOT_TOKEN",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multi-account support: use `channels.discord.accounts` with per-account tokens and optional `name`. See [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for the shared pattern.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Allowlist + channel routing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example “single server, only allow me, only allow #help”:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    discord: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dm: { enabled: false },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      guilds: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        YOUR_GUILD_ID: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          users: ["YOUR_USER_ID"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          requireMention: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            help: { allow: true, requireMention: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      retry: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        attempts: 3,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        minDelayMs: 500,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxDelayMs: 30000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        jitter: 0.1,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `requireMention: true` means the bot only replies when mentioned (recommended for shared channels).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list[].groupChat.mentionPatterns` (or `messages.groupChat.mentionPatterns`) also count as mentions for guild messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multi-agent override: set per-agent patterns on `agents.list[].groupChat.mentionPatterns`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `channels` is present, any channel not listed is denied by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use a `"*"` channel entry to apply defaults across all channels; explicit channel entries override the wildcard.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Threads inherit parent channel config (allowlist, `requireMention`, skills, prompts, etc.) unless you add the thread channel id explicitly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Owner hint: when a per-guild or per-channel `users` allowlist matches the sender, OpenClaw treats that sender as the owner in the system prompt. For a global owner across channels, set `commands.ownerAllowFrom`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bot-authored messages are ignored by default; set `channels.discord.allowBots=true` to allow them (own messages remain filtered).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Warning: If you allow replies to other bots (`channels.discord.allowBots=true`), prevent bot-to-bot reply loops with `requireMention`, `channels.discord.guilds.*.channels.<id>.users` allowlists, and/or clear guardrails in `AGENTS.md` and `SOUL.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 6) Verify it works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Start the gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. In your server channel, send: `@Krill hello` (or whatever your bot name is).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. If nothing happens: check **Troubleshooting** below.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- First: run `openclaw doctor` and `openclaw channels status --probe` (actionable warnings + quick audits).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **“Used disallowed intents”**: enable **Message Content Intent** (and likely **Server Members Intent**) in the Developer Portal, then restart the gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Bot connects but never replies in a guild channel**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Missing **Message Content Intent**, or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - The bot lacks channel permissions (View/Send/Read History), or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Your config requires mentions and you didn’t mention it, or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Your guild/channel allowlist denies the channel/user.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`requireMention: false` but still no replies**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.discord.groupPolicy` defaults to **allowlist**; set it to `"open"` or add a guild entry under `channels.discord.guilds` (optionally list channels under `channels.discord.guilds.<id>.channels` to restrict).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If you only set `DISCORD_BOT_TOKEN` and never create a `channels.discord` section, the runtime（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults `groupPolicy` to `open`. Add `channels.discord.groupPolicy`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    `channels.defaults.groupPolicy`, or a guild/channel allowlist to lock it down.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `requireMention` must live under `channels.discord.guilds` (or a specific channel). `channels.discord.requireMention` at the top level is ignored.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Permission audits** (`channels status --probe`) only check numeric channel IDs. If you use slugs/names as `channels.discord.guilds.*.channels` keys, the audit can’t verify permissions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **DMs don’t work**: `channels.discord.dm.enabled=false`, `channels.discord.dm.policy="disabled"`, or you haven’t been approved yet (`channels.discord.dm.policy="pairing"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Exec approvals in Discord**: Discord supports a **button UI** for exec approvals in DMs (Allow once / Always allow / Deny). `/approve <id> ...` is only for forwarded approvals and won’t resolve Discord’s button prompts. If you see `❌ Failed to submit approval: Error: unknown approval id` or the UI never shows up, check:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `channels.discord.execApprovals.enabled: true` in your config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Your Discord user ID is listed in `channels.discord.execApprovals.approvers` (the UI is only sent to approvers).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Use the buttons in the DM prompt (**Allow once**, **Always allow**, **Deny**).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - See [Exec approvals](/tools/exec-approvals) and [Slash commands](/tools/slash-commands) for the broader approvals and command flow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Capabilities & limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DMs and guild text channels (threads are treated as separate channels; voice not supported).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Typing indicators sent best-effort; message chunking uses `channels.discord.textChunkLimit` (default 2000) and splits tall replies by line count (`channels.discord.maxLinesPerMessage`, default 17).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional newline chunking: set `channels.discord.chunkMode="newline"` to split on blank lines (paragraph boundaries) before length chunking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- File uploads supported up to the configured `channels.discord.mediaMaxMb` (default 8 MB).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mention-gated guild replies by default to avoid noisy bots.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reply context is injected when a message references another message (quoted content + ids).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Native reply threading is **off by default**; enable with `channels.discord.replyToMode` and reply tags.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Retry policy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Outbound Discord API calls retry on rate limits (429) using Discord `retry_after` when available, with exponential backoff and jitter. Configure via `channels.discord.retry`. See [Retry policy](/concepts/retry).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    discord: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      token: "abc.123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      guilds: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "*": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            general: { allow: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mediaMaxMb: 8,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      actions: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        reactions: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        stickers: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        emojiUploads: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        stickerUploads: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        polls: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        permissions: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        messages: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        threads: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        pins: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        search: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        memberInfo: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        roleInfo: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        roles: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        channelInfo: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        channels: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        voiceStatus: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        events: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        moderation: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        presence: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      replyToMode: "off",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dm: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        policy: "pairing", // pairing | allowlist | open | disabled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        allowFrom: ["123456789012345678", "steipete"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        groupEnabled: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        groupChannels: ["openclaw-dm"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      guilds: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "*": { requireMention: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "123456789012345678": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          slug: "friends-of-openclaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          requireMention: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          reactionNotifications: "own",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          users: ["987654321098765432", "steipete"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            general: { allow: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            help: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              allow: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              requireMention: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              users: ["987654321098765432"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              skills: ["search", "docs"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              systemPrompt: "Keep answers short.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Ack reactions are controlled globally via `messages.ackReaction` +（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`messages.ackReactionScope`. Use `messages.removeAckAfterReply` to clear the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ack reaction after the bot replies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `dm.enabled`: set `false` to ignore all DMs (default `true`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `dm.policy`: DM access control (`pairing` recommended). `"open"` requires `dm.allowFrom=["*"]`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `dm.allowFrom`: DM allowlist (user ids or names). Used by `dm.policy="allowlist"` and for `dm.policy="open"` validation. The wizard accepts usernames and resolves them to ids when the bot can search members.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `dm.groupEnabled`: enable group DMs (default `false`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `dm.groupChannels`: optional allowlist for group DM channel ids or slugs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `groupPolicy`: controls guild channel handling (`open|disabled|allowlist`); `allowlist` requires channel allowlists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `guilds`: per-guild rules keyed by guild id (preferred) or slug.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `guilds."*"`: default per-guild settings applied when no explicit entry exists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `guilds.<id>.slug`: optional friendly slug used for display names.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `guilds.<id>.users`: optional per-guild user allowlist (ids or names).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `guilds.<id>.tools`: optional per-guild tool policy overrides (`allow`/`deny`/`alsoAllow`) used when the channel override is missing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `guilds.<id>.toolsBySender`: optional per-sender tool policy overrides at the guild level (applies when the channel override is missing; `"*"` wildcard supported).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `guilds.<id>.channels.<channel>.allow`: allow/deny the channel when `groupPolicy="allowlist"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `guilds.<id>.channels.<channel>.requireMention`: mention gating for the channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `guilds.<id>.channels.<channel>.tools`: optional per-channel tool policy overrides (`allow`/`deny`/`alsoAllow`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `guilds.<id>.channels.<channel>.toolsBySender`: optional per-sender tool policy overrides within the channel (`"*"` wildcard supported).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `guilds.<id>.channels.<channel>.users`: optional per-channel user allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `guilds.<id>.channels.<channel>.skills`: skill filter (omit = all skills, empty = none).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `guilds.<id>.channels.<channel>.systemPrompt`: extra system prompt for the channel. Discord channel topics are injected as **untrusted** context (not system prompt).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `guilds.<id>.channels.<channel>.enabled`: set `false` to disable the channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `guilds.<id>.channels`: channel rules (keys are channel slugs or ids).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `guilds.<id>.requireMention`: per-guild mention requirement (overridable per channel).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `guilds.<id>.reactionNotifications`: reaction system event mode (`off`, `own`, `all`, `allowlist`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `textChunkLimit`: outbound text chunk size (chars). Default: 2000.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `chunkMode`: `length` (default) splits only when exceeding `textChunkLimit`; `newline` splits on blank lines (paragraph boundaries) before length chunking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maxLinesPerMessage`: soft max line count per message. Default: 17.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `mediaMaxMb`: clamp inbound media saved to disk.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `historyLimit`: number of recent guild messages to include as context when replying to a mention (default 20; falls back to `messages.groupChat.historyLimit`; `0` disables).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `dmHistoryLimit`: DM history limit in user turns. Per-user overrides: `dms["<user_id>"].historyLimit`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `retry`: retry policy for outbound Discord API calls (attempts, minDelayMs, maxDelayMs, jitter).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pluralkit`: resolve PluralKit proxied messages so system members appear as distinct senders.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `actions`: per-action tool gates; omit to allow all (set `false` to disable).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `reactions` (covers react + read reactions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `stickers`, `emojiUploads`, `stickerUploads`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `channels` (create/edit/delete channels + categories + permissions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `roles` (role add/remove, default `false`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `moderation` (timeout/kick/ban, default `false`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `presence` (bot status/activity, default `false`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `execApprovals`: Discord-only exec approval DMs (button UI). Supports `enabled`, `approvers`, `agentFilter`, `sessionFilter`, `cleanupAfterResolve`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Reaction notifications use `guilds.<id>.reactionNotifications`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `off`: no reaction events.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `own`: reactions on the bot's own messages (default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `all`: all reactions on all messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowlist`: reactions from `guilds.<id>.users` on all messages (empty list disables).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### PluralKit (PK) support（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable PK lookups so proxied messages resolve to the underlying system + member.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When enabled, OpenClaw uses the member identity for allowlists and labels the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sender as `Member (PK:System)` to avoid accidental Discord pings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    discord: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      pluralkit: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        token: "pk_live_...", // optional; required for private systems（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Allowlist notes (PK-enabled):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `pk:<memberId>` in `dm.allowFrom`, `guilds.<id>.users`, or per-channel `users`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Member display names are also matched by name/slug.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Lookups use the **original** Discord message ID (the pre-proxy message), so（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  the PK API only resolves it within its 30-minute window.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If PK lookups fail (e.g., private system without a token), proxied messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  are treated as bot messages and are dropped unless `channels.discord.allowBots=true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tool action defaults（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Action group   | Default  | Notes                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------- | -------- | ---------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| reactions      | enabled  | React + list reactions + emojiList |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| stickers       | enabled  | Send stickers                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| emojiUploads   | enabled  | Upload emojis                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| stickerUploads | enabled  | Upload stickers                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| polls          | enabled  | Create polls                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| permissions    | enabled  | Channel permission snapshot        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| messages       | enabled  | Read/send/edit/delete              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| threads        | enabled  | Create/list/reply                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| pins           | enabled  | Pin/unpin/list                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| search         | enabled  | Message search (preview feature)   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| memberInfo     | enabled  | Member info                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| roleInfo       | enabled  | Role list                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| channelInfo    | enabled  | Channel info + list                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| channels       | enabled  | Channel/category management        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| voiceStatus    | enabled  | Voice state lookup                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| events         | enabled  | List/create scheduled events       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| roles          | disabled | Role add/remove                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| moderation     | disabled | Timeout/kick/ban                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| presence       | disabled | Bot status/activity (setPresence)  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `replyToMode`: `off` (default), `first`, or `all`. Applies only when the model includes a reply tag.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Reply tags（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To request a threaded reply, the model can include one tag in its output:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `[[reply_to_current]]` — reply to the triggering Discord message.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `[[reply_to:<id>]]` — reply to a specific message id from context/history.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Current message ids are appended to prompts as `[message_id: …]`; history entries already include ids.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Behavior is controlled by `channels.discord.replyToMode`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `off`: ignore tags.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `first`: only the first outbound chunk/attachment is a reply.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `all`: every outbound chunk/attachment is a reply.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Allowlist matching notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowFrom`/`users`/`groupChannels` accept ids, names, tags, or mentions like `<@id>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefixes like `discord:`/`user:` (users) and `channel:` (group DMs) are supported.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `*` to allow any sender/channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When `guilds.<id>.channels` is present, channels not listed are denied by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When `guilds.<id>.channels` is omitted, all channels in the allowlisted guild are allowed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- To allow **no channels**, set `channels.discord.groupPolicy: "disabled"` (or keep an empty allowlist).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The configure wizard accepts `Guild/Channel` names (public + private) and resolves them to IDs when possible.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On startup, OpenClaw resolves channel/user names in allowlists to IDs (when the bot can search members)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  and logs the mapping; unresolved entries are kept as typed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Native command notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The registered commands mirror OpenClaw’s chat commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Native commands honor the same allowlists as DMs/guild messages (`channels.discord.dm.allowFrom`, `channels.discord.guilds`, per-channel rules).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slash commands may still be visible in Discord UI to users who aren’t allowlisted; OpenClaw enforces allowlists on execution and replies “not authorized”.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool actions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The agent can call `discord` with actions like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `react` / `reactions` (add or list reactions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sticker`, `poll`, `permissions`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `readMessages`, `sendMessage`, `editMessage`, `deleteMessage`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Read/search/pin tool payloads include normalized `timestampMs` (UTC epoch ms) and `timestampUtc` alongside raw Discord `timestamp`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `threadCreate`, `threadList`, `threadReply`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pinMessage`, `unpinMessage`, `listPins`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `searchMessages`, `memberInfo`, `roleInfo`, `roleAdd`, `roleRemove`, `emojiList`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channelInfo`, `channelList`, `voiceStatus`, `eventList`, `eventCreate`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timeout`, `kick`, `ban`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `setPresence` (bot activity and online status)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Discord message ids are surfaced in the injected context (`[discord message id: …]` and history lines) so the agent can target them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Emoji can be unicode (e.g., `✅`) or custom emoji syntax like `<:party_blob:1234567890>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Safety & ops（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Treat the bot token like a password; prefer the `DISCORD_BOT_TOKEN` env var on supervised hosts or lock down the config file permissions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Only grant the bot permissions it needs (typically Read/Send Messages).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the bot is stuck or rate limited, restart the gateway (`openclaw gateway --force`) after confirming no other processes own the Discord session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
