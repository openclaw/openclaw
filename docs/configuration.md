# Configuration 🔧

CLAWDIS uses a JSON configuration file at `~/.clawdis/clawdis.json`.

## Minimal Config

```json
{
  "inbound": {
    "allowFrom": ["+436769770569"],
    "reply": {
      "mode": "command",
      "command": ["tau", "{{Body}}"]
    }
  }
}
```

## Full Configuration

```json
{
  "logging": {
    "level": "info",
    "file": "/tmp/clawdis/clawdis.log"
  },
  "inbound": {
    "allowFrom": [
      "+436769770569",
      "+447511247203"
    ],
    "groupChat": {
      "requireMention": true,
      "mentionPatterns": [
        "@clawd",
        "clawdbot",
        "clawd"
      ],
      "historyLimit": 50
    },
    "timestampPrefix": "Europe/London",
    "reply": {
      "mode": "command",
      "agent": {
        "kind": "pi",
        "format": "json"
      },
      "cwd": "/Users/you/clawd",
      "command": [
        "tau",
        "--mode", "json",
        "{{BodyStripped}}"
      ],
      "session": {
        "scope": "per-sender",
        "idleMinutes": 10080,
        "sessionIntro": "You are Clawd. Be a good lobster."
      },
      "heartbeatMinutes": 10,
      "heartbeatBody": "HEARTBEAT",
      "timeoutSeconds": 1800
    }
  }
}
```

## Configuration Options

### `logging`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `level` | string | `"info"` | Log level: trace, debug, info, warn, error |
| `file` | string | `/tmp/clawdis/clawdis.log` | Log file path |

### `inbound.allowFrom`

Array of E.164 phone numbers allowed to trigger the AI. Use `["*"]` to allow everyone (dangerous!).

```json
"allowFrom": ["+436769770569", "+447511247203"]
```

### `inbound.groupChat`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `requireMention` | boolean | `true` | Only respond when mentioned |
| `mentionPatterns` | string[] | `[]` | Regex patterns that trigger response |
| `historyLimit` | number | `50` | Max messages to include as context |

### `inbound.reply`

| Key | Type | Description |
|-----|------|-------------|
| `mode` | string | `"command"` for CLI agents |
| `command` | string[] | Command and args. Use `{{Body}}` for message |
| `cwd` | string | Working directory for the agent |
| `timeoutSeconds` | number | Max time for agent to respond |
| `heartbeatMinutes` | number | Interval for heartbeat pings |
| `heartbeatBody` | string | Message sent on heartbeat |

### Template Variables

Use these in your command:

| Variable | Description |
|----------|-------------|
| `{{Body}}` | Full message body |
| `{{BodyStripped}}` | Message without mention |
| `{{From}}` | Sender phone number |
| `{{SessionId}}` | Current session UUID |

## Session Configuration

```json
"session": {
  "scope": "per-sender",
  "resetTriggers": ["/new"],
  "idleMinutes": 10080,
  "sessionIntro": "You are Clawd.",
  "sessionArgNew": ["--session", "{{SessionId}}.jsonl"],
  "sessionArgResume": ["--session", "{{SessionId}}.jsonl", "--continue"]
}
```

| Key | Type | Description |
|-----|------|-------------|
| `scope` | string | `"per-sender"` or `"global"` |
| `resetTriggers` | string[] | Messages that start a new session |
| `idleMinutes` | number | Session timeout |
| `sessionIntro` | string | System prompt for new sessions |

### Session Isolation and Identity Mapping

By default, sessions are isolated per provider to prevent cross-platform conversation mixing:

**Default behavior (isolated sessions):**
- WhatsApp from `+41791234567` → session key: `+41791234567`
- Telegram from `+41791234567` → session key: `telegram:+41791234567`
- **Separate conversations** - prevents context confusion

**Why isolation matters:**
Without provider prefixes, the same phone number used on both platforms would share conversation history, causing the agent to mix contexts inappropriately (e.g., continuing a Telegram topic when you message from WhatsApp).

**Identity Mapping (optional):**
To intentionally share sessions across providers, create `~/.clawdis/identity-map.json`:

```json
{
  "telegram:+41791234567": "+41791234567",
  "telegram:@username": "+41447511247203"
}
```

This maps Telegram identifiers to their WhatsApp counterparts, allowing the agent to maintain conversation continuity across platforms when desired.

**Provider identifier formats:**
- WhatsApp: `+41791234567` (E.164 phone number)
- Telegram: `telegram:+41791234567` (phone) or `telegram:@username` (username) or `telegram:123456789` (numeric ID)

## Environment Variables

Some settings can also be set via environment:

```bash
export CLAWDIS_LOG_LEVEL=debug
export CLAWDIS_CONFIG_PATH=~/.clawdis/clawdis.json
```

## Migrating from Warelay

If you're upgrading from the old `warelay` name:

```bash
# Move config
mv ~/.warelay ~/.clawdis
mv ~/.clawdis/warelay.json ~/.clawdis/clawdis.json

# Update any hardcoded paths in your config
sed -i '' 's/warelay/clawdis/g' ~/.clawdis/clawdis.json
```

---

*Next: [Agent Integration](./agents.md)* 🦞
