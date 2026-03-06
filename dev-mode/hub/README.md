# Hub - Notification Tool for Agents, Crons, and Apps

Standalone notification hub that runs alongside OpenClaw. Any agent, cron job, or app you build can POST notifications here. The hub stores them, wakes the main agent via OpenClaw's chat API, and the agent forwards via the configured channel.

**Independent** — no OpenClaw code changes needed. Two parts:

1. **Hub server** (`server.py`) — Python HTTP server with SQLite storage
2. **OpenClaw plugin** (`index.ts`) — registers `hub_notify`, `hub_pending`, `hub_done` as native agent tools

---

## Quick Start

```bash
# 1. Start the hub server
cd dev-mode/hub
OPENCLAW_PORT=3000 OPENCLAW_TOKEN=your-token python3 server.py

# 2. Enable the plugin in OpenClaw config
#    Add to plugins.load.paths: ["path/to/dev-mode/hub"]
#    Or symlink into ~/.config/openclaw/extensions/hub
```

Once enabled, agents see three new tools: `hub_notify`, `hub_pending`, `hub_done`.

---

## Agent Tools (Plugin)

The plugin registers these tools that agents can call natively — no curl or exec needed:

### hub_notify

Send a notification through the hub.

| Parameter  | Required | Description                                          |
| ---------- | -------- | ---------------------------------------------------- |
| `message`  | yes      | The notification content                             |
| `source`   | no       | Who is sending (e.g. "daily-digest", "health-check") |
| `title`    | no       | Short title                                          |
| `priority` | no       | `urgent` / `high` / `normal` / `low`                 |

Example agent usage:

```
hub_notify({ message: "Research complete. 5 papers found.", source: "agent:research", priority: "high" })
```

### hub_pending

List all unhandled notifications. No parameters.

### hub_done

Mark a notification as handled.

| Parameter  | Required | Description                  |
| ---------- | -------- | ---------------------------- |
| `id`       | yes      | Notification ID to mark done |
| `response` | no       | What you did about it        |

### Plugin Config

In OpenClaw config under `plugins.entries.hub.config`:

| Key    | Default     | Description     |
| ------ | ----------- | --------------- |
| `host` | `127.0.0.1` | Hub server host |
| `port` | `10020`     | Hub server port |

---

## How It Works — Agent Reaction Flow

> **Key concept:** The Hub does not just store notifications — it forwards them through the OpenClaw gateway API (`/v1/chat/completions`) so they enter the agent's active session as a real message. This means the agent receives the notification in context, can reason about it using its memory and system prompt, and delivers a response through the configured channel (WhatsApp, Telegram, Discord, etc.).
>
> Without this gateway integration, notifications would sit idle in SQLite. The `/v1/chat/completions` call is what bridges external events into the agent's cognitive loop.

```
Your cron / your app / your agent
        |
        |  POST http://localhost:10020/notify
        |  { source, title, message, priority }
        v
   Hub Server (this)
        |
        |  1. Stores in SQLite as "pending"
        |
        |  2. Forwards to OpenClaw gateway:
        |     POST http://localhost:{OPENCLAW_PORT}/v1/chat/completions
        |     Authorization: Bearer {OPENCLAW_TOKEN}
        |     { messages: [{ role: "user", content: "Hub notification: ..." }] }
        |
        v
   OpenClaw Gateway
        |
        |  3. Message enters the agent's active session
        |     - Agent receives it like any other inbound message
        |     - Agent reasons using system prompt + memory + context
        |     - Agent decides how to respond (cognitive decision)
        |
        v
   Channel delivery (configured via HUB_CHANNEL env var)
        |
        |  4. Agent calls hub_done({ id, response }) to close the loop
        v
   Hub marks notification as "done"
```

**Environment variables required for gateway integration:**

| Variable         | Description                                                             |
| ---------------- | ----------------------------------------------------------------------- |
| `OPENCLAW_PORT`  | Gateway port (e.g. `18789`) — must match your `openclaw gateway` config |
| `OPENCLAW_TOKEN` | Gateway auth token — found via `openclaw config get gateway.auth.token` |

Without these, the Hub stores notifications but cannot wake the agent.

---

## API Reference

All endpoints are JSON. Hub listens on `localhost:10020` (internal only).

### POST /notify

Send a notification. Hub stores it and wakes the agent.

```bash
curl -X POST http://localhost:10020/notify \
  -H "Content-Type: application/json" \
  -d '{
    "source": "my-cron-job",
    "title": "Daily Report Ready",
    "message": "The daily AI digest is ready. 3 new items found.",
    "priority": "normal"
  }'
```

**Fields:**

| Field      | Required | Default     | Description                                  |
| ---------- | -------- | ----------- | -------------------------------------------- |
| `message`  | yes      | -           | The notification content                     |
| `source`   | no       | `"unknown"` | Who sent it (your app name, cron name, etc.) |
| `title`    | no       | `""`        | Short title                                  |
| `priority` | no       | `"normal"`  | `urgent` / `high` / `normal` / `low`         |

**Priority levels:**

