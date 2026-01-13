---
summary: "Reaction semantics shared across providers"
read_when:
  - Working on reactions in any provider
---
# Reaction tooling

Shared reaction semantics across providers:

- `emoji` is required when adding a reaction.
- `emoji=""` removes the bot's reaction(s) when supported.
- `remove: true` removes the specified emoji when supported (requires `emoji`).

Provider notes:

- **Discord/Slack**: empty `emoji` removes all of the bot's reactions on the message; `remove: true` removes just that emoji.
- **Telegram**: empty `emoji` removes the bot's reactions; `remove: true` also removes reactions but still requires a non-empty `emoji` for tool validation.
- **WhatsApp**: empty `emoji` removes the bot reaction; `remove: true` maps to empty emoji (still requires `emoji`).
- **Signal**: inbound reaction notifications emit system events when `channels.signal.reactionNotifications` is enabled.
