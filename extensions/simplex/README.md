# @effuzion/openclaw-simplex

SimpleX Chat channel plugin for OpenClaw.

**Zero-metadata, decentralized, encrypted messaging.** No user identifiers, no phone numbers, no accounts. Maximum privacy for nation-state-level threat environments.

## Why SimpleX?

- **No user identifiers** — unlike Signal (phone number) or Telegram (phone/username)
- **No central servers** — messages route through relays that can't correlate senders
- **Double ratchet encryption** — forward and backward secrecy
- **No metadata** — relays can't see who talks to whom
- **Open source** — audited cryptography

## Installation

### Option 1: Install from npm (recommended)

```bash
openclaw plugins install @effuzion/openclaw-simplex
```

### Option 2: Local development

```bash
# Clone or place in extensions/simplex
cd extensions/simplex
npm install
```

## Prerequisites

1. Install the SimpleX Chat CLI:

   ```bash
   # Ubuntu/Debian
   curl -L https://github.com/simplex-chat/simplex-chat/releases/latest/download/simplex-chat-ubuntu-22_04-x86-64 -o /usr/local/bin/simplex-chat
   chmod +x /usr/local/bin/simplex-chat

   # macOS
   brew install simplex-chat
   ```

2. Create a SimpleX profile (first time only):

   ```bash
   simplex-chat
   # Follow the prompts to create a profile
   # Then exit with /quit
   ```

3. Start the CLI as a WebSocket server:
   ```bash
   simplex-chat -p 5225
   ```

## Configuration

In your `openclaw.json`:

```json
{
  "channels": {
    "simplex": {
      "enabled": true,
      "name": "OpenClaw Bot",
      "wsPort": 5225,
      "wsHost": "127.0.0.1",
      "dmPolicy": "pairing",
      "allowFrom": []
    }
  },
  "plugins": {
    "entries": {
      "simplex": {
        "enabled": true
      }
    }
  }
}
```

### Configuration Options

| Option      | Default     | Description                                                 |
| ----------- | ----------- | ----------------------------------------------------------- |
| `enabled`   | `true`      | Enable/disable the channel                                  |
| `name`      | `"SimpleX"` | Display name for this account                              |
| `wsPort`    | `5225`      | WebSocket port for simplex-chat CLI                        |
| `wsHost`    | `"127.0.0.1"` | WebSocket host (keep localhost!)                          |
| `dmPolicy`  | `"pairing"` | DM policy: `"open"` or `"pairing"`                         |
| `allowFrom` | `[]`        | Pre-approved contact IDs (bypasses pairing)                |
| `cliPath`   | auto        | Path to simplex-chat binary                                 |
| `dbPath`    | auto        | Path to SimpleX Chat database directory                     |
| `autoStart` | `false`     | Auto-start the CLI process (requires cliPath)              |

## Usage

### Starting the Gateway

```bash
openclaw gateway restart
```

The plugin will connect to the SimpleX CLI WebSocket and start receiving DMs.

### Connecting a Contact

1. Generate a contact link from the bot:
   ```bash
   # In any channel where the bot is present
   /pair simplex
   ```

2. Share the link with your SimpleX app (mobile/desktop)
3. The bot auto-accepts the contact request
4. You can now DM the bot via SimpleX!

### Sending Messages

The bot responds to DMs in the same way as other channels. From any SimpleX contact, send a message and the agent will respond.

### Group Chats

> **Note:** Group chat support is planned for a future release. Currently only DMs are supported.

## Security Notes

- **Always bind to localhost** (`wsHost: "127.0.0.1"`) — the WebSocket has no authentication
- The SimpleX CLI stores keys in `~/.simplex/` — protect this directory
- Use `dmPolicy: "pairing"` to require approval for new contacts
- For maximum security, run the CLI in a separate user/namespace

## Architecture

```
[SimpleX Network]
    │
    ▼
[simplex-chat CLI] ←→ WebSocket ←→ [OpenClaw SimpleX Plugin]
    │                                        │
    ▼                                        ▼
[~/.simplex DB]                    [OpenClaw Gateway]
                                        │
                                        ▼
                                   [Your Agent]
```

## Troubleshooting

### Connection refused

Make sure the SimpleX CLI is running:
```bash
simplex-chat -p 5225
```

### Messages not received

Check the gateway logs:
```bash
openclaw gateway logs | grep simplex
```

### WebSocket errors

Ensure no firewall is blocking localhost:5225

## Development

```bash
# Install dependencies
npm install

# Build (if needed)
npx tsc

# Test locally
cd ../..
openclaw gateway restart
```

## License

MIT

## Contributing

This plugin follows the OpenClaw channel plugin architecture.
See the [Nostr plugin](../nostr) for a similar reference implementation.
