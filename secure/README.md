# AssureBot

**Lean, secure, self-hosted AI assistant for Railway.**

Your AI agent that runs on your infrastructure, answers only to you, and you can actually audit.

## Why AssureBot?

| Full Moltbot | AssureBot |
|--------------|----------------|
| 12+ channels | Telegram only |
| File-based config | Env vars only |
| Plugins/extensions | None (locked down) |
| Desktop/mobile apps | Headless server |
| Complex setup | One-click deploy |

**Trade-off**: Less features, more trust.

## Features

```
┌─────────────────────────────────────────────────────┐
│  TELEGRAM (your secure UI)                          │
│  ├── Chat with AI (text, voice, images)             │
│  ├── Forward anything → get analysis                │
│  └── /commands for actions                          │
├─────────────────────────────────────────────────────┤
│  WEBHOOKS IN (authenticated)                        │
│  ├── GitHub → "PR merged, here's the summary"       │
│  ├── Uptime → "Site down, checking why..."          │
│  └── Anything → AI-summarized to Telegram           │
├─────────────────────────────────────────────────────┤
│  SCHEDULED TASKS (cron)                             │
│  ├── Morning briefing                               │
│  ├── Monitor RSS/sites                              │
│  └── Recurring research                             │
├─────────────────────────────────────────────────────┤
│  SANDBOX (isolated execution)                       │
│  ├── Docker container                               │
│  ├── No network by default                          │
│  └── Resource limits                                │
└─────────────────────────────────────────────────────┘
```

## Deploy to Railway

### One-Click

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/assurebot)

### Manual

1. Fork this repo
2. Create Railway project from GitHub
3. Set environment variables (see below)
4. Add volume at `/data`
5. Deploy

## Configuration

**All config via environment variables. No files.**

### Required

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...    # From @BotFather
ALLOWED_USERS=123456789,987654321       # Telegram user IDs
ANTHROPIC_API_KEY=sk-ant-...            # Or OPENAI_API_KEY
```

### Optional

```bash
# Webhooks
WEBHOOK_SECRET=random-32-chars          # Auto-generated if missing
WEBHOOK_BASE_PATH=/hooks                # Default: /hooks

# Sandbox
SANDBOX_ENABLED=true                    # Default: true
SANDBOX_NETWORK=none                    # none | bridge
SANDBOX_MEMORY=512m
SANDBOX_CPUS=1
SANDBOX_TIMEOUT_MS=60000

# Scheduler
SCHEDULER_ENABLED=true                  # Default: true

# Audit
AUDIT_ENABLED=true                      # Default: true
AUDIT_LOG_PATH=/data/audit.jsonl

# Server
PORT=8080                               # Railway sets this
HOST=0.0.0.0
```

## Security Model

### What's Enforced

| Control | Implementation |
|---------|----------------|
| **Access** | Telegram user ID allowlist |
| **Auth** | Timing-safe token comparison |
| **Sandbox** | Docker: no network, read-only root, caps dropped |
| **Secrets** | Env-only, auto-redacted in logs |
| **Audit** | Every interaction logged |

### What's NOT Included

Intentionally removed:

- Web UI / setup wizard
- Plugin system
- WhatsApp/Signal/Discord/Slack
- File-based configuration
- Multi-account support
- Desktop/mobile apps

## Run Locally

```bash
cd secure
pnpm install

# Dev mode
TELEGRAM_BOT_TOKEN=xxx \
ANTHROPIC_API_KEY=xxx \
ALLOWED_USERS=123456789 \
pnpm dev

# Production
pnpm build
pnpm start
```

## Endpoints

| Path | Description |
|------|-------------|
| `/health` | Health check (JSON) |
| `/ready` | Readiness probe |
| `/hooks/*` | Webhook receiver (POST, auth required) |

## Webhook Usage

```bash
# Send a webhook
curl -X POST https://your-app.up.railway.app/hooks/github \
  -H "Authorization: Bearer YOUR_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"action": "opened", "pull_request": {"title": "Fix bug"}}'
```

All webhooks are:
1. Authenticated (token required)
2. Summarized by AI
3. Forwarded to all allowed Telegram users

## Audit Log Format

```jsonl
{"ts":"2024-01-15T10:30:00Z","type":"message","userId":123,"text":"Hello","response":"Hi!"}
{"ts":"2024-01-15T10:30:05Z","type":"webhook","path":"/hooks/github","status":200}
{"ts":"2024-01-15T10:30:10Z","type":"sandbox","command":"python -c 'print(1)'","exitCode":0}
```

## Architecture

```
┌────────────────────┐     ┌────────────────────┐
│   moltbot-secure   │────▶│     sandbox        │
│   (main container) │     │  (Docker sidecar)  │
│                    │     │                    │
│  • Telegram bot    │     │  • Isolated exec   │
│  • Webhook recv    │     │  • No network      │
│  • Scheduler       │     │  • Resource limits │
│  • Allowlist auth  │     │  • Ephemeral       │
└────────────────────┘     └────────────────────┘
         │
         ▼
    [Anthropic/OpenAI]
    (Direct API calls)
```

## License

MIT - Same as Moltbot.

---

**Full Moltbot**: [github.com/moltbot/moltbot](https://github.com/moltbot/moltbot)
