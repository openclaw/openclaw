# @openclaw/simplex

SimpleX Chat channel plugin for OpenClaw.

**Zero-metadata, decentralized, encrypted messaging.** No user identifiers, no phone numbers, no accounts. Maximum privacy for nation-state-level threat environments.

## Why SimpleX?

- **No user identifiers** — unlike Signal (phone number) or Telegram (phone/username)
- **No central servers** — messages route through relays that can't correlate senders
- **Double ratchet encryption** — forward and backward secrecy
- **No metadata** — relays can't see who talks to whom
- **Open source** — audited cryptography

## Prerequisites

1. Install the SimpleX Chat CLI:
   ```bash
   # Ubuntu/Debian
   curl -L https://github.com/simplex-chat/simplex-chat/releases/latest/download/simplex-chat-ubuntu-22_04-x86-64 -o /usr/local/bin/simplex-chat
   chmod +x /usr/local/bin/simplex-chat
   ```

2. Create a SimpleX profile:
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
      "wsPort": 5225,
      "wsHost": "127.0.0.1",
      "dmPolicy": "pairing"
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

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable/disable the channel |
| `wsPort` | `5225` | WebSocket port for simplex-chat CLI |
| `wsHost` | `127.0.0.1` | WebSocket host (keep localhost!) |
| `dmPolicy` | `"pairing"` | DM policy: `"open"` or `"pairing"` |
| `allowFrom` | `[]` | Pre-approved contact IDs |
| `cliPath` | auto | Path to simplex-chat binary |
| `autoStart` | `false` | Auto-start the CLI process |

## Connecting

1. Start OpenClaw with SimpleX enabled
2. On your phone/desktop SimpleX app, create a new contact link
3. Share the link with the bot, or use `/pair simplex` in another channel
4. The bot will auto-accept contact requests (pairing handled at OpenClaw level)

## Security Notes

- **Always bind to localhost** (`wsHost: "127.0.0.1"`) — the WebSocket has no auth
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

## Contributing

This plugin follows the OpenClaw channel plugin architecture.
See the [Nostr plugin](../nostr) for a similar reference implementation.
