---
summary: "Discord bot support status, capabilities, and configuration"
read_when:
  - Working on Discord provider features
---
# Discord (Bot API)

Updated: 2026-01-06

Status: production-ready for DMs + guild channels via the Discord gateway.

## What it is
- Discord bot provider owned by the Gateway.
- Deterministic routing: replies always go back to Discord.
- DMs share the agent's main session; guild channels are isolated (`discord:channel:<id>`).

## Setup (fast path)
1) Create a Discord application + bot.
2) Enable intents: **Message Content** (required), **Server Members** (recommended).
3) Invite the bot to your server with message permissions.
4) Configure the token (env or config) and start the gateway.

Example:
```json5
{
  discord: {
    enabled: true,
    token: "YOUR_BOT_TOKEN",
    dm: { policy: "pairing" },
    guilds: { "*": { requireMention: true } }
  }
}
```

## Access control (DMs + guilds)
DMs:
- Default: `discord.dm.policy = "pairing"`.
- Unknown senders receive a pairing code; messages are ignored until approved.
- Approve via:
  - `clawdbot pairing list --provider discord`
  - `clawdbot pairing approve --provider discord <CODE>`
- Pairing is the default token exchange for Discord DMs. Details: https://docs.clawd.bot/pairing

Guild channels:
- `discord.groupPolicy = open | allowlist | disabled`.
- `discord.guilds` (per-guild) + `channels` (per-channel) act as allowlists.
- Mentions are required by default; override per guild/channel.

## How it works (behavior)
- Inbound messages are normalized into the shared provider envelope.
- Optional guild context history is injected before the current message.
- Replies always route back to the same channel or DM.

## Commands + reply threading
- Native commands: `commands.native = true` (registers `/` commands).
- Text commands: `commands.text = true` (standalone `/...` messages).
- Threaded replies: controlled by `discord.replyToMode` using reply tags.

## Media + limits
- Files supported up to `discord.mediaMaxMb` (default 8 MB).
- Outbound chunking controlled by `discord.textChunkLimit`.

## Delivery targets (CLI/cron)
- DMs: `user:<id>`
- Guild channels: `channel:<channelId>`

## Configuration reference (Discord)
Full configuration: https://docs.clawd.bot/configuration

Provider options:
- `discord.enabled`: enable/disable provider startup.
- `discord.token`: bot token (env: `DISCORD_BOT_TOKEN`).
- `discord.groupPolicy`: `open | allowlist | disabled` (default: open).
- `discord.textChunkLimit`: outbound chunk size (chars).
- `discord.mediaMaxMb`: inbound/outbound media cap (MB).
- `discord.historyLimit`: number of recent guild messages injected as context.
- `discord.replyToMode`: `off | first | all`.
- `discord.actions.reactions`: enable reaction tool actions.
- `discord.actions.stickers`: enable sticker actions.
- `discord.actions.polls`: enable poll actions.
- `discord.actions.permissions`: enable permission inspection actions.
- `discord.actions.messages`: enable message read/send/edit/delete actions.
- `discord.actions.threads`: enable thread actions.
- `discord.actions.pins`: enable pin actions.
- `discord.actions.search`: enable search actions.
- `discord.actions.memberInfo`: enable member info actions.
- `discord.actions.roleInfo`: enable role info actions.
- `discord.actions.roles`: enable role management actions.
- `discord.actions.channelInfo`: enable channel info actions.
- `discord.actions.voiceStatus`: enable voice status actions.
- `discord.actions.events`: enable event actions.
- `discord.actions.moderation`: enable moderation actions.
- `discord.dm.enabled`: enable/disable DMs.
- `discord.dm.policy`: `pairing | allowlist | open | disabled` (default: pairing).
- `discord.dm.allowFrom`: DM allowlist (ids/usernames). `open` requires `"*"`.
- `discord.dm.groupEnabled`: enable group DMs.
- `discord.dm.groupChannels`: group DM allowlist.
- `discord.guilds`: per-guild rules:
  - `slug`, `requireMention`, `reactionNotifications`, `users`, `channels.*`.

Related global options:
- `routing.groupChat.mentionPatterns`.
- `commands.native`, `commands.text`, `commands.useAccessGroups`.
- `messages.responsePrefix`, `messages.ackReaction`, `messages.ackReactionScope`.
