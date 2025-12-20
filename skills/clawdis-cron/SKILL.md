---
name: clawdis-cron
description: Schedule jobs and wakeups via Clawdis Gateway cron.* RPC.
metadata: {"clawdis":{"always":true}}
---

# Clawdis Cron

Cron runs inside the Gateway. Jobs live in `~/.clawdis/cron/jobs.json` and run logs in `~/.clawdis/cron/runs/<jobId>.jsonl`.

Enable/disable
- Enabled by default.
- Disable with config `cron.enabled=false` or env `CLAWDIS_SKIP_CRON=1`.
- Config: `cron.store`, `cron.maxConcurrentRuns`.

RPC methods (Gateway WS)
- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`, `cron.run`, `cron.runs`
- `wake` (enqueue system event + optionally trigger immediate heartbeat)

Payload rules
- `sessionTarget: "main"` requires `payload.kind: "systemEvent"`.
- `sessionTarget: "isolated"` requires `payload.kind: "agentTurn"`.

Examples

One-shot reminder (main session, immediate wake):
```json
{
  "method": "cron.add",
  "params": {
    "name": "remind-me",
    "enabled": true,
    "schedule": { "kind": "at", "atMs": 1734715200000 },
    "sessionTarget": "main",
    "wakeMode": "now",
    "payload": { "kind": "systemEvent", "text": "Remind me in 20 minutes." }
  }
}
```

Recurring hourly check (isolated job, no external delivery):
```json
{
  "method": "cron.add",
  "params": {
    "name": "hourly-check",
    "enabled": true,
    "schedule": { "kind": "every", "everyMs": 3600000 },
    "sessionTarget": "isolated",
    "wakeMode": "now",
    "payload": { "kind": "agentTurn", "message": "Check battery; report only if < 20%.", "deliver": false },
    "isolation": { "postToMainPrefix": "Cron" }
  }
}
```

Cron expression (weekday 07:30):
```json
{
  "method": "cron.add",
  "params": {
    "name": "weekday-wakeup",
    "enabled": true,
    "schedule": { "kind": "cron", "expr": "30 7 * * 1-5", "tz": "America/Los_Angeles" },
    "sessionTarget": "isolated",
    "wakeMode": "now",
    "payload": { "kind": "agentTurn", "message": "Wake me up and start music.", "deliver": true, "channel": "whatsapp" }
  }
}
```

Run history
- `cron.runs` returns recent JSONL entries for a job.

Notes
- `wakeMode: "now"` triggers an immediate heartbeat for main jobs.
- Isolated jobs run in `cron:<jobId>` sessions and post a summary back to main.
