---
name: crontab-helper
description: Explain, generate, validate, and manage cron expressions and crontab entries. Use when the user asks about cron schedules, wants to create a cron job, needs a cron expression explained in plain English, or wants to list/edit their crontab. NOT for: OpenClaw cron jobs (use `openclaw cron` CLI instead).
metadata:
  { "openclaw": { "emoji": "⏰" } }
---

# Crontab Helper

Help users understand and manage Unix cron schedules.

## Capabilities

### 1. Explain a cron expression

Convert cron to plain English:
```
0 9 * * 1-5  →  "Every weekday at 9:00 AM"
*/15 * * * *  →  "Every 15 minutes"
0 0 1 * *    →  "At midnight on the 1st of every month"
```

### 2. Generate from natural language

Convert English to cron:
```
"Every weekday at 9am"        →  0 9 * * 1-5
"Every 6 hours"               →  0 */6 * * *
"First Monday of each month"  →  0 0 * * 1#1 (note: requires cronie or similar)
```

### 3. Validate expressions

Check for common mistakes:
- Invalid ranges (e.g., month 13)
- Conflicting day-of-week and day-of-month
- Non-standard extensions that may not work everywhere

### 4. List/edit crontab

```bash
# List current user's crontab
crontab -l

# Edit (use crontab -e or pipe)
# ALWAYS show the user what will change before modifying
```

## Cron Field Reference

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-7, 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

## Special strings

| String | Equivalent |
|--------|-----------|
| `@yearly` | `0 0 1 1 *` |
| `@monthly` | `0 0 1 * *` |
| `@weekly` | `0 0 * * 0` |
| `@daily` | `0 0 * * *` |
| `@hourly` | `0 * * * *` |
| `@reboot` | Run at startup |

## Safety

- NEVER modify crontab without showing the user what will change
- Always back up existing crontab before editing: `crontab -l > /tmp/crontab.bak`
- Warn about timezone differences (cron uses system timezone)
