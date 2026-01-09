---
summary: "Reaction semantics shared across providers"
read_when:
  - Working on reactions in any provider
---
# Reaction tooling

Shared reaction semantics across providers:

- `emoji` is required for reactions.
- `emoji=""` removes the bot's reaction(s) on the message.
- `remove: true` removes the specified emoji when supported.

Provider notes:

- **Discord/Slack**: empty `emoji` removes all of the bot's reactions on the message; `remove: true` removes just that emoji.
- **Telegram**: `remove: true` removes your own reaction (Bot API limitation).
- **WhatsApp**: `remove: true` maps to empty emoji (remove bot reaction).
