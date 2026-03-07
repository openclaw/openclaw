# Viber

Connect OpenClaw to Viber using the Viber Bot API.

## Prerequisites

1. A Viber account
2. A Viber Bot token from the [Viber Admin Panel](https://partners.viber.com/)

## Setup

### 1. Create a Viber Bot

1. Go to [partners.viber.com](https://partners.viber.com/)
2. Sign in with your Viber account
3. Create a new bot account
4. Copy the **Auth Token** — you'll need it for configuration

### 2. Configure OpenClaw

Run the setup wizard:

```bash
openclaw setup viber
```

Or manually add to your config:

```yaml
channels:
  viber:
    enabled: true
    token: "your-viber-bot-token"
    name: "My Bot"           # Bot sender name shown in messages
    webhookUrl: "https://your-domain.com/webhook/viber"
```

You can also use an environment variable:

```bash
export VIBER_BOT_TOKEN="your-viber-bot-token"
```

### 3. Webhook Setup

Viber requires a webhook URL for receiving messages. Your OpenClaw gateway must be accessible via HTTPS.

```yaml
channels:
  viber:
    token: "your-token"
    webhookUrl: "https://your-domain.com/webhook/viber"
```

The webhook is automatically registered when the gateway starts.

## Configuration Reference

| Key | Type | Description |
|-----|------|-------------|
| `channels.viber.token` | string | Viber Bot API token |
| `channels.viber.webhookUrl` | string | Public HTTPS URL for receiving webhooks |
| `channels.viber.name` | string | Bot sender name displayed in messages |
| `channels.viber.dmPolicy` | string | DM access policy: `"open"`, `"pairing"`, or `"allowlist"` |
| `channels.viber.allowFrom` | string[] | List of allowed Viber user IDs |
| `channels.viber.enabled` | boolean | Enable/disable the channel |

## Multiple Accounts

```yaml
channels:
  viber:
    enabled: true
    accounts:
      primary:
        token: "token-1"
        name: "Bot One"
        webhookUrl: "https://example.com/webhook/viber/primary"
      secondary:
        token: "token-2"
        name: "Bot Two"
        webhookUrl: "https://example.com/webhook/viber/secondary"
```

## Security

### Webhook Signature Verification

All incoming webhooks are verified using HMAC-SHA256 with the bot token as the key. The signature is sent in the `X-Viber-Content-Signature` header.

### Access Control

Use `dmPolicy` and `allowFrom` to control who can interact with the bot:

- `"open"` — anyone can message the bot
- `"pairing"` — new users must be approved (default)
- `"allowlist"` — only users in `allowFrom` can interact

## Capabilities

| Feature | Supported |
|---------|-----------|
| Direct messages | ✅ |
| Group messages | ❌ |
| Media (images, video, files) | ✅ |
| Reactions | ❌ |
| Threads | ❌ |
| Polls | ❌ |
| Streaming | ❌ |

## Message Types

Viber supports these message types:
- **Text** — plain text (markdown is converted to Viber-friendly formatting)
- **Picture** — images with optional caption
- **Video** — video files with optional caption
- **File** — any file type
- **URL** — clickable links

## Limitations

- Viber bots can only receive 1:1 messages (no group support unless using Public Accounts/Communities)
- Media must be sent as publicly accessible URLs
- Text messages have a 7,000 character limit (auto-chunked)
- Viber does not support markdown formatting natively

## Troubleshooting

### Bot not receiving messages

1. Verify your webhook URL is publicly accessible via HTTPS
2. Check that the token is correct: `openclaw status viber`
3. Ensure the webhook was registered successfully in the gateway logs

### Messages not sending

1. Verify the recipient has subscribed to the bot (sent at least one message)
2. Check the bot token is valid
3. Viber requires users to initiate conversation first
