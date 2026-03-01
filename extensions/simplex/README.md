# @effuzion/openclaw-simplex

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

   # macOS
   brew install simplex-chat
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

## Installation

```bash
# Install via npm (if published)
npm install @effuzion/openclaw-simplex

# Or add to your openclaw.json plugins
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

| Option      | Default     | Description                         |
| ----------- | ----------- | ----------------------------------- |
| `enabled`   | `true`      | Enable/disable the channel          |
| `wsPort`    | `5225`      | WebSocket port for simplex-chat CLI |
| `wsHost`    | `127.0.0.1` | WebSocket host (keep localhost!)    |
| `dmPolicy`  | `"pairing"` | DM policy: `"open"` or `"pairing"`  |
| `allowFrom` | `[]`        | Pre-approved contact IDs            |
| `cliPath`   | auto        | Path to simplex-chat binary         |
| `autoStart` | `false`     | Auto-start the CLI process          |

## Supported Message Types

### Direct Messages (DM)

Send to a contact using `@ContactName`:

```
@alice Hello Alice!
```

### Group Messages

Send to a group using `#GroupName`:

```
#MyGroup Hello everyone!
```

**Note:** The bot must already be a member of the group. Use the SimpleX CLI to join groups:

```
/gjoin <group_name>
```

## Connecting

1. Start OpenClaw with SimpleX enabled
2. On your phone/desktop SimpleX app, create a new contact link
3. Share the link with the bot, or use `/pair simplex` in another channel
4. The bot will auto-accept contact requests (pairing handled at OpenClaw level)

## Media & Files

**Currently not supported.** File/media sending is on the roadmap via the `/file` command.

## Security Notes

- **Always bind to localhost** (`wsHost: "127.0.0.1"`) — the WebSocket has no auth
- The SimpleX CLI stores keys in `~/.simplex/` — protect this directory
- Use `dmPolicy: "pairing"` to require approval for new contacts
- For maximum security, run the CLI in a separate user/namespace

## Troubleshooting

### Connection Refused

Ensure the SimpleX CLI is running with WebSocket enabled:

```bash
simplex-chat -p 5225
```

### TLS/Relay Errors

If you see TLS or relay connection errors:

- These are often transient network issues
- The plugin has automatic reconnection with exponential backoff
- Check your internet connection
- Try: `/connect` in the SimpleX CLI to test relay connectivity

### Messages Not Being Received

1. Check that the CLI is running: `ps aux | grep simplex-chat`
2. Check WebSocket connection: look for "Connected to SimpleX CLI" in logs
3. Verify firewall allows localhost connections

### Group Messages Not Working

- Ensure the bot has joined the group via the CLI: `/gjoin <group_name>`
- Use the group's display name (not the internal ID)
- Groups must be created outside OpenClaw using the CLI or mobile app

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

## API Commands Reference

The plugin uses these SimpleX CLI commands:

| Command            | Description            |
| ------------------ | ---------------------- |
| `@contact message` | Send DM to contact     |
| `#group message`   | Send message to group  |
| `/contacts`        | List contacts          |
| `/groups`          | List groups            |
| `/ac <name>`       | Accept contact request |
| `/gjoin <name>`    | Join group             |

## Contributing

This plugin follows the OpenClaw channel plugin architecture.
See the [Nostr plugin](../nostr) for a similar reference implementation.

---

## Use Cases

### Personal AI Assistant

The routing feature enables powerful personal assistant configurations where different contacts or groups are handled by different AI agents with specific language and voice preferences.

#### Example: Alexandre's Setup

```json
{
  "channels": {
    "simplex": {
      "enabled": true,
      "wsPort": 5225,
      "userRouting": [
        {
          "contactName": "FormidableVisionary",
          "agent": "fiancee-assistant",
          "language": "en",
          "model": "claude-sonnet-4-20250514",
          "voiceReplies": true,
          "includeHistory": true,
          "maxHistoryMessages": 20
        },
        {
          "contactName": "Talleyrand_2010",
          "agent": "digimate",
          "language": "en",
          "voiceReplies": true
        },
        {
          "contactName": "PleasantTeammate",
          "agent": "digimate",
          "language": "en",
          "voiceReplies": true
        }
      ],
      "groupRouting": [
        {
          "groupName": "EffuzionNext",
          "agent": "digimate",
          "language": "fr",
          "voiceReplies": true,
          "memberFilter": ["FormidableVisionary"],
          "priority": 10
        }
      ],
      "defaultAgent": "digimate",
      "defaultLanguage": "fr",
      "defaultVoiceReplies": false
    }
  }
}
```

#### How It Works

- **FormidableVisionary** → Routes to the fiancée assistant with:
  - English (Canadian) language setting
  - Claude Sonnet model
  - Voice replies enabled (TTS)

- **Talleyrand_2010 / PleasantTeammate** → Routes to Digimate main agent:
  - English language
  - Voice replies enabled
  - These are Alexandre's own devices (secondary instances)

- **EffuzionNext group** → Routes based on member:
  - Messages from FormidableVisionary get special handling (English, voice replies)
  - Other members fall through to default agent (Digimate, French)

#### Notes

- The fiancée (FormidableVisionary) speaks English Canadian — configure `language: "en"` and optionally specify a voice model optimized for North American English
- Voice replies require TTS to be configured in OpenClaw's `messages.tts` settings
- Use `memberExclude` to filter out your own devices from group routing (prevents echo loops)
