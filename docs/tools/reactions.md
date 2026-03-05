---
summary: "Reaction semantics shared across channels"
read_when:
  - Working on reactions in any channel
title: "Reactions"
---

# Reaction tooling

Shared reaction semantics across channels:

- `emoji` is required when adding a reaction.
- `emoji=""` removes the bot's reaction(s) when supported.
- `remove: true` removes the specified emoji when supported (requires `emoji`).

Channel notes:

- **Discord/Slack**: empty `emoji` removes all of the bot's reactions on the message; `remove: true` removes just that emoji.
- **Google Chat**: empty `emoji` removes the app's reactions on the message; `remove: true` removes just that emoji.
- **Telegram**: empty `emoji` removes the bot's reactions; `remove: true` also removes reactions but still requires a non-empty `emoji` for tool validation.
- **WhatsApp**: empty `emoji` removes the bot reaction; `remove: true` maps to empty emoji (still requires `emoji`).
- **Zalo Personal (`zalouser`)**: requires non-empty `emoji`; `remove: true` removes that specific emoji reaction.
- **Signal**: inbound reaction notifications emit system events when `channels.signal.reactionNotifications` is enabled.

## Reaction trigger (`reactionTrigger`)

When `reactionTrigger` is enabled, receiving a reaction immediately wakes the agent session (via `requestHeartbeatNow`) instead of waiting for the next message or scheduled heartbeat. This lets the agent respond to reactions in real time.

Currently supported for **Slack** only. Other channels (Telegram, Discord, Signal) can be added in follow-up PRs.

**Values:**

| Value       | Behavior                                                             |
| ----------- | -------------------------------------------------------------------- |
| `off`       | (Default) No immediate wake on reactions.                            |
| `own`       | Wake only when a reaction is added to one of the bot's own messages. |
| `all`       | Wake on any reaction the bot can see.                                |
| `allowlist` | (Slack only) Wake for reactions from allowlisted users.              |

**Important distinctions:**

- `reactionNotifications` controls which reactions generate system events (the data the agent sees).
- `reactionTrigger` controls whether those reactions also wake the agent immediately.
- Both settings are independent — you can have notifications without triggering, or vice versa.

**Slack Free plan limitation:** Reaction events (`reaction_added` / `reaction_removed`) are not delivered on Slack Free workspaces, so `reactionTrigger` has no effect there.
