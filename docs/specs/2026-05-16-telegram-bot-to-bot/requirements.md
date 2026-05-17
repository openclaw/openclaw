# Requirements — Telegram bot-to-bot routing (Bot API 9.5)

## Outcome

OpenClaw's Telegram channel handles the Bot API 9.5 bot-to-bot conversations: it can both receive messages from other bots and send messages to other bots, enabling multi-agent workflows that span distinct Telegram bot identities (e.g., a research bot owned by openclaw talks to a deploy bot owned by an external service). Granular per-bot whitelist (BotFather-set) and AI bot @-mentions outside group membership are also respected.

## Users affected

- Operators wiring multi-agent automations across multiple Telegram bots.
- Telegram channel — `src/telegram/`.
- Channel routing — `src/routing/resolve-route.ts`, allowlist machinery in `src/channels/`.
- `openclaw doctor` and `openclaw configure --section telegram`.

## In scope

- Detect Bot API 9.5 sender shape — flag inbound updates whose `from.is_bot=true`.
- Per-sender policy: `telegram.bots.<senderBotId>` accept/refuse/promptToApprove.
- Honor the new BotFather granular whitelist exposed via the Manager Bots API (per-bot, not just per-account).
- Outbound: allow sending to other bots when policy permits; reject sends to bots not in the allowlist.
- Session-key shape: `telegram:<accountId>:bot:<peerBotId>` so bot-to-bot conversations are isolated from human-to-bot ones.
- Handle the "AI bot mentioned in any chat without joining" pattern — when openclaw is @-mentioned in a chat it isn't a member of, the message is processed as an ad-hoc query with no persistent session (governed by allowlist).

## Out of scope

- Building outbound bot orchestration logic — agents drive the conversations through existing tools; we only ensure the channel pipe is open.
- Cross-account bot federation (single Telegram account, multiple bots — that already works).
- Hosting Manager Bots ourselves; we read whitelist from the Telegram API but don't create/manage bots automatically.

## Decisions

- Default policy for unknown bot senders: `promptToApprove` (same posture as DM pairing). Reason: trust posture stays fail-closed; bot identity can be spoofed via display-name games.
- Ad-hoc @-mention queries don't persist a session by default. Reason: avoids accidental session sprawl when openclaw is mentioned in unfamiliar chats.
- Reuse `src/pairing/pairing-store.ts` for bot-id approvals. Reason: one allowlist source.