| Priority | When to use                                                  |
| -------- | ------------------------------------------------------------ |
| `urgent` | Immediate attention — server down, security alert            |
| `high`   | Important but not critical — task failed, threshold exceeded |
| `normal` | Standard notification — report ready, job completed          |
| `low`    | FYI only — background info, stats update                     |

**Response:**

```json
{ "ok": true, "id": 7, "message": "Notification sent to agent" }
```

### POST /done/{id}

Mark a notification as handled. The agent calls this after forwarding the notification.

```bash
curl -X POST http://localhost:10020/done/7 \
  -H "Content-Type: application/json" \
  -d '{ "response": "Forwarded to user" }'
```

### GET /pending

List all unhandled notifications.

```bash
curl http://localhost:10020/pending
```

**Response:**

```json
{
  "notifications": [
    {
      "id": 7,
      "timestamp": "2026-03-06T14:30:00",
      "source": "my-cron-job",
      "title": "Daily Report Ready",
      "message": "The daily AI digest is ready.",
      "priority": "normal",
      "status": "pending",
      "response": null,
      "responded_at": null
    }
  ]
}
```

### GET /history

Last 50 notifications (all statuses).

```bash
curl http://localhost:10020/history
```

### GET /

Status page — pending count + 10 most recent notifications.

---

## Use Cases

### From a cron job

```bash
# In your crontab or OpenClaw cron config
curl -s -X POST http://localhost:10020/notify \
  -H "Content-Type: application/json" \
  -d '{"source":"health-check","message":"All systems operational","priority":"low"}'
```

### From an agent's code/script

When you write a script that an agent runs via `system_run` or `exec`:

```python
import urllib.request, json

def notify_hub(message, source="my-agent", title="", priority="normal"):
    data = json.dumps({"source": source, "title": title, "message": message, "priority": priority}).encode()
    req = urllib.request.Request("http://localhost:10020/notify", data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    urllib.request.urlopen(req)
```

```javascript
// Node.js — no dependencies
const http = require("http");
const data = JSON.stringify({ source: "my-app", message: "Task completed", priority: "normal" });
const req = http.request({
  hostname: "127.0.0.1",
  port: 10020,
  path: "/notify",
  method: "POST",
  headers: { "Content-Type": "application/json", "Content-Length": data.length },
});
req.write(data);
req.end();
```

### From an agent (native tool — with plugin)

With the plugin enabled, agents call hub tools directly:

```
hub_notify({ source: "agent:research", title: "Found results", message: "Research complete. 5 papers found.", priority: "high" })
hub_pending()
hub_done({ id: 7, response: "Forwarded to user" })
```

### From an agent (curl fallback — without plugin)

If the plugin isn't loaded, agents can still use exec/system_run:

```
system_run: curl -s -X POST http://localhost:10020/notify -H "Content-Type: application/json" -d '{"source":"agent:research","title":"Found results","message":"Research complete. 5 papers found matching criteria.","priority":"high"}'
```

---

## Setup

### Requirements

- Python 3.10+ (no pip dependencies — stdlib only)
- OpenClaw running on the same machine with gateway token

### Environment Variables

| Variable         | Default      | Description                                                                       |
| ---------------- | ------------ | --------------------------------------------------------------------------------- |
| `OPENCLAW_HOST`  | `127.0.0.1`  | OpenClaw gateway host                                                             |
| `OPENCLAW_PORT`  | `18789`      | OpenClaw gateway port                                                             |
| `OPENCLAW_TOKEN` | `""`         | Gateway auth token                                                                |
| `OPENCLAW_AGENT` | `agent:main` | Agent model to wake (default value, please update in .env)                        |
| `HUB_CHANNEL`    | `WhatsApp`   | Channel for agent to forward notifications (default value, please update in .env) |

### Run

```bash
cd dev-mode/hub
OPENCLAW_PORT=3000 OPENCLAW_TOKEN=your-token python3 server.py
```

### Run as systemd service

```ini
[Unit]
Description=Notification Hub
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/dev-mode/hub
Environment=OPENCLAW_PORT=3000
Environment=OPENCLAW_TOKEN=your-token
ExecStart=/usr/bin/python3 server.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

---

## Files

```
dev-mode/hub/
  server.py              # Hub HTTP server + SQLite + OpenClaw API integration (~250 lines)
  index.ts               # OpenClaw plugin — registers hub_notify, hub_pending, hub_done tools
  openclaw.plugin.json   # Plugin manifest (id, config schema, UI hints)
  flow-comparison.html   # Visual: Hub API path vs Heartbeat/Cron path
  hub.db                 # SQLite database (created on first run, gitignored)
  hub.log                # Server log (gitignored)
  .gitignore
  README.md              # This file
```

---

## Database Schema

```sql
notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     TEXT NOT NULL,
  source        TEXT NOT NULL,
  title         TEXT,
  message       TEXT NOT NULL,
  priority      TEXT DEFAULT 'normal',    -- urgent/high/normal/low
  status        TEXT DEFAULT 'pending',   -- pending/done
  response      TEXT,                     -- what the agent said/did
  responded_at  TEXT                      -- when marked done
)
```

---

## Flow Comparison

Open `flow-comparison.html` in a browser for a side-by-side visual of how the Hub's API path compares to OpenClaw's built-in Heartbeat/Cron path. Same brain, different plumbing.

---
