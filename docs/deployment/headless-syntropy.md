# Headless Syntropy Deployment

Deploy OpenClaw as a headless multi-channel chat gateway for Syntropy Health.

## Required Plugins

| Plugin                  | Purpose                                                |
| ----------------------- | ------------------------------------------------------ |
| `persist-user-identity` | User registration, `!verify` command, identity storage |
| `persist-postgres`      | Message persistence                                    |
| `auth-memory-gate`      | Identity hard gate, `[MEMORY_SCOPE]` injection         |
| `syntropy`              | Health tools, token storage, `[SYNTROPY_GATE]`         |
| `memory-graphiti`       | Scoped conversation memory                             |

## Required Channels

At minimum one channel must be enabled:

| Channel      | Config Key               |
| ------------ | ------------------------ |
| WhatsApp     | `channels.whatsapp`      |
| Slack        | `channels.slack`         |
| SMS (Twilio) | `channels.sms` (Phase 5) |

## Environment Variables

| Variable                 | Required    | Description                                          |
| ------------------------ | ----------- | ---------------------------------------------------- |
| `DATABASE_URL`           | Yes         | PostgreSQL connection string (shared by all plugins) |
| `NODE_ENV`               | Yes         | `production`                                         |
| `OPENCLAW_GATEWAY_TOKEN` | Yes         | Gateway auth token                                   |
| LLM API key              | Yes         | Provider-specific (e.g., `ANTHROPIC_API_KEY`)        |
| Channel tokens           | Per channel | `SLACK_BOT_TOKEN`, WhatsApp credentials, etc.        |

**No `OPENCLAW_SERVICE_KEY` needed** — auth is per-user via Syntropy ApiTokens.

## Minimal `openclaw.json`

```json
{
  "channels": {
    "enabled": ["whatsapp"]
  },
  "plugins": {
    "enabled": true,
    "allow": [
      "persist-user-identity",
      "persist-postgres",
      "auth-memory-gate",
      "syntropy",
      "memory-graphiti"
    ],
    "entries": {
      "persist-user-identity": {
        "enabled": true,
        "config": {
          "auth": {
            "mode": "passcode-endpoint",
            "passcodeVerifyUrl": "https://api.syntropyhealth.com/api/ext/pairing/verify",
            "userLookupUrl": "https://api.syntropyhealth.com/api/ext/users/search",
            "apiToken": ""
          }
        }
      },
      "persist-postgres": { "enabled": true, "config": {} },
      "auth-memory-gate": {
        "enabled": true,
        "config": { "hardGate": true, "requireVerified": false }
      },
      "syntropy": {
        "enabled": true,
        "config": { "syntropyBaseUrl": "https://api.syntropyhealth.com" }
      },
      "memory-graphiti": {
        "enabled": true,
        "config": {
          "groupIdStrategy": "identity",
          "autoCapture": true,
          "autoRecall": true,
          "maxFacts": 10
        }
      }
    },
    "slots": { "memory": "memory-graphiti" }
  }
}
```

## Pairing Flow

1. User logs into Syntropy web UI
2. Clicks "Link Device" → sees 6-digit code (10-min TTL)
3. Opens WhatsApp/Slack → types `!verify 482951`
4. OpenClaw calls `POST /api/ext/pairing/verify`
5. Syntropy validates code, issues `ApiToken`, returns `auth_token`
6. OpenClaw stores token in `syntropy_tokens` table
7. User now has full access to 9 health tools via chat

## Database Tables (Auto-Created)

| Table              | Created By            | Purpose                    |
| ------------------ | --------------------- | -------------------------- |
| `lp_users`         | persist-user-identity | Canonical user identity    |
| `lp_user_channels` | persist-user-identity | Channel → user mapping     |
| `lp_conversations` | persist-postgres      | Conversation metadata      |
| `lp_messages`      | persist-postgres      | Message history            |
| `syntropy_tokens`  | syntropy              | Stored API tokens per user |

## Fly.io Deployment

```bash
fly deploy --config fly.toml
fly secrets set DATABASE_URL="postgresql://..." ANTHROPIC_API_KEY="..."
```

The `fly.toml` in the repo root configures:

- App: `shrine-openclaw`
- Region: `iad`
- VM: `shared-cpu-2x`, 2048MB RAM
- Persistent volume: `/data`
