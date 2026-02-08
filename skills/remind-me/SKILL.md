---
name: remind-me
description: Set reminders using natural language. Automatically creates one-time cron jobs and logs to markdown.
metadata: {"clawdbot":{"emoji":"⏰","requires":{"bins":["bash","date"]}}}
---

# Remind Me

Natural language reminders that fire automatically. Uses cron for scheduling, markdown for logging.

## Usage

### One-Time Reminders
Just ask naturally:
- "Remind me to pay for Gumroad later today"
- "Remind me to call mom tomorrow at 3pm"
- "Remind me in 2 hours to check the oven"
- "Remind me next Monday at 9am about the meeting"

### Recurring Reminders
For repeating reminders:
- "Remind me every hour to stretch"
- "Remind me every day at 9am to check email"
- "Remind me every Monday at 2pm about the meeting"
- "Remind me weekly to submit timesheet"

## How It Works

1. Parse the time from your message
2. Create a one-time cron job with `--at`
3. Log to `/home/julian/clawd/reminders.md` for history
4. At the scheduled time, you get a message

## Time Parsing

### One-Time Reminders

**Relative:**
- "in 5 minutes" / "in 2 hours" / "in 3 days"
- "later today" → 17:00 today
- "this afternoon" → 15:00 today
- "tonight" → 20:00 today

**Absolute:**
- "tomorrow" → tomorrow 9am
- "tomorrow at 3pm" → tomorrow 15:00
- "next Monday" → next Monday 9am
- "next Monday at 2pm" → next Monday 14:00

**Dates:**
- "January 15" → Jan 15 at 9am
- "Jan 15 at 3pm" → Jan 15 at 15:00
- "2026-01-15" → Jan 15 at 9am
- "2026-01-15 14:30" → Jan 15 at 14:30

### Recurring Reminders

**Intervals:**
- "every 30 minutes"
- "every 2 hours"

**Daily:**
- "daily at 9am"
- "every day at 3pm"

**Weekly:**
- "weekly" → every Monday at 9am
- "every Monday at 2pm"
- "every Friday at 5pm"

## Reminder Log

All reminders are logged to `/home/julian/clawd/reminders.md`:

```markdown
- [scheduled] 2026-01-06 17:00 | Pay for Gumroad (id: abc123)
- [recurring] every 2h | Stand up and stretch (id: def456)
- [recurring] cron: 0 9 * * 1 | Weekly meeting (id: ghi789)
```

**Status:**
- `[scheduled]` — one-time reminder waiting to fire
- `[recurring]` — repeating reminder (active)
- `[sent]` — one-time reminder already delivered

## Manual Commands

```bash
# List pending reminders
cron list

# View reminder log
cat /home/julian/clawd/reminders.md

# Remove a scheduled reminder
cron rm <job-id>
```

## Agent Implementation

### One-Time Reminders

When the user says "remind me to X at Y":

```bash
bash /home/julian/clawd/skills/remind-me/create-reminder.sh "X" "Y"
```

**Examples:**
```bash
bash /home/julian/clawd/skills/remind-me/create-reminder.sh "Pay for Gumroad" "later today"
bash /home/julian/clawd/skills/remind-me/create-reminder.sh "Call dentist" "tomorrow at 3pm"
bash /home/julian/clawd/skills/remind-me/create-reminder.sh "Check email" "in 2 hours"
```

### Recurring Reminders

When the user says "remind me every X to Y":

```bash
bash /home/julian/clawd/skills/remind-me/create-recurring.sh "Y" "every X"
```

**Examples:**
```bash
bash /home/julian/clawd/skills/remind-me/create-recurring.sh "Stand up and stretch" "every 2 hours"
bash /home/julian/clawd/skills/remind-me/create-recurring.sh "Check email" "daily at 9am"
bash /home/julian/clawd/skills/remind-me/create-recurring.sh "Weekly team meeting" "every Monday at 2pm"
```

Both scripts automatically:
1. Parse the time/schedule
2. Create a cron job (one-time with `--at` or recurring with `--every`/`--cron`)
3. Log to `/home/julian/clawd/reminders.md`
4. Return confirmation with job ID
