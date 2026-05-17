# Validation — Telegram bot-to-bot routing (Bot API 9.5)

## Automated tests

- `src/telegram/bot-sender.test.ts` — `from.is_bot=true` correctly tagged on inbound.
- `src/channels/bot-allowlist.test.ts` — config schema parse + allow/deny precedence.
- `src/routing/telegram-bot-session-key.test.ts` — session keys derived as specified for bot↔bot and ad-hoc.
- `src/telegram/outbound-bot-policy.test.ts` — sends to disallowed bots fail with the typed error.
- `src/pairing/telegram-bot-approval.test.ts` — pairing-store integration.
- E2E: fixture in `scripts/e2e/telegram-bot-docker.sh` exercising the bot-to-bot path against a mocked Telegram server.
- Live test (gated `OPENCLAW_LIVE_TEST=1`) — two real bots ping each other through a sandbox group; first contact triggers pairing, post-approval messages flow.

## Smoke checks

- An unknown bot DMs the openclaw bot; openclaw replies with a pairing code; `openclaw pairing approve telegram-bot <code>` accepts; subsequent messages flow.
- Outbound send to a non-allowlisted bot returns a clear error.
- `openclaw telegram bots list` shows current approvals.
- `openclaw doctor` warns on misconfiguration.

## Manual criteria

- Pairing message wording for bot senders is distinct from the human DM pairing message (so the receiving operator doesn't get confused).
- Ad-hoc @-mention replies feel responsive and clearly stateless (don't accidentally remember the chat next time).

## AI eval plan

- Success criteria: in a 10-prompt fixture mixing human DMs and bot-sourced messages, routing assigns the correct session-key shape 100% of the time; deny-listed bot sends never go through.
- Eval dataset: `tests/evals/telegram-bot-routing.jsonl` — labeled update fixtures.
- Regression set: 5 fixtures — known bot DM, unknown bot DM, group @-mention by bot, group @-mention by human, outbound to denied bot.
- Cadence: per-PR on fixtures; nightly on the live Telegram matrix.

## Risks & rollback

- **Risks:**
  - Bot impersonation: a bot with a similar display name tries to slip past the allowlist. *Mitigate* by allowlist matching on `senderBotId` (the immutable numeric id), never on display name.
  - Loops: two bots chatter forever. *Mitigate* by reusing the existing per-channel rate limiter + a per-bot turn budget.
  - Manager Bot whitelist sync races. *Mitigate* by treating local state as canonical on conflict; doctor logs the drift.
- **Rollback:** set `telegram.bots.dmPolicy="closed"` to block all bot senders; PR revert is safe — the existing human path is unchanged.

## Open questions

- Default behavior for unsolicited @-mentions in random chats: silent (don't reply) or "I haven't been authorized in this chat"? Lean silent to reduce spam surface; confirm before merge.
