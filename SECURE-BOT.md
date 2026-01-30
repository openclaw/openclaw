# AssureBot Edition

A lean, secure, self-hosted AI assistant for Railway deployment.

## Philosophy

**Your AI agent that runs on your infrastructure, answers only to you, and you can actually audit.**

- No SaaS middleman
- No data harvesting
- Your keys, your server, your rules

## Core Principles

| Principle | Implementation |
|-----------|----------------|
| **Allowlist-only** | Nobody talks to it unless explicitly approved |
| **Env-var config** | No config files to leak, no filesystem secrets |
| **Audit log** | Every interaction logged, inspectable |
| **No phone-home** | Zero telemetry, no central service |
| **Minimal surface** | Small codebase, few deps, easy to read |
| **Your keys** | Direct to Anthropic/OpenAI, no proxy |

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    ASSUREBOT                          │
│                                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Telegram   │  │   Webhooks   │  │   Scheduler  │     │
│  │   Channel    │  │   Receiver   │  │   (Cron)     │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                 │                 │              │
│         └─────────────────┼─────────────────┘              │
│                           │                                │
│                    ┌──────▼───────┐                        │
│                    │    Agent     │                        │
│                    │    Core      │                        │
│                    └──────┬───────┘                        │
│                           │                                │
│         ┌─────────────────┼─────────────────┐              │
│         │                 │                 │              │
│  ┌──────▼───────┐  ┌──────▼───────┐  ┌──────▼───────┐     │
│  │   AI Model   │  │   Sandbox    │  │   Audit      │     │
│  │   (Direct)   │  │   (Docker)   │  │   Logger     │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└────────────────────────────────────────────────────────────┘
```

## Features

### Telegram (Primary UI)
- Chat with AI (text, voice transcription, images)
- Forward anything for analysis
- Upload docs for Q&A
- `/commands` for quick actions
- **Allowlist-only**: Must be in `ALLOWED_USERS`

### Webhooks (Inbound)
- Authenticated endpoint at `/hooks/*`
- Receive from GitHub, Stripe, uptime monitors, etc.
- AI summarizes and forwards to Telegram
- Bearer token or `X-Moltbot-Token` header auth

### Scheduler (Cron)
- Built-in cron expressions
- Morning briefings, monitors, recurring tasks
- `at:` one-shot scheduling
- `every:` interval scheduling

### Sandbox (Isolated Execution)
- Docker container for code/script execution
- Network isolated by default
- Resource limits (CPU, memory, time)
- Read-only root filesystem
- Ephemeral - destroyed after use

## Configuration

All configuration via environment variables. No config files.

### Required

```bash
# Bot Identity
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

# AI Provider (pick one)
ANTHROPIC_API_KEY=sk-ant-...
# or
OPENAI_API_KEY=sk-...

# Access Control
ALLOWED_USERS=123456789,987654321  # Telegram user IDs
```

### Optional

```bash
# Webhook Authentication
WEBHOOK_SECRET=your-random-32-char-secret

# Gateway Auth (for internal API)
MOLTBOT_GATEWAY_TOKEN=another-random-secret

# Sandbox Settings
SANDBOX_ENABLED=true
SANDBOX_NETWORK=none  # none | bridge
SANDBOX_MEMORY=512m
SANDBOX_CPUS=1

# Audit Logging
AUDIT_LOG_PATH=/data/audit.jsonl
```

## Railway Deployment

### One-Click Deploy

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/moltbot-secure)

### Manual Setup

1. Create new Railway project
2. Add from GitHub repo
3. Set environment variables:
   - `TELEGRAM_BOT_TOKEN`
   - `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
   - `ALLOWED_USERS`
   - `WEBHOOK_SECRET` (recommended)
4. Add volume at `/data` for persistence
5. Deploy

### railway.json

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile.secure"
  },
  "deploy": {
    "healthcheckPath": "/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

## Security Model

### What We Block

- **Unauthorized users**: Only `ALLOWED_USERS` can interact
- **Unauthenticated webhooks**: Require valid token
- **Network in sandbox**: Disabled by default
- **Filesystem access**: Read-only root, tmpfs only
- **Privilege escalation**: All caps dropped
- **Secret leakage**: Automatic redaction in logs

### What We Log

Every interaction is logged to `AUDIT_LOG_PATH`:

```jsonl
{"ts":"2024-01-15T10:30:00Z","type":"message","user":123456789,"text":"...","response":"..."}
{"ts":"2024-01-15T10:30:05Z","type":"webhook","path":"/hooks/github","status":200}
{"ts":"2024-01-15T10:30:10Z","type":"sandbox","command":"python script.py","exit":0}
```

### Threat Model

| Threat | Mitigation |
|--------|------------|
| Unauthorized access | Telegram user ID allowlist |
| Webhook abuse | Bearer token auth, rate limits |
| Code execution escape | Docker isolation, no network, caps dropped |
| Secret exposure | Env-only config, log redaction |
| Model prompt injection | Sandboxed tool execution |

## What's NOT Included

Intentionally removed for security/simplicity:

- Web UI / Setup wizard
- WebSocket device pairing
- Plugin/extension system
- WhatsApp/Signal/iMessage/Discord
- Multi-account support
- Browser automation sandbox
- File-based configuration

## Development

```bash
# Install dependencies
pnpm install

# Run in dev mode
TELEGRAM_BOT_TOKEN=xxx ANTHROPIC_API_KEY=xxx ALLOWED_USERS=123 pnpm dev:secure

# Build
pnpm build:secure

# Test
pnpm test:secure
```

## Directory Structure (Secure Edition)

```
secure/
├── index.ts           # Entry point
├── config.ts          # Env-only config loader
├── telegram.ts        # Telegram bot (grammy)
├── webhooks.ts        # Webhook receiver
├── scheduler.ts       # Cron service
├── sandbox.ts         # Docker sandbox
├── audit.ts           # Audit logger
├── agent.ts           # AI agent core
└── Dockerfile         # Minimal container
```
