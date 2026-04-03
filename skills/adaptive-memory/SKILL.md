---
name: adaptive-memory
description: Hierarchical memory management for AI agents across sessions. Maintains three layers — daily notes (raw logs), active context (working memory), and long-term memory (curated knowledge) — with automatic distillation from raw notes to permanent memory. Use when setting up persistent memory for an agent workspace, when an agent needs to remember context across sessions or compaction boundaries, when organizing what to remember vs. forget, or when consolidating scattered notes into structured long-term memory. Complements session-recall (which searches memory) by managing what gets stored and how it evolves.
---

# Adaptive Memory

Hierarchical memory management for AI agents. Three layers — daily notes, active context, and long-term memory — with periodic distillation to keep knowledge fresh and relevant.

## Problem This Solves

AI agents lose context between sessions and after context compaction. Without structured memory:
- Decisions get re-debated
- Completed work gets redone
- Lessons learned are forgotten
- Active tasks fall through the cracks

## Memory Architecture

```
memory/
├── YYYY-MM-DD.md          # Daily notes (raw, append-only)
├── active_context.md       # Working memory (current tasks, blockers)
├── channel_context/        # Per-channel conversation summaries (optional)
│   └── {channel-name}.md
└── pending_tasks.json      # Task tracker (structured)

MEMORY.md                   # Long-term memory (curated, distilled)
```

### Layer 1: Daily Notes (`memory/YYYY-MM-DD.md`)

Raw log of what happened each day. Append-only, minimal editing.

```markdown
# 2026-04-01

## Tasks
- Implemented login flow for project X
- Fixed timezone bug in cron scheduler

## Decisions
- Chose SQLite over JSON for data storage (performance at scale)
- API rate limit: 100 req/min with exponential backoff

## Learned
- Library Y requires v3+ for async support
- Browser cookies are not shared across profiles

## Blockers
- Waiting on API key approval from service Z
```

**Rules:**
- Create `memory/` directory if it doesn't exist
- One file per day, named `YYYY-MM-DD.md`
- Append throughout the day, don't restructure
- Include: decisions, discoveries, errors, context that future-you needs
- Exclude: secrets, tokens, passwords, API keys (reference file paths instead)

### Layer 2: Active Context (`memory/active_context.md`)

Working memory — what's in progress right now. Updated as tasks start, complete, or block.

```markdown
# Active Context

## In Progress
- **Project X login flow**: OAuth integration, 70% complete
  - Next: token refresh logic

## Blocked / Waiting
- **API key for service Z**: Requested 2026-03-30, awaiting approval

## Recently Completed
- **Timezone fix**: Deployed, cron jobs now fire correctly (2026-04-01)
```

**Rules:**
- Keep current — stale entries erode trust
- Move completed items to "Recently Completed" (prune after a few days)
- Always check this file at session start — it's the fastest way to resume context
- Any channel, any session should be able to read this and understand what's happening

### Layer 3: Long-Term Memory (`MEMORY.md`)

Curated knowledge distilled from daily notes. The agent's permanent memory.

```markdown
# Long-Term Memory

## Systems Built
- **Data pipeline**: SQLite-based, runs daily at 6 AM, stores in project.db
- **Monitoring**: 3-tier alert system (info → warning → critical)

## Lessons Learned
1. SQLite > JSON for anything over 100 records
2. Always set explicit timeouts on HTTP requests
3. Browser automation: check for virtual scroll before scraping

## Key Decisions
- Chose framework A over B (reason: better async support, MIT license)
- API integration uses webhook push, not polling
```

