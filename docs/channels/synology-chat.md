---
summary: "Synology Chat integration via webhooks (DMs and channels)"
read_when:
  - Setting up Synology Chat as a messaging channel
  - Connecting OpenClaw to a Synology NAS
title: "Synology Chat"
---

# Synology Chat (plugin)

Connect OpenClaw to Synology Chat on DSM 7.x. Supports direct messages and channel conversations via webhooks.

## Plugin required

Synology Chat ships as a plugin and is not bundled with the core install.

Install via CLI (npm registry):

```bash
openclaw plugins install @openclaw/synology-chat
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./extensions/synology-chat
```

Details: [Plugins](/tools/plugin)

## Quick setup (DM only)

1. Open **DSM > Chat > Integration > Bots** and create a new bot.
2. Set the **Outgoing Webhook URL** to your OpenClaw webhook endpoint:

   ```text
   http://<openclaw-host>:<port>/webhook/synology
   ```

3. Copy the **Bot Token** (64-character string).
4. Copy the **Incoming Webhook URL** (contains `method=chatbot`).
5. Configure:
   - Env: `SYNOLOGY_CHAT_TOKEN=<bot-token>` and `SYNOLOGY_CHAT_INCOMING_URL=<incoming-url>`
   - Or config: `channels.synology-chat.token` and `channels.synology-chat.incomingUrl`
6. Restart the gateway.

Minimal config:

```json
{
  "channels": {
    "synology-chat": {
      "enabled": true,
      "dmPolicy": "allowlist",
      "allowedUserIds": ["4"]
    }
  }
}
```

## How it works

Synology Chat has three webhook types. This plugin combines them:

- **Bot** (`method=chatbot`): Receives DMs via the bot's outgoing webhook. Replies via the bot's incoming URL with `user_ids` to target the user.
- **Outgoing Webhook**: Receives channel messages matching a trigger word. Each has its own token, which identifies the source channel.
- **Incoming Webhook** (`method=incoming`): Sends replies to channels. Each webhook is tied to a specific channel.

### DM flow

```
User --> DM to bot --> Synology Chat --> POST (bot token) --> OpenClaw
OpenClaw --> chatbot API (user_ids=[userId]) --> Synology Chat --> DM to user
```

### Channel flow

```
User --> "Bot hello" in channel --> Outgoing Webhook --> POST (channel token) --> OpenClaw
OpenClaw --> Incoming Webhook (channel-specific) --> Synology Chat --> Reply in channel
```

## Channel / group setup

Synology Chat bots only receive direct messages. To let users talk to the bot in a channel, create two additional webhooks per channel:

### 1. Outgoing Webhook (receives channel messages)

1. Open **DSM > Chat > Integration > Outgoing Webhooks**, create one.
2. Select the target channel.
3. Set a **Trigger Word** (e.g., `Merlin`). Only messages starting with this word are forwarded.
4. Set the **URL** to the same endpoint used for the bot.
5. Copy the auto-generated **Token**.
6. Set `SYNOLOGY_CHANNEL_TOKEN_<channel_id>=<token>`.

### 2. Incoming Webhook (sends replies to the channel)

1. Open **DSM > Chat > Integration > Incoming Webhooks**, create one for the same channel.
2. Copy the generated **Webhook URL**.
3. Set `SYNOLOGY_CHANNEL_WEBHOOK_<channel_id>=<webhook-url>`.

Enable group support in config:

```json
{
  "channels": {
    "synology-chat": {
      "enabled": true,
      "groupPolicy": "open"
    }
  }
}
```

You can find a channel's numeric ID in the DSM Chat URL or via the Synology Chat API.

## Configuration reference

### Environment variables

| Variable                        | Required     | Description                                      |
| ------------------------------- | ------------ | ------------------------------------------------ |
| `SYNOLOGY_CHAT_TOKEN`           | Yes          | Bot token from DSM                               |
| `SYNOLOGY_CHAT_INCOMING_URL`    | Yes          | Bot incoming webhook URL                         |
| `SYNOLOGY_CHANNEL_TOKEN_<id>`   | For channels | Outgoing webhook token for channel `<id>`        |
| `SYNOLOGY_CHANNEL_WEBHOOK_<id>` | For channels | Incoming webhook URL for channel `<id>`          |
| `SYNOLOGY_ALLOWED_USER_IDS`     | No           | Comma-separated allowed user IDs                 |
| `SYNOLOGY_RATE_LIMIT`           | No           | Max messages per user per minute (default: `30`) |
| `OPENCLAW_BOT_NAME`             | No           | Display name (default: `OpenClaw`)               |

