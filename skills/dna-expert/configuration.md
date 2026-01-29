# Configuration Reference

## Directory Structure

```
~/.dna/
├── dna.json           # Main configuration (JSON5)
├── .env                    # Environment variables (optional)
├── credentials/            # Channel session data (never commit)
├── agents/
│   └── main/
│       └── agent/
│           └── auth-profiles.json  # API keys & OAuth (never commit)
└── cron/
    └── jobs.json           # Scheduled tasks
```

## JSON5 Format

Configuration uses JSON5—comments and trailing commas allowed:

```json
{
  // This is a comment
  "gateway": { "port": 18789, },  // Trailing comma OK
}
```

Unknown keys are rejected (strict validation).

## Environment Variables

**Precedence (highest to lowest):**
1. Process environment (shell, launchd)
2. `.env` from working directory
3. `~/.dna/.env` global fallback
4. Inline `env` block in config (non-overriding)

**Variable substitution:**

```json
{
  "gateway": { "auth": { "token": "${DNA_GATEWAY_TOKEN}" } },
  "channels": { "telegram": { "botToken": "${TELEGRAM_BOT_TOKEN}" } }
}
```

Only uppercase names matching `[A-Z_][A-Z0-9_]*` are interpolated. Missing variables cause load-time errors.

## Modular Config with Includes

```json
{
  "gateway": { "port": 18789 },
  "agents": { "$include": "./agents.json5" },
  "broadcast": { "$include": ["./clients/store1.json5", "./clients/store2.json5"] }
}
```

## Complete Configuration Schema

```json
{
  "gateway": {
    "port": 18789,
    "bind": "loopback",  // or "0.0.0.0" for external access
    "auth": { "token": "${DNA_GATEWAY_TOKEN}" }
  },
  
  "agents": {
    "defaults": {
      "workspace": "~/clawd",
      "model": {
        "primary": "anthropic/claude-opus-4-5",
        "fallbacks": ["anthropic/claude-sonnet-4-5"]
      },
      "thinkingDefault": "low",  // "off", "low", "medium", "high"
      "contextTokens": 200000,
      "memorySearch": {
        "provider": "openai",
        "model": "text-embedding-3-small",
        "query": {
          "hybrid": { "enabled": true, "vectorWeight": 0.7, "textWeight": 0.3 }
        },
        "sync": { "watch": true }
      }
    },
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "Main Agent",
        "workspace": "~/clawd"
      }
    ]
  },
  
  "channels": {
    "whatsapp": {
      "allowFrom": ["+15555550123"],
      "dmPolicy": "pairing"
    },
    "telegram": {
      "botToken": "${TELEGRAM_BOT_TOKEN}"
    },
    "discord": {
      "token": "${DISCORD_BOT_TOKEN}"
    }
  },
  
  "bindings": [
    { "agentId": "main", "match": { "channel": "whatsapp" } }
  ],
  
  "tools": {
    "alsoAllow": ["lobster"]
  },
  
  "sandbox": {
    "mode": "all"  // For group chats
  },
  
  "compaction": {
    "memoryFlush": {
      "enabled": true,
      "systemPrompt": "Session nearing compaction. Store durable memories now."
    }
  }
}
```

## Model Providers

| Provider | Format | Notes |
|----------|--------|-------|
| Anthropic | `anthropic/claude-opus-4-5` | Best security |
| OpenAI | `openai/gpt-4o` | |
| OpenRouter | `openrouter/deepseek/deepseek-r1:free` | Free tier |
| Gemini | `google/gemini-2.0-flash` | |
| Bedrock | `bedrock/anthropic.claude-3-5-sonnet` | |
| Local | `ollama/llama3.3` | Via Ollama/LM Studio |

**Failover behavior:** Rotates through auth profiles first, then falls to next model. Billing failures trigger 5-24 hour backoffs.

## Version Control Best Practices

```gitignore
# .gitignore for DNA configs
~/.dna/.env
~/.dna/credentials/
~/.dna/agents/*/agent/auth-profiles.json
.env
.env.local
```

**Safe to commit:** `dna.json` (with env var substitution), `.env.example`, workspace bootstrap files.
