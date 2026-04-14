---
name: autoresearch
description: Use to run the autonomous morning self-improvement loop that tunes OpenClaw skill descriptions for routing accuracy. Triggers 10:30 AM–12:00 PM when a Claude Code session starts. Also use manually via `node loop.mjs --dry-run` for testing.
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["node", "git"] },
        "install": []
      }
  }
---

# Autoresearch

Autonomous self-improvement loop for OpenClaw skill descriptions.

## Morning run (automatic)
Triggered by OnSessionStart hook between 10:30 AM and 12:00 PM. Runs two phases:
1. Max OAuth: 15 Opus + 5 Sonnet experiments
2. Raw API (Sonnet): additional experiments until $4 cap

Produces `reports/YYYY-MM-DD-report.pdf`, auto-opens, awaits approval via link buttons.

## Manual invocation

```bash
# Dry run (no edits, just scores the pool)
node skills/autoresearch/loop.mjs --dry-run

# Force a run outside the morning window
node skills/autoresearch/loop.mjs --force

# Approve yesterday's run from CLI
node skills/autoresearch/loop.mjs --approve 2026-04-14

# Reject
node skills/autoresearch/loop.mjs --reject 2026-04-14
```

## Panic switch

```bash
touch ~/.autoresearch/STOP   # loop refuses to run until this is deleted
```
