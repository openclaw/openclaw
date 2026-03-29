---
name: deepsleep
description: Two-phase daily memory persistence for AI agents. Nightly pack at 23:40 plus morning dispatch at 00:10. Auto-discovers sessions, filters by importance, tracks open questions, and delivers per-group morning briefs.
---

# DeepSleep

Two-phase daily memory persistence for AI agents.

Like humans need sleep for memory consolidation, AI agents need DeepSleep to persist context across sessions.

## When to Activate

Activate when user mentions daily summary, memory persistence, sleep cycle, cross-session memory, morning brief, or nightly pack.

## Phases

### Phase 1: Deep Sleep Pack (23:40)

1. **Auto-discover sessions** — Use `sessions_list(kinds=['group'], activeMinutes=1440)` to find all active groups and DMs from the past 24 hours. New groups are automatically included.
2. **Pull conversation history** — For each active session, use `sessions_history(sessionKey=<key>, limit=100)`.
3. **Filter and summarize** — Apply filtering criteria to generate concise summaries:
   - Keep: Decisions, Lessons, Preferences, Relationships, Milestones
   - Skip: Transient (heartbeats, weather), Already captured in MEMORY.md
4. **Schedule future items** — Extract future-dated reminders and write to `memory/schedule.md` with trigger dates.
5. **Write daily file** — Append to `memory/YYYY-MM-DD.md` with sections: per-group summaries, Open Questions, Tomorrow actions, and Todos.
6. **Update long-term memory** — Merge-update `MEMORY.md` (update in place, don't append duplicates; remove outdated info).

### Phase 2: Morning Dispatch (00:10)

1. **Read yesterday's summary** — Load `memory/YYYY-MM-DD.md` from the previous day.
2. **Send per-group briefs** — For each group with content, send a personalized morning recap via `message(action='send', target='chat:<id>')`.
3. **Include reminders** — Attach any schedule items due today.
4. **Track open questions** — Include relevant Open Questions for continuity.

## Daily Summary Template

```markdown
## Daily Summary (DeepSleep)

### [Group Name]
- Concise summary of key discussions and decisions

### Direct Messages
- (DM content if any)

### Open Questions
- Unresolved questions, tracked across days

### Tomorrow
- Actionable next steps

### Todo
- [ ] Immediate action items
```

## Schedule File Format

File: `memory/schedule.md`

```markdown
| Date | Source | Item | Status |
|------|--------|------|--------|
| YYYY-MM-DD | Group/DM | Description | pending/done |
```

## Setup

### 1. Create cron jobs

```bash
# Phase 1: Pack
openclaw cron add \
  --name "deepsleep-pack" \
  --cron "40 23 * * *" \
  --tz "Your/Timezone" \
  --system-event "Execute DeepSleep Phase 1. Read the deepsleep skill and follow the pack process." \
  --timeout-seconds 180

# Phase 2: Dispatch
openclaw cron add \
  --name "deepsleep-dispatch" \
  --cron "10 0 * * *" \
  --tz "Your/Timezone" \
  --system-event "Execute DeepSleep Phase 2. Read the deepsleep skill and follow the dispatch process." \
  --timeout-seconds 120
```

### 2. Enable cross-session visibility

```bash
openclaw config set tools.sessions.visibility all
openclaw gateway restart
```

### 3. Initialize schedule

Create `memory/schedule.md` with the table header above.

## Requirements

- OpenClaw with `tools.sessions.visibility` set to `all`
- Cron jobs using `systemEvent` mode (main session access)

## Inspirations

Built with insights from the community: agent-sleep (multi-level sleep), memory-reflect (filtering criteria), jarvis-memory-architecture (cron inbox), memory-curator (open questions).
