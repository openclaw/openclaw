---
title: "Observability"
summary: "Structured logging, metrics, tracing strategy, alert definitions, and dashboard guidance for OpenClaw"
read_when:
  - Adding logging or metrics to new code
  - Diagnosing a production issue
  - Setting up monitoring or alerting for a deployment
---

# Observability

## Strategy

OpenClaw uses a structured, log-first observability approach suited to
single-user and small-team deployments. Instrumentation is built into the
gateway and channel layers; consumers choose their own aggregation backend
(file-based, remote syslog, Loki, Datadog, etc.).

### Three pillars

| Pillar | Tool / surface | Notes |
|---|---|---|
| **Logs** | Structured JSON / text to stdout + rotating log files | Primary signal; always on |
| **Metrics** | `openclaw health --json` snapshot; channel health counts | Pull-based; suitable for cron-driven alerting |
| **Traces** | Agent run IDs, session IDs, channel correlation IDs | Embedded in log lines; no distributed tracing backend required |

---

## Logging

### Where logs go

- Gateway log: `/tmp/openclaw/openclaw-<pid>.log` (default; configure with `gateway.logFile`)
- On macOS: also captured by `scripts/clawlog.sh` via the unified log subsystem
- Docker: stdout/stderr (captured by Docker log driver)

### Log structure

Every significant event includes a subset of these fields:

| Field | Example | Notes |
|---|---|---|
| `ts` | `2026-04-15T12:00:00.000Z` | ISO 8601 timestamp |
| `level` | `info`, `warn`, `error` | Severity |
| `channel` | `whatsapp`, `telegram`, `discord` | Channel name when applicable |
| `accountId` | `wa-123abc` | Channel account identifier |
| `sessionId` | `session-xyz` | Agent session ID |
| `runId` | `run-abc` | Agent inference run ID |
| `msg` | `"channel reconnected"` | Human-readable message |
| `err` | `{ code, message, stack }` | Structured error when present |

### Tailing logs in production

```bash
# macOS — real-time via unified log
./scripts/clawlog.sh --follow

# Linux — gateway log file
tail -f /tmp/openclaw/openclaw-*.log

# Docker
docker compose logs -f gateway
```

### Key log patterns to watch

| Pattern | Meaning | Action |
|---|---|---|
| `web-heartbeat` | WhatsApp heartbeat | Normal; alerts if absent > 10 min |
| `web-reconnect` | WhatsApp reconnect | Expected on network blip |
| `channel reconnected` | Any channel reconnect | Normal recovery |
| `channel failed` | Unrecoverable channel failure | Run `openclaw channels login` |
| `agent run error` | Agent inference failure | Check model provider status |
| `compaction triggered` | Session compaction | Normal for long sessions |
| `auth rotated` | Bearer secret rotated | Verify active sessions still authenticated |
| `secret resolved` | SecretRef resolved at runtime | Debug: verify correct secret is loading |

---

## Metrics

OpenClaw exposes a pull-based health snapshot via the CLI and WS gateway method.

### Pull health snapshot

```bash
# Human-readable
openclaw health --verbose

# Machine-readable (for cron / alerting scripts)
openclaw health --json
```

### Health snapshot fields

```json
{
  "ok": true,
  "ts": "2026-04-15T12:00:00.000Z",
  "durationMs": 120,
  "channels": {
    "whatsapp": { "status": "connected", "accountId": "..." },
    "telegram": { "status": "connected", "accountId": "..." }
  },
  "agents": { "available": true },
  "sessions": { "count": 3, "activeCount": 1 }
}
```

### Recommended alerting thresholds

| Signal | Threshold | Suggested action |
|---|---|---|
| `ok: false` | Any occurrence | Page on-call; run `openclaw health --verbose` |
| Channel `status != "connected"` | > 5 min | Run channel reconnect runbook |
| `durationMs` > 5000 | Sustained | Gateway overloaded; check CPU/memory |
| Agent `available: false` | Any occurrence | Check model provider key / quota |
| Log error rate | > 5 errors / min (rolling) | Check error context; may be auth or provider issue |

### Cron-based health alerting (example)

```bash
#!/usr/bin/env bash
# /etc/cron.d/openclaw-health — runs every 5 minutes
# Requires: jq (apt install jq / brew install jq)
RESULT=$(openclaw health --json 2>/dev/null)
OK=$(echo "$RESULT" | jq -r '.ok // false')
if [ "$OK" != "true" ]; then
  # Send alert via your preferred channel (e.g., curl to a webhook, or openclaw message send)
  echo "OpenClaw health check failed" | mail -s "ALERT: OpenClaw down" ops@example.com
fi
```

---

## Tracing

Agent runs and channel events are traced via embedded IDs in log lines:

- `runId` — unique per agent inference run; correlate tool calls to the triggering message
- `sessionId` — correlates all runs in a session; stable across compaction
- `accountId` — channel account; correlate inbound events to channel state

To trace a specific issue:

1. Find the relevant `runId` or `sessionId` in logs
2. Filter all log lines for that ID: `grep "run-abc" /tmp/openclaw/openclaw-*.log`
3. Check the corresponding session transcript: `openclaw sessions view <sessionId>`

---

## Dashboards

For self-hosted single-user deployments, a simple shell dashboard is often sufficient.

### Quick dashboard (terminal)

```bash
# Channel + agent status
openclaw status --all

# Live gateway health
openclaw health --verbose

# Recent session activity
openclaw sessions list --limit 10

# Tail logs with key event filter
./scripts/clawlog.sh --follow | grep -E "error|reconnect|failed|compaction"
```

### Remote monitoring (optional)

For VPS or team deployments, push health JSON to a time-series database:

- **Prometheus + Grafana**: Write a small exporter that calls `openclaw health --json`
  on a cron and exposes a `/metrics` endpoint in Prometheus text format.
- **Datadog / Loki**: Ship the gateway log file via the platform agent using structured
  log parsing (parse `ts`, `level`, `channel`, `err.code`).
- **Uptime monitors**: Hit `http://localhost:18789/health` (if enabled via config) from
  an external checker. The endpoint returns `{ "ok": true }` when the gateway is up.

---

## Alert runbook links

Every alert should link to a runbook entry. See [Runbooks](./runbooks.md) for the
step-by-step response guides keyed to common alert conditions.
