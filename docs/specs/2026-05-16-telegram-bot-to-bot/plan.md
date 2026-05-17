# Plan — Telegram bot-to-bot routing (Bot API 9.5)

## Approach

Extend the Telegram update handler in `src/telegram/` to surface `from.is_bot=true` separately from human senders, route them through a new bot-aware policy layer that consults the BotFather whitelist (when available) and the local allowlist, and persist approvals via the shared pairing store. Outbound sends to bots get a symmetric policy gate. Ad-hoc @-mention queries land as one-shot agent calls with a stateless session key.

## Steps

1. Update inbound message normalization (`src/telegram/`) to flag bot senders and surface `senderBotId` to the routing layer.
2. Extend `src/channels/channel-config.ts` allowlist schema with `bots.allowFrom`, `bots.denyFrom`, `bots.dmPolicy` (mirroring the existing human-side keys).
3. Route handler: derive `sessionKey="telegram:<accountId>:bot:<peerBotId>"` for ongoing bot↔bot threads; `sessionKey="telegram:<accountId>:adhoc:<msgId>"` for unsolicited mentions in chats openclaw isn't a member of.
4. Approval flow: unknown bot sender → reply with a pairing code (same UX as human DM pairing) → `openclaw pairing approve telegram-bot <code>` adds the bot to the allowlist.
5. Outbound: extend the Telegram send path to consult the same allowlist before sending; refuse with a typed error if the target is a bot not in the list.
6. BotFather granular whitelist: if Manager Bot credentials are configured, periodically fetch the per-bot whitelist and merge with local state (local entries take precedence on conflict).
7. CLI: `openclaw telegram bots list|approve|deny`.
8. Doctor: warn on `bots.dmPolicy="open"` with empty allowlist; warn when no Manager Bot credential is configured AND bot-to-bot is enabled (operator might miss granular whitelist updates).
9. Docs: `docs/channels/telegram.mdx` updates explaining the bot-to-bot model.

## Dependencies / order

- Step 1 (inbound flag) blocks 3–5.
- Step 2 (config) blocks 3–5.
- Steps 6–9 land after the core path works.
