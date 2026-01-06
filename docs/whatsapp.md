---
summary: "WhatsApp (web provider) integration: login, inbox, replies, media, and ops"
read_when:
  - Working on WhatsApp/web provider behavior or inbox routing
---
# WhatsApp (web provider)

Updated: 2026-01-06

Status: WhatsApp Web via Baileys. Gateway owns the session(s).

## What it is
- WhatsApp Web connection managed by the Gateway.
- Deterministic routing: replies always return to WhatsApp.
- DMs share the agent's main session; groups are isolated (`whatsapp:group:<jid>`).

## Setup (fast path)
1) Use a real mobile number (WhatsApp blocks most VoIP numbers).
2) Run `clawdbot login` and scan the QR (Linked Devices).
3) Start the gateway; the WhatsApp provider starts when a linked session exists.
4) Lock down DMs and groups (pairing + allowlists are default-safe).

Multi-account:
- `clawdbot login --account <id>`
- Configure `whatsapp.accounts.<id>` for per-account settings.

## Access control (DMs + groups)
DMs:
- Default: `whatsapp.dmPolicy = "pairing"`.
- Unknown senders get a pairing code and are ignored until approved.
- Approve via:
  - `clawdbot pairing list --provider whatsapp`
  - `clawdbot pairing approve --provider whatsapp <CODE>`
- Pairing is the default token exchange for WhatsApp DMs. Details: https://docs.clawd.bot/pairing

Groups:
- `whatsapp.groupPolicy = open | allowlist | disabled`.
- `whatsapp.groups` sets per-group defaults and becomes an allowlist when present (use `"*"` to allow all).
- Mention gating defaults to `requireMention: true` unless overridden.

## How it works (behavior)
- Inbound messages are normalized into the shared provider envelope with reply context.
- Group replies require a mention by default (native mentions or `routing.groupChat.mentionPatterns`).
- Recent group history can be injected for context (see `routing.groupChat.historyLimit`).

## Reply delivery
- Standard WhatsApp messages (no threaded replies).
- Text chunking is applied to stay within limits.

## Media
- Images/video/audio/documents supported.
- Default cap: 5 MB per item (override via `agent.mediaMaxMb`).
- Oversize media returns a warning instead of sending.

## Delivery targets (CLI/cron)
- DMs: E.164 (`+15551234567`).
- Groups: group JID (`12345-678@g.us`).

## Configuration reference (WhatsApp)
Full configuration: https://docs.clawd.bot/configuration

Provider options:
- `whatsapp.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing).
- `whatsapp.allowFrom`: DM allowlist (E.164). `open` requires `"*"`.
- `whatsapp.groupPolicy`: `open | allowlist | disabled` (default: open).
- `whatsapp.groupAllowFrom`: group sender allowlist (E.164).
- `whatsapp.groups`: per-group defaults + allowlist (use `"*"` for global defaults).
- `whatsapp.textChunkLimit`: outbound chunk size (chars).
- `whatsapp.accounts`: per-account overrides:
  - `whatsapp.accounts.<id>.enabled`
  - `whatsapp.accounts.<id>.authDir`
  - `whatsapp.accounts.<id>.dmPolicy`
  - `whatsapp.accounts.<id>.allowFrom`
  - `whatsapp.accounts.<id>.groupPolicy`
  - `whatsapp.accounts.<id>.groupAllowFrom`
  - `whatsapp.accounts.<id>.groups`
  - `whatsapp.accounts.<id>.textChunkLimit`

Runtime options (WhatsApp web provider):
- `web.enabled`: enable/disable provider startup.
- `web.heartbeatSeconds`: gateway heartbeat cadence.
- `web.reconnect.*`: reconnect backoff (`initialMs`, `maxMs`, `factor`, `jitter`, `maxAttempts`).

Related global options:
- `routing.groupChat.mentionPatterns`, `routing.groupChat.historyLimit`.
- `commands.text`, `commands.useAccessGroups`.
- `messages.responsePrefix`, `messages.ackReaction`, `messages.ackReactionScope`.
