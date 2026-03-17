---
summary: "Wakeup script best practices — avoid silent agent wake failures"
read_when:
  - Writing shell scripts that need to trigger the agent
  - Debugging why scheduled tasks create files but the agent never processes them
  - Using inbox patterns or file-based task queues
title: "Wakeup Scripts"
---

# Wakeup Script Best Practices

A common automation pattern is writing shell scripts that create task files
(reminders, inbox items, reports) and expect the agent to pick them up.

**The pitfall**: the script runs, the file is created, but the agent never
wakes up to process it. Everything looks fine in the logs — except nothing
actually happens.

This guide covers why that happens and how to fix it.

## The Problem

The agent doesn't automatically watch or poll the filesystem. Dropping a file
into an inbox directory does **not** trigger a session. The agent only acts
when it receives an explicit signal — a message, a cron event, or a heartbeat.

### ❌ Broken Pattern

```bash
#!/bin/bash
# Creates a reminder file — but nobody reads it

INBOX_DIR="$HOME/.openclaw/workspace/inbox"
mkdir -p "$INBOX_DIR"

REMINDER="$INBOX_DIR/task-$(date +%Y%m%d-%H%M).md"

cat > "$REMINDER" << 'EOF'
# Deploy Reminder
Push the staging branch to production before 5 PM.
EOF

echo "$(date) — Reminder created" >> /tmp/wake.log
# ⚠️  Script exits. Agent is still asleep.
```

**Result**: Files pile up in `inbox/`. The agent has no idea they exist.

## The Fix

After creating the file, send an explicit wake signal so the agent actually
processes it.

### ✅ Pattern 1: Wake Event (Recommended)

Use `openclaw wake` to poke the agent in its current (main) session:

```bash
#!/bin/bash
INBOX_DIR="$HOME/.openclaw/workspace/inbox"
mkdir -p "$INBOX_DIR"

REMINDER="$INBOX_DIR/task-$(date +%Y%m%d-%H%M).md"

cat > "$REMINDER" << 'EOF'
# Deploy Reminder
Push the staging branch to production before 5 PM.
EOF

# Wake the agent so it sees the new file
openclaw wake --mode now --text "New task in inbox — please process"
```

The `--mode now` flag wakes the agent immediately rather than waiting for the
next heartbeat cycle.

### ✅ Pattern 2: Cron Job (Scheduled)

If you want the agent to check the inbox on a schedule rather than
immediately, create a cron job:

```bash
openclaw cron add \
  --name "Inbox check" \
  --cron "*/30 * * * *" \
  --session isolated \
  --agent-turn "Check the inbox directory for new task files and process them" \
  --delivery announce
```

This runs every 30 minutes in an isolated session and announces the result
back to your chat.

### ✅ Pattern 3: System Event (Main Session)

Inject a system event into the main session. The agent will see it on its
next turn:

```bash
openclaw cron add \
  --name "Process inbox" \
  --at "$(date -u -d '+1 min' +%Y-%m-%dT%H:%M:%SZ)" \  # GNU/Linux; on macOS use: date -u -v+1M
  --session main \
  --system-event "New files in inbox — check and process" \
  --wake now \
  --delete-after-run
```

This is a one-shot: it fires once, wakes the agent immediately, and
cleans itself up.

### ✅ Pattern 4: Heartbeat Integration

If you already have heartbeat polling enabled, add an inbox check to your
`HEARTBEAT.md`:

```markdown
# HEARTBEAT.md

- Check `inbox/` for new task files. Process any found, then delete them.
```

No script changes needed — the agent picks up new files on its next
heartbeat cycle (typically every 15–30 minutes). The tradeoff is latency:
files sit unprocessed until the next poll.

## Choosing the Right Approach

| Approach        | Latency   | Complexity | Best For                               |
| --------------- | --------- | ---------- | -------------------------------------- |
| `openclaw wake` | Immediate | Low        | One-off scripts, urgent tasks          |
| Cron (isolated) | Scheduled | Medium     | Recurring checks, batch processing     |
| System event    | Immediate | Medium     | Programmatic triggers from other tools |
| Heartbeat       | Minutes   | Lowest     | Low-priority, can tolerate delay       |

**Rule of thumb**: If the task is time-sensitive, wake the agent explicitly.
If it can wait, let heartbeat or cron handle it.

## Verification

After setting up your wakeup script, confirm the agent actually responds:

1. **Check agent logs**:

   ```bash
   openclaw status
   ```

   Look for a recent session turn triggered by your wake event.

2. **Check cron history** (if using cron):

   ```bash
   openclaw cron runs --id <job-id>
   ```

3. **Check the inbox** — processed files should be gone (or marked done,
   depending on your agent's instructions).

## Common Mistakes

| Mistake                       | Symptom                                        | Fix                                              |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| No wake signal                | Files accumulate, agent silent                 | Add `openclaw wake` after file creation          |
| Wrong `--mode`                | Agent wakes on next heartbeat, not immediately | Use `--mode now` for urgent tasks                |
| Script runs as different user | `openclaw` command not found or auth fails     | Run as the same user that owns the gateway       |
| Inbox path mismatch           | Agent checks wrong directory                   | Use absolute paths; match what the agent expects |
| No cleanup                    | Agent reprocesses old files every cycle        | Delete or move files after processing            |

## Full Example: Daily Report Script

A complete wakeup script that generates a daily report and ensures the agent
processes it:

```bash
#!/bin/bash
set -euo pipefail

WORKSPACE="$HOME/.openclaw/workspace"
INBOX="$WORKSPACE/inbox"
LOG="/tmp/openclaw-wake.log"

mkdir -p "$INBOX"

# Generate the report
REPORT="$INBOX/daily-report-$(date +%Y%m%d).md"
cat > "$REPORT" << EOF
# Daily Report — $(date +%Y-%m-%d)

## System Status
- Disk: $(df -h / | awk 'NR==2{print $5}') used
- Memory: $(free -h 2>/dev/null | awk '/Mem/{print $3"/"$2}' || echo "N/A")  # free is Linux-only
- Uptime: $(uptime -p)

## Action Items
- Review and summarize this report
- Flag anything unusual
- Send summary to chat
EOF

echo "$(date) — Report created: $REPORT" >> "$LOG"

# Wake the agent
openclaw wake --mode now \
  --text "Daily report ready in inbox — please review and send summary"

echo "$(date) — Agent wake signal sent" >> "$LOG"
```

Add this to your system crontab to run daily:

```cron
0 9 * * * /home/user/scripts/daily-report.sh
```

## See Also

- [Cron Jobs](/automation/cron-jobs) — built-in scheduler for recurring tasks
- [Cron vs Heartbeat](/automation/cron-vs-heartbeat) — when to use which
- [Hooks](/automation/hooks) — event-driven automation for agent lifecycle
- [Troubleshooting](/automation/troubleshooting) — debugging automation issues