**Rules:**
- This is curated, not a dump — every entry should justify its space
- Review and update periodically (see [Distillation Cycle](#distillation-cycle))
- Organize by topic, not by date
- No secrets or credentials — reference file paths only (e.g., "Auth: see `~/.secrets/service.env`")

### Optional: Channel Context (`memory/channel_context/{name}.md`)

For multi-channel setups (Slack, Discord, etc.), maintain per-channel summaries so context survives compaction.

```markdown
# channel-name

## Current Topics
- Discussing migration plan for database X
- Reviewing PR #42

## Recent Decisions
- Approved new CI pipeline config (2026-04-01)

## Unresolved
- Performance regression in endpoint /api/users — investigating
```

**Rules:**
- Update at natural conversation boundaries (topic complete, day change)
- Keep concise — this is a summary, not a transcript
- One file per channel

### Optional: Task Tracker (`memory/pending_tasks.json`)

Structured tracking for tasks that must not be forgotten.

```json
{
  "lastUpdated": "2026-04-01T10:00:00Z",
  "tasks": [
    {
      "id": "unique-id",
      "title": "Short description",
      "status": "in_progress",
      "priority": "high",
      "createdAt": "2026-04-01T09:00:00Z",
      "note": "Additional context"
    }
  ]
}
```

Valid statuses: `pending`, `in_progress`, `blocked`, `done`

## Session Start Routine

At the beginning of every session, load context in this order:

1. **`memory/active_context.md`** — what's in progress
2. **`memory/YYYY-MM-DD.md`** (today + yesterday) — recent events
3. **`MEMORY.md`** — long-term knowledge (main/private sessions only)
4. **Channel context** (if applicable) — `memory/channel_context/{name}.md`
5. **`memory/pending_tasks.json`** — unfinished tasks

Do not respond to messages until context is loaded. "I don't know what you're talking about" is never acceptable when the answer is in these files.

## Writing Guidelines

### What to Capture

| Write it down | Skip it |
|---|---|
| Decisions and their reasoning | Routine operations that went smoothly |
| Errors and how they were fixed | Intermediate debugging steps |
| Key facts about the environment | Information already in code comments |
| User preferences and patterns | Temporary values that change hourly |
| Lessons that prevent future mistakes | Obvious things any model would know |

### Security Rules

- **Never write secrets** (API keys, passwords, tokens) to memory files
- Reference paths instead: "Auth config: `~/.secrets/service.env`"
- If a credential appears in chat, acknowledge it without repeating the value
- Memory files may be shared or version-controlled — treat them as semi-public

## Distillation Cycle

Periodically consolidate daily notes into long-term memory. Recommended: weekly or when daily notes accumulate (3+ unprocessed files).

### Four-Phase Process

#### Phase 1: Orient
Read `MEMORY.md` to understand current state. Note what's already captured.

#### Phase 2: Gather
Read recent daily notes (`memory/YYYY-MM-DD.md`) that haven't been consolidated yet.

#### Phase 3: Consolidate
For each daily note, extract what deserves long-term storage:
- New systems or tools built
- Lessons learned (especially from mistakes)
- Decisions with lasting impact
- Changed preferences or workflows
- Facts about the environment that won't change soon

Add these to the appropriate section in `MEMORY.md`.

#### Phase 4: Prune
Remove from `MEMORY.md`:
- Entries that are no longer relevant
- Information superseded by newer entries
- Overly detailed entries that can be summarized

### Tracking Distillation

Record when distillation last ran to avoid redundant work:

In `memory/heartbeat-state.json` (or a similar state file):

```json
{
  "lastConsolidatedAt": "2026-04-01T10:00:00Z"
}
```

### Automation

Distillation can be triggered by:
- **Cron job** — weekly scheduled task (recommended)
- **Heartbeat** — check if 48h+ since last distillation and 3+ unprocessed daily notes
- **Manual** — user requests "consolidate memory" or "review notes"

## Integration with Session-Recall

This skill manages **what gets stored**. A retrieval skill like `session-recall` (which searches transcripts, memory files, and channel context) manages **how to find it**. They complement each other:

- **adaptive-memory** → organizes memory into searchable layers
- **session-recall** → searches those layers when context is missing

Using both together provides full coverage: structured storage + intelligent retrieval.

## Quick Start

1. Initialize the memory directory structure:
   ```bash
   # Using the bundled script (recommended)
   ./scripts/init_memory.sh

   # Or manually
   mkdir -p memory/channel_context
   touch memory/active_context.md
   echo '{"lastUpdated":"","tasks":[]}' > memory/pending_tasks.json
   ```

2. Add to your `AGENTS.md` or session start routine:
   ```
   Before responding, read:
   1. memory/active_context.md
   2. memory/YYYY-MM-DD.md (today + yesterday)
   3. MEMORY.md
   ```

3. Start logging to daily notes as you work

4. Set up weekly distillation (cron, heartbeat, or manual)

The system grows organically from here.

## Production Notes

This skill has been running in a daily-driver OpenClaw setup for 2+ months with:

- 30+ cron jobs across financial tracking, web monitoring, and automation
- 5 Slack channels with per-channel context files
- Daily context compactions survived without losing critical context
- Weekly automated distillation via heartbeat + cron

### Key Findings

- **`active_context.md` is the highest-value file** — it eliminates ~90% of post-compaction confusion. If you adopt only one part of this system, make it this.
- **Channel context becomes essential at 3+ channels** — without it, the agent confuses which conversation happened where after compaction.
- **`pending_tasks.json` catches broken promises** — when the agent says "I'll do that later" in conversation, compaction erases the promise. The task tracker preserves it.
- **Distillation staleness trigger works well** — running on a fixed weekly schedule misses busy weeks. The dual condition (48h+ elapsed AND 3+ unprocessed notes) adapts naturally to workload.
- **Security discipline is critical** — memory files are append-heavy and easy to accidentally fill with credentials. The "reference paths, never values" rule must be enforced from day one.

### Tradeoffs

- **Free-form vs structured L2**: This skill uses free-form `active_context.md`. A more structured template (fixed sections like Current Task, Task Stack, Key Decisions, Active Files, Environment State, Blockers) is more machine-parsable but harder to maintain across diverse workflows. Choose based on your use case.
- **Manual vs automatic checkpointing**: This skill relies on the agent writing to memory files during natural workflow. Automatic checkpoint triggers (e.g., time + message count gates) would reduce the chance of stale active context but add implementation complexity.
