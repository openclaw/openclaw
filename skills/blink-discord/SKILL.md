---
name: blink-discord
description: >
  Send messages, read channels, manage Discord server content. Use when asked
  to post in Discord, read channel messages, or interact with a Discord server.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "discord" } }
---

# Blink Discord

Interact with the user's linked Discord account/server. Provider key: `discord`.

## Get current user info
```bash
bash scripts/call.sh discord /users/@me GET
```

## List servers (guilds)
```bash
bash scripts/call.sh discord /users/@me/guilds GET
```

## List channels in a server
```bash
bash scripts/call.sh discord /guilds/GUILD_ID/channels GET
```

## Read recent messages from a channel
```bash
bash scripts/call.sh discord /channels/CHANNEL_ID/messages GET '{"limit": 20}'
```

## Send a message to a channel
```bash
bash scripts/call.sh discord /channels/CHANNEL_ID/messages POST '{"content": "Hello from your agent!"}'
```

## Get server members
```bash
bash scripts/call.sh discord /guilds/GUILD_ID/members GET '{"limit": 50}'
```

## Common use cases
- "Post an update in #announcements on my Discord server" → send message
- "What was discussed in #general today?" → read channel messages
- "List all channels in my server" → list channels
- "Who are the members of my Discord?" → list members
- "Send a message to the dev channel: new release is live" → postMessage
