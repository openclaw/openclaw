# @openclaw/synology-chat

Synology Chat channel plugin for OpenClaw. Supports direct messages and channel conversations on DSM 7.x.

## Install (local checkout)

```bash
openclaw plugins install ./extensions/synology-chat
```

## Install (npm)

```bash
openclaw plugins install @openclaw/synology-chat
```

## Prerequisites

- Synology NAS running DSM 7.x with the **Chat Server** package installed
- OpenClaw gateway reachable from the NAS (same network or exposed endpoint)

## Setup: Direct Messages

1. Open **DSM > Chat > Integration > Bots** and create a new bot.
2. Set the **Outgoing Webhook URL** to your OpenClaw webhook endpoint:
   ```
   http://<openclaw-host>:<port>/webhook/synology
   ```
3. Copy the **Bot Token** (64-character string).
4. Copy the **Incoming Webhook URL** (contains `method=chatbot` and a token parameter).
5. Set the environment variables:
   ```bash
   SYNOLOGY_CHAT_TOKEN=<your-bot-token>
   SYNOLOGY_CHAT_INCOMING_URL=<your-incoming-webhook-url>
   ```
6. Restart the gateway.

## Setup: Channel / Group Messages

Synology Chat bots only receive direct messages. To let users talk to the bot in a channel, you need two additional webhooks per channel:

**1. Outgoing Webhook** (receives channel messages):

1. Open **DSM > Chat > Integration > Outgoing Webhooks** and create one.
2. Select the target channel.
3. Set a **Trigger Word** (e.g., `Bot` or `@openclaw`). Only messages starting with this word are forwarded.
4. Set the **URL** to the same OpenClaw webhook endpoint used for the bot.
5. Copy the auto-generated **Token** and set:
   ```bash
   SYNOLOGY_CHANNEL_TOKEN_<channel_id>=<outgoing-webhook-token>
   ```

**2. Incoming Webhook** (sends replies to the channel):

1. Open **DSM > Chat > Integration > Incoming Webhooks** and create one for the same channel.
2. Copy the generated **Webhook URL** and set:
   ```bash
   SYNOLOGY_CHANNEL_WEBHOOK_<channel_id>=<incoming-webhook-url>
   ```

You can find a channel's numeric ID in the DSM Chat URL or via the Synology Chat API.

## Config

Minimal config (DM only):

```json
{
  "channels": {
    "synology-chat": {
      "enabled": true
    }
  }
}
```

Tokens and URLs are read from environment variables. You can also set them directly in the config:

```json
{
  "channels": {
    "synology-chat": {
      "enabled": true,
      "dmPolicy": "allowlist",
      "allowedUserIds": ["101", "102"],
      "groupPolicy": "open",
      "allowInsecureSsl": false
    }
  }
}
```

### Environment Variables

| Variable                        | Required     | Description                                      |
| ------------------------------- | ------------ | ------------------------------------------------ |
| `SYNOLOGY_CHAT_TOKEN`           | Yes          | Bot token from DSM                               |
| `SYNOLOGY_CHAT_INCOMING_URL`    | Yes          | Bot incoming webhook URL                         |
| `SYNOLOGY_CHANNEL_TOKEN_<id>`   | For channels | Outgoing webhook token for channel `<id>`        |
| `SYNOLOGY_CHANNEL_WEBHOOK_<id>` | For channels | Incoming webhook URL for channel `<id>`          |
| `SYNOLOGY_ALLOWED_USER_IDS`     | No           | Comma-separated allowed user IDs                 |
| `SYNOLOGY_RATE_LIMIT`           | No           | Max messages per user per minute (default: `30`) |
| `OPENCLAW_BOT_NAME`             | No           | Display name (default: `OpenClaw`)               |

## Access Control

Two independent policies control who can interact with the bot:

- **`dmPolicy`** -- Controls direct messages. Allowed user IDs in `allowedUserIds`.
- **`groupPolicy`** -- Controls channel messages. Allowed user IDs in `groupAllowFrom`.

Both accept `open`, `allowlist`, or `disabled`. Default: `dmPolicy: "allowlist"`, `groupPolicy: "disabled"`.

**Important:** `groupPolicy` defaults to `disabled`. Set it to `open` or `allowlist` to enable channel support.

## SSL

Synology NAS often uses self-signed certificates on the local network. Set `allowInsecureSsl: true` to skip TLS verification. A warning is emitted at startup when this is enabled.

## Troubleshooting

### Bot not responding to DMs

1. Verify the bot token and incoming URL are correct.
2. Check the outgoing webhook URL in DSM points to your gateway.
3. Look at gateway logs for `[synology-chat]` entries.

### Bot not responding in channels

1. Verify `groupPolicy` is not `disabled`.
2. Check that both `SYNOLOGY_CHANNEL_TOKEN_<id>` and `SYNOLOGY_CHANNEL_WEBHOOK_<id>` are set.
3. Verify the trigger word matches what users type in the channel.
4. Check that the outgoing webhook URL in DSM points to your gateway.

### Self-signed certificate errors

Set `allowInsecureSsl: true` in the channel config.

## Full Documentation

See [Synology Chat channel docs](/docs/channels/synology-chat.md) for advanced configuration, multi-account setup, and security details.
