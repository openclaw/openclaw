---
name: cron
description: "定时任务。Schedule agent runs and reminders with the Gateway cron. Use when: (1) user asks to run something daily/weekly/at a time, (2) remind me in N minutes, (3) recurring digest or check. Uses openclaw cron add/list/run; no extra install."
metadata:
  {
    "openclaw": { "emoji": "⏰", "requires": {} },
  }
---

# Cron (定时任务)

OpenClaw’s **built-in cron** schedules agent turns and reminders. No skill install; use the `cron` tool or CLI.

## When to use

- “Run this every day at 9am”
- “Remind me in 30 minutes to …”
- “Every Monday send a summary”
- One-shot “run at 3pm tomorrow”

## Tool: cron

The agent can create and manage cron jobs via the **cron** tool (or gateway methods). Typical:

- **Add job:** schedule (cron expr or `--at` ISO time), session (main or isolated), payload (system event or agent turn), optional delivery (e.g. to a channel).
- **List:** list jobs, filter by id/name.
- **Run:** trigger a job once (e.g. `cron run <job-id>`).
- **Delete:** remove after run or on demand.

## CLI (for humans)

```bash
# One-shot reminder (run once at a time)
openclaw cron add --name "Reminder" --at "2026-02-01T16:00:00Z" --session main --system-event "Check the report" --wake now --delete-after-run

# List jobs
openclaw cron list

# Run a job now
openclaw cron run <job-id>
```

## Docs

Full options (recurring, delivery, webhook): [Cron jobs](/automation/cron-jobs).
