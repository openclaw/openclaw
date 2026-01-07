---
summary: "Telegram Bot API integration: setup, forum topics, reply modes, and configuration"
read_when:
  - Configuring Telegram bot integration
  - Setting up forum topic threading
  - Troubleshooting Telegram reply behavior
---
# Telegram Integration

CLAWDBOT connects to Telegram via the [Bot API](https://core.telegram.org/bots/api) using [grammY](https://grammy.dev/).

## Setup

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Copy the token
3. Add to your config:

```json
{
  "telegram": {
    "token": "123456789:ABCdefGHI..."
  }
}
```

Or set `TELEGRAM_BOT_TOKEN` in your environment.

## Forum Topics (Supergroups)

Telegram supergroups can enable **Topics** (forum mode), which creates thread-like conversations within a single group. CLAWDBOT fully supports forum topics:

- **Automatic detection:** When a message arrives from a forum topic, CLAWDBOT automatically routes it to a topic-specific session
- **Thread isolation:** Each topic gets its own conversation context, so the agent maintains separate threads
- **Reply threading:** Replies are sent to the same topic via `message_thread_id`

### Session Routing

Forum topic messages create session keys in the format:
```
telegram:group:<chat_id>:topic:<topic_id>
```

This ensures conversations in different topics remain isolated even within the same supergroup.

## Reply Modes

The `replyToMode` setting controls how the bot replies to messages:

| Mode | Behavior |
|------|----------|
| `"first"` | Reply to the first message in a conversation (default) |
| `"all"` | Reply to every message |
| `"off"` | Send messages without reply threading |

Configure in your config:

```json
{
  "telegram": {
    "replyToMode": "first"
  }
}
```

**Default:** `"first"` — This ensures replies appear threaded in the chat, making conversations easier to follow.

## Access Control

### DM Policy

Control who can DM your bot:

```json
{
  "telegram": {
    "dmPolicy": "pairing",
    "allowFrom": ["123456789", "@username"]
  }
}
```

- `"pairing"` (default): New users get a pairing code to request access
- `"allowlist"`: Only users in `allowFrom` can interact
- `"open"`: Anyone can DM the bot
- `"disabled"`: DMs are blocked

### Group Policy

Control group message handling:

```json
{
  "telegram": {
    "groupPolicy": "open",
    "groupAllowFrom": ["*"],
    "groups": ["-1001234567890"]
  }
}
```

- `groupPolicy`: `"open"` (default), `"allowlist"`, or `"disabled"`
- `groups`: When set, acts as an allowlist of group IDs

## Mention Requirements

In groups, you can require the bot to be mentioned:

```json
{
  "telegram": {
    "requireMention": true
  }
}
```

When `true`, the bot only responds to messages that @mention it or match configured mention patterns.

## Media Handling

Configure media size limits:

```json
{
  "telegram": {
    "mediaMaxMb": 10
  }
}
```

Default: 5MB. Files exceeding this limit are rejected with a user-friendly message.
