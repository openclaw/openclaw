# Quick Reference

## TL;DR

Send coding tasks to Cursor AI from WhatsApp/Telegram/Slack. Get PRs back.

```
You: "Fix the login bug @repo:https://github.com/myorg/app"
Bot: "✅ Done! PR: github.com/myorg/app/pull/42"
```

---

## Commands

### Dev Environment

```bash
# Setup (one time)
./dev/setup.sh

# Start mock API (testing without real key)
./dev/mock-cursor.sh

# Start gateway
./dev/start.sh

# Start with mock API
CURSOR_API_BASE_URL=http://localhost:3456 ./dev/start.sh

# Test CLI
./dev/test-cursor.sh list
./dev/test-cursor.sh launch "Add README" https://github.com/test/repo
```

### Testing

```bash
# Run unit tests
npx vitest run extensions/cursor-agent

# Watch mode
npx vitest extensions/cursor-agent

# With coverage
npx vitest run extensions/cursor-agent --coverage
```

---

## Message Syntax

| Format      | Example                                                         |
| ----------- | --------------------------------------------------------------- |
| Basic       | `Fix the bug in utils.ts`                                       |
| With repo   | `@repo:https://github.com/org/repo Fix the bug`                 |
| With branch | `@branch:develop Fix the bug`                                   |
| Both        | `@repo:https://github.com/org/repo @branch:develop Fix the bug` |

---

## Configuration

**Location**: `dev/config/openclaw.json` (dev) or `~/.openclaw/openclaw.json` (prod)

```json
{
  "channels": {
    "cursorAgent": {
      "accounts": {
        "default": {
          "apiKey": "YOUR_API_KEY",
          "repository": "https://github.com/org/repo",
          "branch": "main",
          "webhookUrl": "https://your-gateway/cursor-agent/default/webhook",
          "webhookSecret": "secret-8-chars-min"
        }
      }
    }
  }
}
```

---

## Ports

| Service  | Dev                    | Prod  |
| -------- | ---------------------- | ----- |
| Gateway  | 18790                  | 18789 |
| Mock API | 3456                   | -     |
| WebChat  | http://localhost:18790 | -     |

---

## File Locations

```
extensions/cursor-agent/
├── src/
│   ├── api.ts          # API client
│   ├── plugin.ts       # Main plugin
│   ├── monitor.ts      # Webhook handler
│   ├── outbound.ts     # Send messages
│   └── task-store.ts   # Task tracking
├── scripts/
│   ├── test-api.ts     # CLI tool
│   └── mock-cursor-api.ts
└── *.test.ts           # Tests

dev/
├── config/             # Dev config
├── data/               # Dev data
├── setup.sh            # Init dev env
├── start.sh            # Start gateway
└── mock-cursor.sh      # Mock API
```

---

## API Endpoints

```
POST /v0/agents              # Launch agent
GET  /v0/agents              # List agents
GET  /v0/agents/:id          # Get details
POST /v0/agents/:id/messages # Follow-up
```

---

## Webhook Events

```typescript
{
  event: "statusChange",
  id: "bc_xxx",
  status: "PENDING" | "RUNNING" | "FINISHED" | "ERROR",
  summary?: string,
  target?: {
    prUrl?: string,
    branchName?: string
  }
}
```

---

## Troubleshooting

| Problem           | Solution                              |
| ----------------- | ------------------------------------- |
| Port in use       | `lsof -i :18790` then `kill -9 <PID>` |
| Module not found  | `npm install`                         |
| Invalid signature | Check `webhookSecret` matches         |
| No repository     | Add `@repo:` or set default in config |
| 401 Unauthorized  | Check API key                         |

---

## Links

- [Cursor Dashboard](https://cursor.com/dashboard?tab=background-agents) - Get API key
- [Cursor Docs](https://cursor.com/docs/background-agent/api/) - API reference
- [OpenClaw](https://github.com/openclaw/openclaw) - Main project
- [Webhook.site](https://webhook.site) - Debug webhooks
