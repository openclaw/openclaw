---
name: compound-engineering
description: Make your AI agent learn and improve automatically. Reviews sessions, extracts learnings, updates memory files, and compounds knowledge over time. Set up nightly review loops that make your agent smarter every day.
version: 1.0.0
author: lxgicstudios
keywords: compound, learning, memory, automation, agents, clawdbot, improvement, knowledge
---

# Compound Engineering

Make your AI agent learn automatically. Extract learnings from sessions, update memory files, and compound knowledge over time.

**The idea**: Your agent reviews its own work, extracts patterns and lessons, and updates its instructions. Tomorrow's agent is smarter than today's.

---

## Quick Start

```bash
# Review last 24 hours and update memory
npx compound-engineering review

# Create hourly memory snapshot
npx compound-engineering snapshot

# Set up automated nightly review (cron)
npx compound-engineering setup-cron
```

---

## How It Works

### The Compound Loop

```
┌─────────────────────────────────────────┐
│           DAILY WORK                    │
│  Sessions, chats, tasks, decisions      │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│        NIGHTLY REVIEW (10:30 PM)        │
│  • Scan all sessions from last 24h      │
│  • Extract learnings and patterns       │
│  • Update MEMORY.md and AGENTS.md       │
│  • Commit and push changes              │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│        NEXT DAY                         │
│  Agent reads updated instructions       │
│  Benefits from yesterday's learnings    │
└─────────────────────────────────────────┘
```

### What Gets Extracted

- **Patterns**: Recurring approaches that worked
- **Gotchas**: Things that failed or caused issues
- **Preferences**: User preferences discovered
- **Decisions**: Key decisions and their reasoning
- **TODOs**: Unfinished items to remember

---

## Clawdbot Integration

### Automatic Hourly Memory

Add to your `HEARTBEAT.md`:

```markdown
# Hourly Memory Snapshot
Every hour, append a brief summary to memory/YYYY-MM-DD.md:
- What was accomplished
- Key decisions made
- Anything to remember
```

Or use cron:

```bash
# Add to clawdbot config or crontab
0 * * * * clawdbot cron run compound-hourly
```

### Nightly Review Job

Add this cron job to Clawdbot:

```json
{
  "id": "compound-nightly",
  "schedule": "30 22 * * *",
  "text": "Review all sessions from the last 24 hours. For each session, extract: 1) Key learnings and patterns, 2) Mistakes or gotchas to avoid, 3) User preferences discovered, 4) Unfinished items. Update MEMORY.md with a summary. Update memory/YYYY-MM-DD.md with details. Commit changes to git."
}
```

---

## Manual Review Command

When you want to trigger a review manually:

```
Review the last 24 hours of work. Extract:

1. **Patterns that worked** - approaches to repeat
2. **Gotchas encountered** - things to avoid
3. **Preferences learned** - user likes/dislikes
4. **Key decisions** - and their reasoning
5. **Open items** - unfinished work

Update:
- MEMORY.md with significant long-term learnings
- memory/YYYY-MM-DD.md with today's details
- AGENTS.md if workflow changes needed

Commit changes with message "compound: daily review YYYY-MM-DD"
```

---

## Memory File Structure

### MEMORY.md (Long-term)

```markdown
# Long-Term Memory

## Patterns That Work
- When doing X, always Y first
- User prefers Z approach for...

## Gotchas to Avoid  
- Don't do X without checking Y
- API Z has rate limit of...

## User Preferences
- Prefers concise responses
- Timezone: PST
- ...

## Project Context
- Main repo at /path/to/project
- Deploy process is...
```

### memory/YYYY-MM-DD.md (Daily)

```markdown
# 2026-01-28 (Tuesday)

## Sessions
- 09:00 - Built security audit tool
- 14:00 - Published 40 skills to MoltHub

## Decisions
- Chose to batch publish in parallel (5 sub-agents)
- Security tool covers 6 check categories

## Learnings
- ClawdHub publish can timeout, retry with new version
- npm publish hangs sometimes, may need to retry

## Open Items
- [ ] Finish remaining MoltHub uploads
- [ ] Set up analytics tracker
```

---

## Hourly Snapshots

For more granular memory, create hourly snapshots:

```bash
# Creates memory/YYYY-MM-DD-HH.md every hour
*/60 * * * * echo "## $(date +%H):00 Snapshot" >> ~/clawd/memory/$(date +%Y-%m-%d).md
```

Or have the agent do it via heartbeat by checking time and appending to daily file.

---

## The Compound Effect

**Week 1**: Agent knows basics
**Week 2**: Agent remembers your preferences  
**Week 4**: Agent anticipates your needs
**Month 2**: Agent is an expert in your workflow

Knowledge compounds. Every session makes future sessions better.

---

## Setup Scripts

### Nightly Review (launchd - macOS)

```xml
<!-- ~/Library/LaunchAgents/com.clawdbot.compound-review.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.clawdbot.compound-review</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/clawdbot</string>
    <string>cron</string>
    <string>run</string>
    <string>compound-nightly</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>22</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
</dict>
</plist>
```

### Hourly Memory (crontab)

```bash
# Add with: crontab -e
0 * * * * /opt/homebrew/bin/clawdbot cron run compound-hourly 2>&1 >> ~/clawd/logs/compound.log
```

---

## Best Practices

1. **Review before sleep** - Let the nightly job run when you're done for the day
2. **Don't over-extract** - Focus on significant learnings, not noise
3. **Prune regularly** - Remove outdated info from MEMORY.md monthly
4. **Git everything** - Memory files should be version controlled
5. **Trust the compound** - Effects are subtle at first, dramatic over time

---

Built by **LXGIC Studios** - [@lxgicstudios](https://x.com/lxgicstudios)

---

**Built by LXGIC Studios**

- GitHub: [github.com/lxgicstudios/ai-compound](https://github.com/lxgicstudios/ai-compound)
- Twitter: [@lxgicstudios](https://x.com/lxgicstudios)
