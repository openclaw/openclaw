---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Reaction semantics shared across channels"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Working on reactions in any channel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Reactions"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Reaction tooling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Shared reaction semantics across channels:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `emoji` is required when adding a reaction.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `emoji=""` removes the bot's reaction(s) when supported.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `remove: true` removes the specified emoji when supported (requires `emoji`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Channel notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Discord/Slack**: empty `emoji` removes all of the bot's reactions on the message; `remove: true` removes just that emoji.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Google Chat**: empty `emoji` removes the app's reactions on the message; `remove: true` removes just that emoji.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Telegram**: empty `emoji` removes the bot's reactions; `remove: true` also removes reactions but still requires a non-empty `emoji` for tool validation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **WhatsApp**: empty `emoji` removes the bot reaction; `remove: true` maps to empty emoji (still requires `emoji`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Signal**: inbound reaction notifications emit system events when `channels.signal.reactionNotifications` is enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
