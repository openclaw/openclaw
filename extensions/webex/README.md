# Cisco Webex Channel Plugin for OpenClaw

This plugin enables bidirectional messaging with Cisco Webex Teams through the Webex bot API. It supports direct messages and group conversations with webhook-based inbound message processing.

## Features

- ✅ **Direct messages** - Private conversations with the bot
- ✅ **Group conversations** - Participate in Webex Teams spaces
- ✅ **Markdown support** - Rich text formatting in messages
- ✅ **File attachments** - Send and receive media files
- ✅ **Webhook integration** - Real-time message delivery via webhooks
- ✅ **Multi-account support** - Manage multiple bot accounts
- ✅ **Pairing system** - Control who can message the bot
- ✅ **Mention detection** - Respond only when mentioned in groups
- ✅ **Thinking indicator** - Shows "🤔 Thinking..." message while processing (automatically deleted when response is ready)

## Prerequisites

1. **Webex Bot Account**: Create a bot at [developer.webex.com](https://developer.webex.com)
2. **Public webhook endpoint**: Accessible URL for receiving webhooks (ngrok, Tailscale, Cloudflare Tunnel, etc.)
3. **OpenClaw**: Version 2026.2.2 or later

## Setup

### 1. Create a Webex Bot

1. Go to [developer.webex.com](https://developer.webex.com)
2. Sign in with your Cisco/Webex account
3. Click "Build Apps" → "Create a New App" → "Create a Bot"
4. Fill in the bot details:
   - **Bot name**: e.g., "OpenClaw Assistant"  
   - **Bot username**: e.g., "openclaw-bot"
   - **Icon**: Upload an icon or use the default
   - **Description**: Brief description of your bot
5. Save the **Bot Access Token** - you'll need this for configuration

### 2. Configure OpenClaw

Add the Webex configuration to your `openclaw.json`:

```json
{
  "channels": {
    "webex": {
      "enabled": true,
      "botToken": "YOUR_BOT_TOKEN",
      "webhookUrl": "https://your-domain.com",
      "webhookPath": "/webex-webhook",
      "webhookSecret": "optional-shared-secret",
      "dmPolicy": "pairing",
      "allowFrom": []
    }
  }
}
```

#### Configuration Options

| Option | Type | Description |
|--------|------|-------------|
| `enabled` | boolean | Enable/disable the Webex channel |
| `botToken` | string | Bot access token from developer.webex.com |
| `tokenFile` | string | Alternative: path to file containing the token |
| `webhookUrl` | string | **Required**: Your public URL (without path) |
| `webhookPath` | string | Webhook endpoint path (default: `/webex-webhook`) |
| `webhookSecret` | string | Optional shared secret for webhook validation |
| `dmPolicy` | string | Direct message policy: `"open"`, `"pairing"`, or `"disabled"` |
| `allowFrom` | array | List of allowed sender emails (for `"open"` policy) |
| `name` | string | Display name for this account |

#### Token Configuration Options

You can provide the bot token in several ways:

1. **Direct in config**: `"botToken": "YOUR_TOKEN"`
2. **File reference**: `"tokenFile": "/path/to/token.txt"`
3. **Environment variable**: Set `WEBEX_BOT_TOKEN` (for default account only)

### 3. Set Up Webhook Endpoint

You need a publicly accessible HTTPS URL for Webex to send webhooks to. Here are common options:

#### Option A: ngrok (Development)

```bash
# Install ngrok and expose your OpenClaw gateway
ngrok http 8080

# Use the HTTPS URL in your config
# webhookUrl: "https://abc123.ngrok.io"
```

#### Option B: Tailscale (Secure)

```bash
# Enable Tailscale Funnel for your OpenClaw instance
tailscale funnel --https=443 8080

# Use your Tailscale hostname
# webhookUrl: "https://your-machine.your-tailnet.ts.net"
```

#### Option C: Cloudflare Tunnel

```bash
# Create a Cloudflare tunnel
cloudflared tunnel create openclaw
cloudflared tunnel route dns openclaw your-domain.com
cloudflared tunnel run --url localhost:8080 openclaw

# Use your domain
# webhookUrl: "https://your-domain.com"
```

#### Option D: Production Server

Deploy OpenClaw on a server with a proper domain and SSL certificate:

```json
{
  "webhookUrl": "https://bot.yourcompany.com"
}
```

### 4. Multi-Account Setup (Optional)

For managing multiple Webex bots:

```json
{
  "channels": {
    "webex": {
      "enabled": true,
      "accounts": {
        "personal": {
          "enabled": true,
          "botToken": "PERSONAL_BOT_TOKEN",
          "webhookUrl": "https://personal.your-domain.com",
          "dmPolicy": "open"
        },
        "work": {
          "enabled": true,
          "botToken": "WORK_BOT_TOKEN", 
          "webhookUrl": "https://work.your-domain.com",
          "dmPolicy": "pairing"
        }
      }
    }
  }
}
```

### 5. Start OpenClaw

```bash
# Restart the gateway to load the new configuration
openclaw gateway restart

# Check channel status
openclaw channels list
openclaw channels status webex
```

## Usage

### Direct Messages

1. **Find your bot** in Webex Teams by searching for the bot name
2. **Send a message** to start a conversation
3. **Pairing** (if enabled): First-time users may need approval

### Group Conversations

1. **Add the bot** to a Webex Teams space
2. **Mention the bot** with `@BotName` to get its attention
3. **Commands and questions** work when the bot is mentioned

### Message Examples

```
# Direct message
Hello! Can you help me with something?

# Group message (mention required)
@openclaw-bot What's the weather like today?

# Commands work in both
/status
```

## Security & Privacy

### DM Policy Options

- **`"pairing"`** (recommended): New users must be approved before they can message the bot
- **`"open"`**: Anyone can message the bot directly
- **`"disabled"`**: No direct messages allowed, group only

### Approval Process (Pairing Mode)

1. User sends their first message
2. Bot responds with pairing instructions and a code
3. Admin approves with: `openclaw pairing approve webex <email> <code>`
4. User is now authorized to message the bot

### Allow List

For `"open"` mode, restrict access to specific users:

```json
{
  "dmPolicy": "open",
  "allowFrom": [
    "alice@company.com",
    "bob@company.com",
    "Y2lzY29zcGFyazovL3VzL1BFT1BMRS8xMjM0NTY3OA"
  ]
}
```

## Troubleshooting

### Common Issues

**❌ "webhookUrl not configured"**
- Solution: Set `channels.webex.webhookUrl` to your public HTTPS URL

**❌ "Webex token not configured"**  
- Solution: Set `botToken`, `tokenFile`, or `WEBEX_BOT_TOKEN` environment variable

**❌ "Bot doesn't respond to messages"**
- Check webhook endpoint is publicly accessible
- Verify webhook secret matches (if configured)
- Check OpenClaw gateway logs: `openclaw gateway logs`

**❌ "HTTP 401: Unauthorized"**
- Verify bot token is correct and hasn't expired
- Regenerate token at developer.webex.com if needed

**❌ "Bot responds to its own messages"**
- This should be automatically prevented - check logs for errors

### Testing Connectivity

```bash
# Test bot token
openclaw channels probe webex

# Check webhook registration
curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://webexapis.com/v1/webhooks

# Test webhook endpoint
curl -X POST https://your-domain.com/webex-webhook
```

### Debug Logs

Enable verbose logging to troubleshoot:

```json
{
  "logging": {
    "level": "debug"
  }
}
```

## Limitations

- **No reactions**: Webex API doesn't support emoji reactions
- **No threads**: Webex Teams doesn't have threaded conversations
- **No native commands**: All commands go through the AI agent
- **File size limits**: Webex has size limits for attachments
- **Rate limiting**: Webex API has rate limits (handled automatically)
- **Webhook delivery**: Must be publicly accessible HTTPS endpoint

## Advanced Configuration

### Custom Webhook Path

```json
{
  "webhookPath": "/my-custom-webex-hook"
}
```

### Webhook Security

```json
{
  "webhookSecret": "your-secure-secret-key"
}
```

The secret is sent by Webex in the `X-Webex-Secret` header and validated by OpenClaw.

### Environment Variables

```bash
# Default account token
export WEBEX_BOT_TOKEN="your-token-here"

# Start OpenClaw
openclaw gateway start
```

## API Reference

### Sending Messages

```bash
# Send to email address
openclaw message send --channel webex --target "user@company.com" --message "Hello!"

# Send to person ID  
openclaw message send --channel webex --target "Y2lzY29zcGFyazovL3VzL1BFT1BMRS8xMjM0" --message "Hi!"

# Send to room/space ID
openclaw message send --channel webex --target "Y2lzY29zcGFyazovL3VzL1JPT00vMTIzNA" --message "Hello room!"

# Send with markdown
openclaw message send --channel webex --target "user@company.com" --message "**Bold** and *italic*"
```

### Managing Accounts

```bash
# List accounts
openclaw channels list webex

# Enable/disable account
openclaw channels enable webex
openclaw channels disable webex personal

# Check status
openclaw channels status webex
```

## Contributing

This plugin is part of the OpenClaw project. To contribute:

1. Fork the [OpenClaw repository](https://github.com/nichochar/openclaw)
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This plugin is licensed under the same terms as OpenClaw.

## Support

- **Documentation**: [OpenClaw Docs](https://docs.openclaw.ai)
- **Community**: [OpenClaw Discord](https://discord.gg/openclaw)
- **Issues**: [GitHub Issues](https://github.com/nichochar/openclaw/issues)
- **Webex API**: [Webex for Developers](https://developer.webex.com)