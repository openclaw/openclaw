---
summary: "Cron jobs + wakeups for the Gateway scheduler"
read_when:
  - Scheduling background jobs or wakeups
  - Wiring automation that should run with or alongside heartbeats
---
# Cron jobs (Gateway scheduler)

Cron is the Gateway’s built-in scheduler. It persists jobs, wakes the agent at
the right time, and can optionally deliver output back to a chat.

If you want *“run this every morning”* or *“poke the agent in 20 minutes”*,
cron is the mechanism.

## TL;DR
- Cron runs **inside the Gateway** (not inside the model).
- Jobs persist under `~/.clawdbot/cron/` so restarts don’t lose schedules.
- Two execution styles:
  - **Main session**: enqueue a system event, then run on the next heartbeat.
  - **Isolated**: run a dedicated agent turn in `cron:<jobId>`, optionally deliver output.
- Wakeups are first-class: a job can request “wake now” vs “next heartbeat”.

## Concepts

### Jobs
A cron job is a stored record with:
- a **schedule** (when it should run),
- a **payload** (what it should do),
- optional **delivery** (where output should be sent).

Jobs are identified by a stable `jobId` (used by CLI/Gateway APIs).
In agent tool calls, `jobId` is canonical; legacy `id` is accepted for compatibility.

### Schedules
Cron supports three schedule kinds:
- `at`: one-shot timestamp (ms since epoch).
- `every`: fixed interval (ms).
- `cron`: 5-field cron expression with optional IANA timezone.

Cron expressions use `croner`. If a timezone is omitted, the Gateway host’s
local timezone is used.

### Main vs isolated execution

#### Main session jobs (system events)
Main jobs enqueue a system event and optionally wake the heartbeat runner.
They must use `payload.kind = "systemEvent"`.

- `wakeMode: "next-heartbeat"` (default): event waits for the next scheduled heartbeat.
- `wakeMode: "now"`: event triggers an immediate heartbeat run.

This is the best fit when you want the normal heartbeat prompt + main-session context.
See [Heartbeat](/gateway/heartbeat).

#### Isolated jobs (dedicated cron sessions)
Isolated jobs run a dedicated agent turn in session `cron:<jobId>`.

Key behaviors:
- Prompt is prefixed with `[cron:<jobId> <job name>]` for traceability.
- A summary is posted to the main session (prefix `Cron`, configurable).
- `wakeMode: "now"` triggers an immediate heartbeat after posting the summary.
- If `payload.deliver: true`, output is delivered to a provider; otherwise it stays internal.

Use isolated jobs for noisy, frequent, or “background chores” that shouldn’t spam
your main chat history.

### Delivery (provider + target)
Isolated jobs can deliver output to a provider. The job payload can specify:
- `provider`: `whatsapp` / `telegram` / `discord` / `slack` / `signal` / `imessage` / `last`
- `to`: provider-specific recipient target

If `provider` or `to` is omitted, cron can fall back to the main session’s “last route”
(the last place the agent replied).

#### Telegram delivery targets (topics / forum threads)
Telegram supports forum topics via `message_thread_id`. For cron delivery, you can encode
the topic/thread into the `to` field:

- `-1001234567890` (chat id only)
- `-1001234567890:topic:123` (preferred: explicit topic marker)
- `-1001234567890:123` (shorthand: numeric suffix)

Prefixed targets like `telegram:...` / `telegram:group:...` are also accepted:
- `telegram:group:-1001234567890:topic:123`

## Storage & history
- Job store: `~/.clawdbot/cron/jobs.json` (Gateway-managed JSON).
- Run history: `~/.clawdbot/cron/runs/<jobId>.jsonl` (JSONL, auto-pruned).
- Override store path: `cron.store` in config.

## Configuration

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.clawdbot/cron/jobs.json",
    maxConcurrentRuns: 1 // default 1
  }
}
```

Disable cron entirely:
- `cron.enabled: false` (config)
- `CLAWDBOT_SKIP_CRON=1` (env)

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

Recurring isolated job (deliver to a Telegram topic):
```bash
clawdbot cron add \
  --name "Nightly summary (topic)" \
  --cron "0 22 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize today; send to the nightly topic." \
  --deliver \
  --provider telegram \
  --to "-1001234567890:topic:123"
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

## Gateway API surface
- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (force or due), `cron.runs`
- `wake` (enqueue system event + optional heartbeat)

## Troubleshooting

### “Nothing runs”
- Check cron is enabled: `cron.enabled` and `CLAWDBOT_SKIP_CRON`.
- Check the Gateway is running continuously (cron runs inside the Gateway process).
- For `cron` schedules: confirm timezone (`--tz`) vs the host timezone.

### Telegram delivers to the wrong place
- For forum topics, use `-100…:topic:<id>` so it’s explicit and unambiguous.
- If you see `telegram:...` prefixes in logs or stored “last route” targets, that’s normal;
  cron delivery accepts them and still parses topic IDs correctly.
