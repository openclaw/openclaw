---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Cron jobs + wakeups for the Gateway scheduler"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Scheduling background jobs or wakeups（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Wiring automation that should run with or alongside heartbeats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Deciding between heartbeat and cron for scheduled tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Cron Jobs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Cron jobs (Gateway scheduler)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> **Cron vs Heartbeat?** See [Cron vs Heartbeat](/automation/cron-vs-heartbeat) for guidance on when to use each.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Cron is the Gateway’s built-in scheduler. It persists jobs, wakes the agent at（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the right time, and can optionally deliver output back to a chat.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want _“run this every morning”_ or _“poke the agent in 20 minutes”_,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cron is the mechanism.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Troubleshooting: [/automation/troubleshooting](/automation/troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## TL;DR（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron runs **inside the Gateway** (not inside the model).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Jobs persist under `~/.openclaw/cron/` so restarts don’t lose schedules.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Two execution styles:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - **Main session**: enqueue a system event, then run on the next heartbeat.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - **Isolated**: run a dedicated agent turn in `cron:<jobId>`, with delivery (announce by default or none).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Wakeups are first-class: a job can request “wake now” vs “next heartbeat”.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start (actionable)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create a one-shot reminder, verify it exists, and run it immediately:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron add \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --name "Reminder" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --at "2026-02-01T16:00:00Z" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --session main \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --system-event "Reminder: check the cron docs draft" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --wake now \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --delete-after-run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron run <job-id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron runs --id <job-id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Schedule a recurring isolated job with delivery:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron add \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --name "Morning brief" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --cron "0 7 * * *" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --tz "America/Los_Angeles" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --session isolated \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --message "Summarize overnight updates." \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --announce \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --channel slack \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --to "channel:C1234567890"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool-call equivalents (Gateway cron tool)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For the canonical JSON shapes and examples, see [JSON schema for tool calls](/automation/cron-jobs#json-schema-for-tool-calls).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Where cron jobs are stored（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Cron jobs are persisted on the Gateway host at `~/.openclaw/cron/jobs.json` by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway loads the file into memory and writes it back on changes, so manual edits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
are only safe when the Gateway is stopped. Prefer `openclaw cron add/edit` or the cron（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tool call API for changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Beginner-friendly overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Think of a cron job as: **when** to run + **what** to do.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Choose a schedule**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - One-shot reminder → `schedule.kind = "at"` (CLI: `--at`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Repeating job → `schedule.kind = "every"` or `schedule.kind = "cron"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - If your ISO timestamp omits a timezone, it is treated as **UTC**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Choose where it runs**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `sessionTarget: "main"` → run during the next heartbeat with main context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `sessionTarget: "isolated"` → run a dedicated agent turn in `cron:<jobId>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Choose the payload**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Main session → `payload.kind = "systemEvent"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Isolated session → `payload.kind = "agentTurn"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional: one-shot jobs (`schedule.kind = "at"`) delete after success by default. Set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`deleteAfterRun: false` to keep them (they will disable after success).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Concepts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Jobs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
A cron job is a stored record with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- a **schedule** (when it should run),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- a **payload** (what it should do),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- optional **delivery mode** (announce or none).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- optional **agent binding** (`agentId`): run the job under a specific agent; if（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  missing or unknown, the gateway falls back to the default agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Jobs are identified by a stable `jobId` (used by CLI/Gateway APIs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In agent tool calls, `jobId` is canonical; legacy `id` is accepted for compatibility.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
One-shot jobs auto-delete after success by default; set `deleteAfterRun: false` to keep them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Schedules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Cron supports three schedule kinds:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `at`: one-shot timestamp via `schedule.at` (ISO 8601).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `every`: fixed interval (ms).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron`: 5-field cron expression with optional IANA timezone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Cron expressions use `croner`. If a timezone is omitted, the Gateway host’s（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
local timezone is used.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Main vs isolated execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Main session jobs (system events)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Main jobs enqueue a system event and optionally wake the heartbeat runner.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
They must use `payload.kind = "systemEvent"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wakeMode: "now"` (default): event triggers an immediate heartbeat run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wakeMode: "next-heartbeat"`: event waits for the next scheduled heartbeat.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is the best fit when you want the normal heartbeat prompt + main-session context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Heartbeat](/gateway/heartbeat).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Isolated jobs (dedicated cron sessions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Isolated jobs run a dedicated agent turn in session `cron:<jobId>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Key behaviors:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prompt is prefixed with `[cron:<jobId> <job name>]` for traceability.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Each run starts a **fresh session id** (no prior conversation carry-over).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default behavior: if `delivery` is omitted, isolated jobs announce a summary (`delivery.mode = "announce"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `delivery.mode` (isolated-only) chooses what happens:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `announce`: deliver a summary to the target channel and post a brief summary to the main session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `none`: internal only (no delivery, no main-session summary).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wakeMode` controls when the main-session summary posts:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `now`: immediate heartbeat.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `next-heartbeat`: waits for the next scheduled heartbeat.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use isolated jobs for noisy, frequent, or "background chores" that shouldn't spam（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
your main chat history.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Payload shapes (what runs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Two payload kinds are supported:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `systemEvent`: main-session only, routed through the heartbeat prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agentTurn`: isolated-session only, runs a dedicated agent turn.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common `agentTurn` fields:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message`: required text prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `model` / `thinking`: optional overrides (see below).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timeoutSeconds`: optional timeout override.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Delivery config (isolated jobs only):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `delivery.mode`: `none` | `announce`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `delivery.channel`: `last` or a specific channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `delivery.to`: channel-specific target (phone/chat/channel id).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `delivery.bestEffort`: avoid failing the job if announce delivery fails.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Announce delivery suppresses messaging tool sends for the run; use `delivery.channel`/`delivery.to`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to target the chat instead. When `delivery.mode = "none"`, no summary is posted to the main session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `delivery` is omitted for isolated jobs, OpenClaw defaults to `announce`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Announce delivery flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When `delivery.mode = "announce"`, cron delivers directly via the outbound channel adapters.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The main agent is not spun up to craft or forward the message.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Behavior details:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Content: delivery uses the isolated run's outbound payloads (text/media) with normal chunking and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channel formatting.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeat-only responses (`HEARTBEAT_OK` with no real content) are not delivered.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the isolated run already sent a message to the same target via the message tool, delivery is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  skipped to avoid duplicates.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Missing or invalid delivery targets fail the job unless `delivery.bestEffort = true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A short summary is posted to the main session only when `delivery.mode = "announce"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The main-session summary respects `wakeMode`: `now` triggers an immediate heartbeat and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `next-heartbeat` waits for the next scheduled heartbeat.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Model and thinking overrides（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Isolated jobs (`agentTurn`) can override the model and thinking level:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `model`: Provider/model string (e.g., `anthropic/claude-sonnet-4-20250514`) or alias (e.g., `opus`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `thinking`: Thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; GPT-5.2 + Codex models only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: You can set `model` on main-session jobs too, but it changes the shared main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session model. We recommend model overrides only for isolated jobs to avoid（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
unexpected context shifts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Resolution priority:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Job payload override (highest)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Hook-specific defaults (e.g., `hooks.gmail.model`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Agent config default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Delivery (channel + target)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Isolated jobs can deliver output to a channel via the top-level `delivery` config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `delivery.mode`: `announce` (deliver a summary) or `none`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (plugin) / `signal` / `imessage` / `last`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `delivery.to`: channel-specific recipient target.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Delivery config is only valid for isolated jobs (`sessionTarget: "isolated"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `delivery.channel` or `delivery.to` is omitted, cron can fall back to the main session’s（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
“last route” (the last place the agent replied).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Target format reminders:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack/Discord/Mattermost (plugin) targets should use explicit prefixes (e.g. `channel:<id>`, `user:<id>`) to avoid ambiguity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram topics should use the `:topic:` form (see below).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Telegram delivery targets (topics / forum threads)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Telegram supports forum topics via `message_thread_id`. For cron delivery, you can encode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the topic/thread into the `to` field:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `-1001234567890` (chat id only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `-1001234567890:topic:123` (preferred: explicit topic marker)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `-1001234567890:123` (shorthand: numeric suffix)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Prefixed targets like `telegram:...` / `telegram:group:...` are also accepted:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `telegram:group:-1001234567890:topic:123`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## JSON schema for tool calls（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use these shapes when calling Gateway `cron.*` tools directly (agent tool calls or RPC).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CLI flags accept human durations like `20m`, but tool calls should use an ISO 8601 string（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for `schedule.at` and milliseconds for `schedule.everyMs`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### cron.add params（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
One-shot, main session job (system event):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "name": "Reminder",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "schedule": { "kind": "at", "at": "2026-02-01T16:00:00Z" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "sessionTarget": "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "wakeMode": "now",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "payload": { "kind": "systemEvent", "text": "Reminder text" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "deleteAfterRun": true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recurring, isolated job with delivery:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "name": "Morning brief",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "sessionTarget": "isolated",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "wakeMode": "next-heartbeat",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "payload": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "kind": "agentTurn",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "message": "Summarize overnight updates."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "delivery": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "mode": "announce",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "channel": "slack",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "to": "channel:C1234567890",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "bestEffort": true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `schedule.kind`: `at` (`at`), `every` (`everyMs`), or `cron` (`expr`, optional `tz`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `schedule.at` accepts ISO 8601 (timezone optional; treated as UTC when omitted).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `everyMs` is milliseconds.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessionTarget` must be `"main"` or `"isolated"` and must match `payload.kind`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional fields: `agentId`, `description`, `enabled`, `deleteAfterRun` (defaults to true for `at`),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `delivery`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wakeMode` defaults to `"now"` when omitted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### cron.update params（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "jobId": "job-123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "patch": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "enabled": false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "schedule": { "kind": "every", "everyMs": 3600000 }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `jobId` is canonical; `id` is accepted for compatibility.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `agentId: null` in the patch to clear an agent binding.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### cron.run and cron.remove params（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "jobId": "job-123", "mode": "force" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "jobId": "job-123" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Storage & history（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Job store: `~/.openclaw/cron/jobs.json` (Gateway-managed JSON).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run history: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, auto-pruned).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Override store path: `cron.store` in config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  cron: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    enabled: true, // default true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    store: "~/.openclaw/cron/jobs.json",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    maxConcurrentRuns: 1, // default 1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Disable cron entirely:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron.enabled: false` (config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_SKIP_CRON=1` (env)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI quickstart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
One-shot reminder (UTC ISO, auto-delete after success):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron add \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --name "Send reminder" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --at "2026-01-12T18:00:00Z" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --session main \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --system-event "Reminder: submit expense report." \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --wake now \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --delete-after-run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
One-shot reminder (main session, wake immediately):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron add \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --name "Calendar check" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --at "20m" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --session main \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --system-event "Next heartbeat: check calendar." \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --wake now（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recurring isolated job (announce to WhatsApp):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron add \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --name "Morning status" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --cron "0 7 * * *" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --tz "America/Los_Angeles" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --session isolated \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --message "Summarize inbox + calendar for today." \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --announce \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --channel whatsapp \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --to "+15551234567"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recurring isolated job (deliver to a Telegram topic):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron add \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --name "Nightly summary (topic)" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --cron "0 22 * * *" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --tz "America/Los_Angeles" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --session isolated \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --message "Summarize today; send to the nightly topic." \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --announce \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --channel telegram \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --to "-1001234567890:topic:123"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Isolated job with model and thinking override:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron add \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --name "Deep analysis" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --cron "0 6 * * 1" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --tz "America/Los_Angeles" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --session isolated \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --message "Weekly deep analysis of project progress." \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --model "opus" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --thinking high \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --announce \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --channel whatsapp \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --to "+15551234567"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Agent selection (multi-agent setups):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Pin a job to agent "ops" (falls back to default if that agent is missing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Switch or clear the agent on an existing job（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron edit <jobId> --agent ops（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron edit <jobId> --clear-agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manual run (force is the default, use `--due` to only run when due):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron run <jobId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron run <jobId> --due（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Edit an existing job (patch fields):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron edit <jobId> \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --message "Updated prompt" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --model "opus" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --thinking low（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run history:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron runs --id <jobId> --limit 50（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Immediate system event without creating a job:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw system event --mode now --text "Next heartbeat: check battery."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway API surface（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron.run` (force or due), `cron.runs`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  For immediate system events without a job, use [`openclaw system event`](/cli/system).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### “Nothing runs”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check cron is enabled: `cron.enabled` and `OPENCLAW_SKIP_CRON`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check the Gateway is running continuously (cron runs inside the Gateway process).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For `cron` schedules: confirm timezone (`--tz`) vs the host timezone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### A recurring job keeps delaying after failures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenClaw applies exponential retry backoff for recurring jobs after consecutive errors:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  30s, 1m, 5m, 15m, then 60m between retries.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Backoff resets automatically after the next successful run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- One-shot (`at`) jobs disable after a terminal run (`ok`, `error`, or `skipped`) and do not retry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Telegram delivers to the wrong place（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For forum topics, use `-100…:topic:<id>` so it’s explicit and unambiguous.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you see `telegram:...` prefixes in logs or stored “last route” targets, that’s normal;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  cron delivery accepts them and still parses topic IDs correctly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
