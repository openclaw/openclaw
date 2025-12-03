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