### Config keys

| Key                  | Type     | Default             | Description                          |
| -------------------- | -------- | ------------------- | ------------------------------------ |
| `enabled`            | boolean  | `true`              | Enable/disable channel               |
| `token`              | string   | env var             | Bot token                            |
| `incomingUrl`        | string   | env var             | Bot incoming webhook URL             |
| `webhookPath`        | string   | `/webhook/synology` | HTTP endpoint path                   |
| `dmPolicy`           | string   | `allowlist`         | DM access policy                     |
| `allowedUserIds`     | string[] | `[]`                | Allowed user IDs for DMs             |
| `groupPolicy`        | string   | `disabled`          | Channel access policy                |
| `groupAllowFrom`     | string[] | `[]`                | Allowed user IDs for channels        |
| `channelTokens`      | object   | env vars            | Channel ID to outgoing webhook token |
| `channelWebhooks`    | object   | env vars            | Channel ID to incoming webhook URL   |
| `rateLimitPerMinute` | number   | `30`                | Rate limit per user                  |
| `botName`            | string   | `OpenClaw`          | Display name                         |
| `allowInsecureSsl`   | boolean  | `false`             | Skip TLS verification                |

Environment variables take lowest priority. Config values override them, and per-account overrides take highest priority.

## Access control

### DM policies

- **`allowlist`** (default): Only user IDs in `allowedUserIds` can DM the bot.
- **`open`**: Any Synology Chat user can DM the bot.
- **`disabled`**: Ignore all DMs.

### Group policies

- **`disabled`** (default): Ignore all channel messages.
- **`allowlist`**: Only user IDs in `groupAllowFrom` can trigger the bot in channels.
- **`open`**: Any user in the channel can trigger the bot.

### Example: allowlist for both DM and channels

```json
{
  "channels": {
    "synology-chat": {
      "enabled": true,
      "dmPolicy": "allowlist",
      "allowedUserIds": ["4", "5"],
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["4", "5"]
    }
  }
}
```

## Multi-account support

Use `channels.synology-chat.accounts` with per-account overrides. See [`gateway/configuration`](/gateway/configuration) for the shared pattern.

```json
{
  "channels": {
    "synology-chat": {
      "enabled": true,
      "accounts": {
        "home-nas": {
          "token": "<home-bot-token>",
          "incomingUrl": "<home-incoming-url>",
          "dmPolicy": "open"
        },
        "work-nas": {
          "token": "<work-bot-token>",
          "incomingUrl": "<work-incoming-url>",
          "dmPolicy": "allowlist",
          "allowedUserIds": ["201"]
        }
      }
    }
  }
}
```

## SSL / self-signed certificates

Synology NAS often uses self-signed certificates on the local network. Set `allowInsecureSsl: true` to skip TLS verification. A security warning is logged at startup.

## Troubleshooting

### Bot not responding to DMs

- Verify the bot token and incoming URL are correct.
- Check the outgoing webhook URL in DSM points to your gateway.
- Ensure `dmPolicy` is not `disabled`.
- Check gateway logs: `docker logs openclaw-gateway --since 60s | grep synology`

### Bot not responding in channels

- Verify `groupPolicy` is set to `open` or `allowlist` (default is `disabled`).
- Check that both `SYNOLOGY_CHANNEL_TOKEN_<id>` and `SYNOLOGY_CHANNEL_WEBHOOK_<id>` are set.
- Verify the trigger word in the outgoing webhook matches what users type.
- Check the outgoing webhook URL in DSM points to your gateway.

### "Processing..." appears but no reply

- The immediate "Processing..." is the webhook acknowledgement.
- Check gateway logs for agent errors or timeouts.
- Verify the agent model is reachable (Ollama, etc.).

### Self-signed certificate errors

Set `allowInsecureSsl: true` in the channel config.

## Security

- Token validation uses constant-time HMAC comparison to prevent timing attacks.
- User input is sanitized for prompt injection patterns and truncated at 4000 characters.
- Trigger words are stripped before delivery to the agent.
- Rate limiting: sliding window per user ID (default 30/min).
- Never commit tokens to git. Use environment variables.

## Formatting limits

Synology Chat has limited formatting compared to Slack or Discord:

- No markdown, bold, italic, or code blocks.
- Links: use `<URL|display text>` syntax.
- File sharing: include a publicly accessible URL.
- Messages are auto-chunked at 2000 characters.

## Limitations

- No thread support.
- No reactions, message editing, or reply quoting.
- No streaming (responses sent as complete messages).
- Channel messages require explicit trigger words.
