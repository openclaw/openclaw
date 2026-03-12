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
- **Matrix**: empty `emoji` removes the bot account's own reactions on the message; `remove: true` removes just that emoji; inbound reaction notifications on bot-authored messages are controlled by `reactionNotifications`.
- **Telegram**: empty `emoji` removes the bot's reactions; `remove: true` also removes reactions but still requires a non-empty `emoji` for tool validation.
- **WhatsApp**: empty `emoji` removes the bot reaction; `remove: true` maps to empty emoji (still requires `emoji`).
- **Zalo Personal (`zalouser`)**: requires non-empty `emoji`; `remove: true` removes that specific emoji reaction.
- **Signal**: inbound reaction notifications emit system events when `channels.signal.reactionNotifications` is enabled.
