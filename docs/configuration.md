# Configuration Reference

DNA's configuration lives in `~/.dna/dna.json`. This document covers all available options.

## Config File Location

- **macOS/Linux:** `~/.dna/dna.json`
- **Windows (WSL):** `~/.dna/dna.json`
- **Custom:** Set `DNA_CONFIG` environment variable

## Full Config Example

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4",
        "fallbacks": ["openai/gpt-4o"]
      },
      "workspace": "/Users/you/dna-workspace",
      "heartbeat": {
        "every": "1h"
      }
    }
  },
  "channels": {
    "whatsapp": {
      "enabled": true,
      "dmPolicy": "allowlist",
      "allowFrom": ["+1234567890"]
    },
    "telegram": {
      "enabled": true,
      "token": "your-bot-token"
    }
  },
  "tools": {
    "web": {
      "search": {
        "enabled": true,
        "apiKey": "your-brave-api-key"
      }
    }
  },
  "gateway": {
    "port": 18790
  }
}
```

---

## Sections

### `agents`

Controls AI agent behavior.

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4",
        "fallbacks": ["openai/gpt-4o"]
      },
      "workspace": "/path/to/workspace",
      "heartbeat": {
        "every": "1h"
      },
      "maxConcurrent": 4,
      "subagents": {
        "maxConcurrent": 8,
        "model": "anthropic/claude-haiku-3"
      }
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `model.primary` | string | Default model for conversations |
| `model.fallbacks` | array | Backup models if primary fails |
| `workspace` | string | Path to workspace directory |
| `heartbeat.every` | string | How often to run proactive checks |
| `maxConcurrent` | number | Max concurrent agent sessions |
| `subagents.model` | string | Model for background sub-agents |

### `channels`

Configure messaging platform connections.

#### WhatsApp

```json
{
  "channels": {
    "whatsapp": {
      "enabled": true,
      "dmPolicy": "allowlist",
      "allowFrom": ["+1234567890", "+0987654321"],
      "groupPolicy": "allowlist",
      "allowGroups": ["group-id-here"],
      "selfChatMode": true
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable WhatsApp |
| `dmPolicy` | string | `"open"`, `"allowlist"`, or `"block"` |
| `allowFrom` | array | Phone numbers that can DM |
| `groupPolicy` | string | `"open"`, `"allowlist"`, or `"block"` |
| `allowGroups` | array | Group IDs that are allowed |
| `selfChatMode` | boolean | Allow messaging yourself |

#### Telegram

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "token": "123456:ABC-your-bot-token",
      "allowedUsers": [123456789],
      "allowedGroups": [-1001234567890]
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable Telegram |
| `token` | string | Bot token from @BotFather |
| `allowedUsers` | array | User IDs that can message |
| `allowedGroups` | array | Group IDs that are allowed |

#### Discord

```json
{
  "channels": {
    "discord": {
      "enabled": true,
      "token": "your-bot-token",
      "allowedServers": ["server-id"],
      "allowedChannels": ["channel-id"]
    }
  }
}
```

#### Slack

```json
{
  "channels": {
    "slack": {
      "enabled": true,
      "token": "xoxb-your-bot-token",
      "signingSecret": "your-signing-secret"
    }
  }
}
```

### `tools`

Configure built-in tools.

#### Web Search

```json
{
  "tools": {
    "web": {
      "search": {
        "enabled": true,
        "provider": "brave",
        "apiKey": "your-brave-api-key"
      },
      "fetch": {
        "enabled": true,
        "maxSize": "5mb"
      }
    }
  }
}
```

Get a Brave Search API key at: https://brave.com/search/api/

#### Browser

```json
{
  "tools": {
    "browser": {
      "enabled": true,
      "headless": true
    }
  }
}
```

### `gateway`

Gateway server settings.

```json
{
  "gateway": {
    "port": 18790,
    "bind": "loopback",
    "auth": {
      "mode": "token",
      "token": "your-secret-token"
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `port` | number | Port to run on (default 18790) |
| `bind` | string | `"loopback"` (localhost only) or `"all"` |
| `auth.mode` | string | `"token"` or `"none"` |
| `auth.token` | string | Secret token for API access |

### `hooks`

Enable/disable built-in hooks.

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": { "enabled": true },
        "context-monitor": { "enabled": true },
        "command-logger": { "enabled": true }
      }
    }
  }
}
```

### `talk`

Text-to-speech settings.

```json
{
  "talk": {
    "provider": "elevenlabs",
    "apiKey": "your-elevenlabs-key",
    "voice": "rachel"
  }
}
```

---

## Environment Variables

Override config with environment variables:

| Variable | Description |
|----------|-------------|
| `DNA_CONFIG` | Custom config file path |
| `DNA_WORKSPACE` | Override workspace path |
| `DNA_PORT` | Override gateway port |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |

---

## Model Identifiers

Format: `provider/model-name`

### Anthropic
- `anthropic/claude-opus-4`
- `anthropic/claude-sonnet-4`
- `anthropic/claude-haiku-3`

### OpenAI
- `openai/gpt-4o`
- `openai/gpt-4-turbo`
- `openai/gpt-3.5-turbo`

### Google
- `google/gemini-pro`
- `google/gemini-ultra`

### OpenRouter
- `openrouter/anthropic/claude-3-opus`
- `openrouter/openai/gpt-4o`
- `openrouter/meta-llama/llama-3-70b`
- [See all models](https://openrouter.ai/models)

### Ollama (Local)
- `ollama/llama3`
- `ollama/mistral`
- `ollama/codellama`

---

## Validating Config

Check your config for errors:

```bash
./dna.mjs config validate
```

View current config:

```bash
./dna.mjs config show
```

---

## Tips

### Use Different Models for Different Tasks

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4"
      },
      "subagents": {
        "model": "anthropic/claude-haiku-3"
      }
    }
  }
}
```

Main conversations use Sonnet (balanced), background tasks use Haiku (fast/cheap).

### Restrict Access

Always use allowlists in production:

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+1234567890"]
    }
  }
}
```

### Separate Workspace per Project

```bash
DNA_WORKSPACE=~/project-a ./dna.mjs gateway run
```
