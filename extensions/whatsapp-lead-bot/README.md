# WhatsApp Lead Bot Plugin

AI-powered lead qualification bot for WhatsApp with admin commands, rate limiting, and follow-ups.

## Features

- **Automatic Lead Qualification**: Uses LLM to extract location, interest area, budget, and timeline
- **Message Suppression**: Prevents bot-handled messages from wasting LLM tokens
- **Human Handoff Detection**: Auto-detects when account owner or agents take over conversation
- **Admin Commands**: Control leads via WhatsApp (`/status`, `/block`, `/handoff`, etc.)
- **3-Layer Rate Limiting**: Circuit breaker, global limit, and per-lead atomic rate limiting
- **Media Handling**: Acknowledges photos and documents
- **Follow-up System**: Sends gentle reminders to silent leads
- **Agent Notifications**: WhatsApp alerts for new leads, qualified leads, and handoffs

## Configuration

Add to `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "whatsapp-lead-bot": {
        "enabled": true,
        "config": {
          "whatsappAccounts": ["default"],
          "agentNumbers": ["+1234567890"],
          "rateLimit": {
            "enabled": true,
            "messagesPerHour": 10,
            "global": {
              "enabled": true,
              "maxMessagesPerHour": 1000
            },
            "circuitBreaker": {
              "enabled": true,
              "hitRateThreshold": 0.8,
              "minChecks": 10
            }
          },
          "followup": {
            "enabled": true,
            "silenceThresholdHours": 24
          }
        }
      }
    }
  }
}
```

**Configuration Options:**

- `whatsappAccounts`: Array of WhatsApp account IDs to handle (e.g., `["default"]`). Only messages from these accounts will be processed by the bot. Leave empty `[]` to handle all WhatsApp accounts.
- `agentNumbers`: Array of phone numbers to receive notifications
- `dbPath`: Optional custom database path (defaults to `~/.openclaw/whatsapp-lead-bot/leads.db`)
- `rateLimit`: Rate limiting configuration (per-lead, global, circuit breaker)
- `followup`: Follow-up system configuration
- `notifyNewLeads`, `notifyQualified`, `notifyHandoff`: Notification toggles

## Admin Commands

Send from account owner's WhatsApp:

- `/status <phone>` - View lead status
- `/block <phone> [reason]` - Block lead
- `/unblock <phone>` - Unblock lead
- `/handoff <phone>` - Force handoff
- `/clear-limit <phone>` - Clear rate limit
- `/recent [N]` - List recent leads
- `/rate-status` - View rate limit & circuit breaker status
- `/reset-breaker` - Reset circuit breaker (restores bot)
- `/help` - Show commands

## Database

SQLite database at `~/.openclaw/workspace-<name>/whatsapp-lead-bot/leads.db`

Tables:

- `leads` - Lead records with qualification data
- `handoff_log` - Audit trail for all handoff events
- `global_rate_limit` - System-wide message counter (singleton)
- `circuit_breaker` - Emergency stop state (singleton)

## Rate Limiting (3-Layer Defense)

Messages pass through three layers in order. If any denies, the message is suppressed:

1. **Circuit Breaker** — Emergency stop. Monitors the rate-limit hit rate over a 5-minute window. If 80%+ of checks are hits (configurable), all bot responses are suspended system-wide. Sends WhatsApp alert to agents. Reset via `/reset-breaker`.

2. **Global Limit** — System-wide cap of 1000 messages/hour across all leads. Prevents resource exhaustion from Sybil attacks (many unique phone numbers).

3. **Per-Lead Limit** — Atomic check-and-record (single DB transaction) per lead. Default 10 messages/hour. Eliminates TOCTOU race conditions.

All counters are stored in SQLite with transaction-based atomicity.

## Architecture

- **DI Pattern**: All dependencies injected via constructors
- **Interface-based**: Database, LLM, and runtime dependencies use interfaces
- **Composition Root**: All wiring happens in `index.ts`
- **No Conversation Storage**: Only qualification data stored, not full chat history

## Development

```bash
npm install
npm run build
npm run dev   # Watch mode
npm run test  # Run tests
```

## Requirements

- OpenClaw with core patches for message suppression and account owner detection
- WhatsApp channel configured
- Node.js 18+
