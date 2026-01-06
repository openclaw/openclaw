---
summary: "Slack socket mode setup and Clawdbot config"
read_when: "Setting up Slack or debugging Slack socket mode"
---

# Slack (socket mode)

Updated: 2026-01-06

Status: production-ready for DMs + channels via Slack Socket Mode.

## What it is
- Slack bot provider owned by the Gateway.
- Socket Mode only (no inbound HTTP server required).
- Deterministic routing: replies always go back to Slack.

## Setup (fast path)
1) Create a Slack app.
2) Enable **Socket Mode** and create an **App Token** (`xapp-...`).
3) Install the app to your workspace and copy the **Bot Token** (`xoxb-...`).
4) Add required scopes + events (see Slack app manifest if needed).
5) Configure tokens and start the gateway.

Example:
```json5
{
  slack: {
    enabled: true,
    botToken: "xoxb-...",
    appToken: "xapp-...",
    dm: { policy: "pairing" },
    channels: { "#general": { allow: true, requireMention: true } }
  }
}
```

## Access control (DMs + channels)
DMs:
- Default: `slack.dm.policy = "pairing"`.
- Unknown senders receive a pairing code; messages are ignored until approved.
- Approve via:
  - `clawdbot pairing list --provider slack`
  - `clawdbot pairing approve --provider slack <CODE>`
- Pairing is the default token exchange for Slack DMs. Details: https://docs.clawd.bot/pairing

Channels:
- `slack.groupPolicy = open | allowlist | disabled`.
- `slack.channels` acts as the allowlist when `groupPolicy = allowlist`.
- Mentions are required by default unless overridden per channel.

## How it works (behavior)
- Inbound messages are normalized into the shared provider envelope.
- Replies always route back to the same channel or DM.
- Threading: replies to a message stay in that thread if it was a thread message.

## Commands
- Text commands: `commands.text = true` (standalone `/...` messages).
- Slack slash command: configure `slack.slashCommand` (separate from `commands.native`).

## Media + limits
- Files supported up to `slack.mediaMaxMb` (default 20 MB).
- Outbound chunking controlled by `slack.textChunkLimit`.

## Delivery targets (CLI/cron)
- DMs: `user:<id>`
- Channels: `channel:<id>`

## Configuration reference (Slack)
Full configuration: https://docs.clawd.bot/configuration

Provider options:
- `slack.enabled`: enable/disable provider startup.
- `slack.botToken`: bot token (env: `SLACK_BOT_TOKEN`).
- `slack.appToken`: app token (env: `SLACK_APP_TOKEN`).
- `slack.groupPolicy`: `open | allowlist | disabled` (default: open).
- `slack.channels`: channel allowlist + per-channel `requireMention`.
- `slack.textChunkLimit`: outbound chunk size (chars).
- `slack.mediaMaxMb`: inbound/outbound media cap (MB).
- `slack.reactionNotifications`: `off | own | all | allowlist`.
- `slack.reactionAllowlist`: user allowlist for reaction notifications.
- `slack.actions.reactions`: enable reaction tool actions.
- `slack.actions.messages`: enable message read/send/edit/delete actions.
- `slack.actions.pins`: enable pin actions.
- `slack.actions.search`: enable search actions.
- `slack.actions.permissions`: enable permission inspection actions.
- `slack.actions.memberInfo`: enable member info actions.
- `slack.actions.channelInfo`: enable channel info actions.
- `slack.actions.emojiList`: enable emoji list actions.
- `slack.slashCommand.*`: configure the Slack slash command endpoint (`name`, `sessionPrefix`, `ephemeral`).
- `slack.dm.enabled`: enable/disable DMs.
- `slack.dm.policy`: `pairing | allowlist | open | disabled` (default: pairing).
- `slack.dm.allowFrom`: DM allowlist (ids/usernames). `open` requires `"*"`.
- `slack.dm.groupEnabled`: enable group DMs.
- `slack.dm.groupChannels`: group DM allowlist.

Related global options:
- `routing.groupChat.mentionPatterns`.
- `commands.text`, `commands.useAccessGroups`.
- `messages.responsePrefix`, `messages.ackReaction`, `messages.ackReactionScope`.
