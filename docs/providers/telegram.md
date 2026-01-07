---
summary: "Telegram bot support status, capabilities, and configuration"
read_when:
  - Working on Telegram features or webhooks
---
# Telegram (Bot API)

Updated: 2026-01-06

Status: production-ready for bot DMs + groups via grammY. Long-polling by default; webhook optional.

## What it is
- A Telegram Bot API provider owned by the Gateway.
- Deterministic routing: replies go back to Telegram; the model never chooses providers.
- DMs share the agent's main session; groups stay isolated (`telegram:group:<chatId>`).

## Setup (fast path)
1) Create a bot with @BotFather and copy the token.
2) Configure the token (env or config). Example:

```json5
{
  telegram: {
    enabled: true,
    botToken: "123:abc",
    dmPolicy: "pairing",
    groups: { "*": { requireMention: true } }
  }
}
```

3) Start the gateway. Telegram starts when a `telegram` config section exists and a token is resolved.
4) DM access defaults to pairing. Approve the code when the bot is first contacted.
5) For groups: add the bot, disable privacy mode (or make it admin), then set `telegram.groups` to control mention gating + allowlists.

## How it works (behavior)
- Inbound messages are normalized into the shared provider envelope with reply context and media placeholders.
- Group replies require a mention by default (native @mention or `routing.groupChat.mentionPatterns`).
- Replies always route back to the same Telegram chat.

## Topics (forum supergroups)
Telegram forum topics include a `message_thread_id` per message. Clawdbot:
- Appends `:topic:<threadId>` to the Telegram group session key so each topic is isolated.
- Sends typing indicators and replies with `message_thread_id` so responses stay in the topic.
- Exposes `MessageThreadId` + `IsForum` in template context for routing/templating.

## Access control (DMs + groups)
- Default: `telegram.dmPolicy = "pairing"`. Unknown senders receive a pairing code; messages are ignored until approved.
- Approve via:
  - `clawdbot pairing list --provider telegram`
  - `clawdbot pairing approve --provider telegram <CODE>`
- Pairing is the default token exchange used for Telegram DMs. Details: [Pairing](/start/pairing)

Group gating:
- `telegram.groupPolicy = open | allowlist | disabled`.
- `telegram.groups` doubles as a group allowlist when set (include `"*"` to allow all).

## Long-polling vs webhook
- Default: long-polling (no public URL required).
- Webhook mode: set `telegram.webhookUrl` (optionally `telegram.webhookSecret` + `telegram.webhookPath`).
  - The local listener binds to `0.0.0.0:8787` and serves `POST /telegram-webhook` by default.
  - If your public URL is different, use a reverse proxy and point `telegram.webhookUrl` at the public endpoint.

## Reply threading
Telegram supports optional threaded replies via tags:
- `[[reply_to_current]]` -- reply to the triggering message.
- `[[reply_to:<id>]]` -- reply to a specific message id.

Controlled by `telegram.replyToMode`:
- `off` (default), `first`, `all`.

## Delivery targets (CLI/cron)
- Use a chat id (`123456789`) or a username (`@name`) as the target.
- Example: `clawdbot send --provider telegram --to 123456789 "hi"`.

## Configuration reference (Telegram)
Full configuration: [Configuration](/gateway/configuration)

Provider options:
- `telegram.enabled`: enable/disable provider startup.
- `telegram.botToken`: bot token (BotFather).
- `telegram.tokenFile`: read token from file path.
- `telegram.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing).
- `telegram.allowFrom`: DM allowlist (ids/usernames). `open` requires `"*"`.
- `telegram.groupPolicy`: `open | allowlist | disabled` (default: open).
- `telegram.groupAllowFrom`: group sender allowlist (ids/usernames).
- `telegram.groups`: per-group defaults + allowlist (use `"*"` for global defaults).
- `telegram.replyToMode`: `off | first | all`.
- `telegram.textChunkLimit`: outbound chunk size (chars).
- `telegram.mediaMaxMb`: inbound/outbound media cap (MB).
- `telegram.proxy`: proxy URL for Bot API calls (SOCKS/HTTP).
- `telegram.webhookUrl`: enable webhook mode.
- `telegram.webhookSecret`: webhook secret (optional).
- `telegram.webhookPath`: local webhook path (default `/telegram-webhook`).

Related global options:
- `routing.groupChat.mentionPatterns` (mention gating patterns).
- `commands.native`, `commands.text`, `commands.useAccessGroups` (command behavior).
- `messages.responsePrefix`, `messages.ackReaction`, `messages.ackReactionScope`.
