# @openclaw/zulip

OpenClaw channel plugin for [Zulip](https://zulip.com/) - the open-source threaded team chat.

## Features

- **Real-time messaging**: Receive messages from Zulip streams and DMs via event queue long-polling
- **Send messages**: Send to streams (with topics) or direct messages
- **Media support**: Upload and send files
- **Multiple accounts**: Configure multiple Zulip bots
- **Security policies**: DM allowlists, group policies, mention requirements

## Installation

```bash
# Via npm
npm install @openclaw/zulip

# Or add to OpenClaw config
openclaw channel add zulip
```

## Configuration

### Via openclaw.json

```json
{
  "channels": {
    "zulip": {
      "enabled": true,
      "baseUrl": "https://your-org.zulipchat.com",
      "email": "bot-email@your-org.zulipchat.com",
      "apiKey": "your-api-key",
      "requireMention": true,
      "dmPolicy": "pairing"
    }
  }
}
```

### Via environment variables

```bash
export ZULIP_URL="https://your-org.zulipchat.com"
export ZULIP_EMAIL="bot-email@your-org.zulipchat.com"  
export ZULIP_API_KEY="your-api-key"
```

### Multiple accounts

```json
{
  "channels": {
    "zulip": {
      "accounts": {
        "work": {
          "baseUrl": "https://work.zulipchat.com",
          "email": "bot@work.zulipchat.com",
          "apiKey": "work-api-key"
        },
        "personal": {
          "baseUrl": "https://personal.zulipchat.com",
          "email": "bot@personal.zulipchat.com",
          "apiKey": "personal-api-key"
        }
      }
    }
  }
}
```

## Getting Your Bot API Key

1. In Zulip, go to **Settings** → **Your bots**
2. Create a new bot or use an existing one
3. Copy the **API key** and **bot email**

Or use the Zulip CLI:
```bash
# Generate API key for your account
curl -u your-email@example.com https://your-org.zulipchat.com/api/v1/fetch_api_key \
  -d password=your-password
```

## Message Targeting

When sending messages, use these formats:

| Format | Description |
|--------|-------------|
| `stream:general:topic` | Send to stream "general" with topic "topic" |
| `dm:12345` | Send DM to user ID 12345 |
| `direct:12345,67890` | Send group DM to multiple users |
| `general:announcements` | Shorthand for stream:general:announcements |

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the channel |
| `baseUrl` | string | - | Zulip server URL |
| `email` | string | - | Bot email address |
| `apiKey` | string | - | Bot API key |
| `name` | string | - | Display name for the account |
| `requireMention` | boolean | `true` | Require @-mention in streams |
| `dmPolicy` | string | `"pairing"` | DM policy: "open", "pairing", "allowlist" |
| `allowFrom` | string[] | `[]` | Allowed sender IDs/emails for DMs |
| `groupPolicy` | string | `"allowlist"` | Stream policy: "open", "allowlist" |
| `groupAllowFrom` | string[] | `[]` | Allowed senders for streams |

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev
```

## License

MIT
