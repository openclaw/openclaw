---
summary: "Checklist for unifying messaging channel logic"
read_when:
  - Planning refactors across channel implementations
  - Standardizing shared message handling behavior
---
# Channel unification checklist

Purpose: centralize repeated messaging logic so core + extensions stay consistent, testable, and easier to evolve.

## Ack reactions (already centralized)
- [x] Shared gating helper for core channels.
- [x] Shared gating helper for extensions.
- [x] WhatsApp-specific gating helper (direct/group/mentions) aligned with activation.
- [ ] Optional: centralize “remove after reply” behavior (see below).

## Ack reaction removal (after reply)
Problem: duplicated logic across Discord, Slack, Telegram, BlueBubbles.
- [ ] Create `channel.reactions.removeAfterReply()` helper that accepts:
  - `removeAckAfterReply` flag
  - ack promise + result boolean
  - channel-specific remove fn + ids
- [ ] Wire in:
  - `src/discord/monitor/message-handler.process.ts`
  - `src/slack/monitor/message-handler/dispatch.ts`
  - `src/telegram/bot-message-dispatch.ts`
  - `extensions/bluebubbles/src/monitor.ts`
- [ ] Add unit tests for the helper (success + ack-failed paths).

## Pending history buffering + flush
Problem: repeated “record pending history”, “prepend pending history”, and “clear history” patterns.
- [ ] Identify shared flow in:
  - `src/discord/monitor/message-handler.preflight.ts`
  - `src/discord/monitor/message-handler.process.ts`
  - `src/slack/monitor/message-handler/prepare.ts`
  - `src/telegram/bot-message-context.ts`
  - `src/signal/monitor/event-handler.ts`
  - `src/imessage/monitor/monitor-provider.ts`
  - `extensions/mattermost/src/mattermost/monitor.ts`
  - `src/web/auto-reply/monitor/group-gating.ts`
- [ ] Add helper(s) to `src/auto-reply/reply/history.ts`:
  - `recordPendingIfBlocked()` (accepts allowlist/mention gating reason)
  - `mergePendingIntoBody()` (returns combined body)
  - `clearPendingHistory()` (wrapper to standardize historyKey, limits)
- [ ] Ensure per-channel metadata (sender label, timestamps, messageId) preserved.
- [ ] Add tests for helper(s); keep per-channel smoke tests.

## Typing lifecycle
Problem: inconsistent typing start/stop handling and error logging.
- [ ] Add a shared typing adapter in core (ex: `src/channels/typing.ts`) that accepts:
  - `startTyping` / `stopTyping` callbacks
  - `onReplyStart` / `onReplyIdle` hooks from dispatcher
  - TTL + interval config (reuse `auto-reply/reply/typing` machinery)
- [ ] Wire in:
  - Discord (`src/discord/monitor/typing.ts`)
  - Slack (`src/slack/monitor/message-handler/dispatch.ts`)
  - Telegram (dispatch flow)
  - Signal (`src/signal/monitor/event-handler.ts`)
  - Matrix (`extensions/matrix/src/matrix/monitor/handler.ts`)
  - Mattermost (`extensions/mattermost/src/mattermost/monitor.ts`)
  - BlueBubbles (`extensions/bluebubbles/src/monitor.ts`)
  - MS Teams (`extensions/msteams/src/reply-dispatcher.ts`)
- [ ] Add helper tests for start/stop and error handling.

## Reply dispatcher wiring
Problem: channels hand-roll dispatcher glue; varies in error handling and typing.
- [ ] Add a shared wrapper that builds:
  - reply dispatcher
  - response prefix context
  - table mode conversion
- [ ] Adopt in:
  - Discord, Slack, Telegram (core)
  - BlueBubbles, Matrix, Mattermost (extensions)
- [ ] Keep per-channel delivery adapter (send message / chunking).

## Session meta + last route updates
Problem: repeated patterns for `recordSessionMetaFromInbound` and `updateLastRoute`.
- [ ] Add helper `channel.session.recordInbound()` that accepts:
  - `storePath`, `sessionKey`, `ctx`
  - optional `channel/accountId/target` for `updateLastRoute`
- [ ] Wire in:
  - Discord, Slack, Telegram, Matrix, BlueBubbles

## Control command gating patterns
Problem: similar gating flow per channel (allowlists + commands).
- [ ] Add a helper that merges:
  - allowlist checks
  - command gating decisions
  - mention bypass evaluation
- [ ] Keep channel-specific identity/user resolution separate.

## Error + verbose logging
Problem: inconsistent message formats across channels.
- [ ] Define canonical log helpers:
  - `logInboundDrop(reason, meta)`
  - `logAckFailure(meta)`
  - `logTypingFailure(meta)`
- [ ] Apply to all channel handlers.

## Docs + SDK
- [ ] Expose new helpers through `src/plugin-sdk/index.ts` + plugin runtime.
- [ ] Update `docs/tools/reactions.md` if ack semantics expand.
- [ ] Add `read_when` hints if new cross-cutting helpers are introduced.
