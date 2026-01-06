---
summary: "Cron jobs + wakeups for the Gateway scheduler"
read_when:
  - Scheduling background jobs or wakeups
  - Wiring automation that should run with or alongside heartbeats
---
# Cron jobs (Gateway scheduler)

Cron runs inside the Gateway and schedules background work so Clawdbot can
wake itself up, run isolated agent jobs, and deliver reminders on time.

## Update checklist (internal)
- [x] Audit cron + heartbeat behavior in code
- [x] Rewrite cron doc as user-facing feature
- [x] Update heartbeat docs + templates
- [x] Update cron links in docs
- [x] Update changelog
- [x] Run full gate (lint/build/test/docs)

## What cron is
- **Gateway-owned scheduler** that persists jobs under `~/.clawdbot/cron/`.
- **Two execution modes**:
  - **Main session jobs** enqueue `System:` events and rely on the heartbeat runner.
  - **Isolated jobs** run a dedicated agent turn in `cron:<jobId>` sessions.
- **Wakeups** are first-class: a job can trigger the next heartbeat or run it now.

## When to use it
- Recurring reminders: “every weekday at 7:30” or “every 2h.”
- Background chores: summarize inboxes, check dashboards, watch logs.
- Automation that should not pollute the main chat history.
- Scheduled wakeups that drive the heartbeat pipeline.

## Schedules
Cron supports three schedule kinds:
- `at`: one-shot timestamp in ms.
- `every`: fixed interval (ms).
- `cron`: 5-field cron expression, optional IANA timezone.

Cron expressions use `croner` under the hood. If a timezone is omitted, the
server’s local timezone is used.

## Job types

### Main session jobs
Main jobs enqueue a system event and optionally wake the heartbeat runner.
They **must** use `payload.kind = "systemEvent"`.

- **`wakeMode: "next-heartbeat"`** (default): the event waits for the next
  scheduled heartbeat.
- **`wakeMode: "now"`**: the event triggers an immediate heartbeat run.

### Isolated jobs
Isolated jobs run a dedicated agent turn in session `cron:<jobId>` and can
optionally deliver a message.

Key behaviors:
- Prompt is prefixed with `[cron:<jobId> <job name>]` for traceability.
- A summary is posted to the main session with prefix `Cron` (or
  `isolation.postToMainPrefix`).
- `wakeMode: "now"` triggers an immediate heartbeat after posting the summary.
- `payload.deliver: true` sends output to a provider; otherwise it stays internal.

## Storage & history
- Job store: `~/.clawdbot/cron/jobs.json` (JSON, Gateway-managed).
- Run history: `~/.clawdbot/cron/runs/<jobId>.jsonl` (JSONL, auto-pruned).
- Override store path: `cron.store` in config.

## Configuration

```json5
{
  cron: {
    enabled: true,                // default true
    store: "~/.clawdbot/cron/jobs.json",
    maxConcurrentRuns: 1           // default 1
  }
}
```

Disable cron entirely:
- `cron.enabled: false` (config)
- or `CLAWDBOT_SKIP_CRON=1` (env)

## CLI quickstart

One-shot reminder (main session, wake immediately):
```bash
clawdbot cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

Recurring isolated job (deliver to WhatsApp):
```bash
clawdbot cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --deliver \
  --provider whatsapp \
  --to "+15551234567"
```

Manual run (debug):
```bash
clawdbot cron run <jobId> --force
```

Run history:
```bash
clawdbot cron runs --id <jobId> --limit 50
```

Immediate wake without creating a job:
```bash
clawdbot wake --mode now --text "Next heartbeat: check battery."
```

## API surface (Gateway)
- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (force or due), `cron.runs`
- `wake` (enqueue system event + optional heartbeat)

## Tips
- Use **main session jobs** when you want the heartbeat prompt + existing context.
- Use **isolated jobs** for noisy, frequent, or long-running work.
- Keep messages short; cron turns are full agent runs and can burn tokens.
