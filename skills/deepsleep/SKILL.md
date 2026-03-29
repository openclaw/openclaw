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

1. **Auto-discover sessions** — Use `sessions_list(kinds=['group', 'main'], activeMinutes=1440)` to find all active groups AND direct messages from the past 24 hours. New groups are automatically included.
2. **Pull conversation history** — For each active session, use `sessions_history(sessionKey=<key>, limit=100)`.
3. **Filter and summarize** — Apply filtering criteria to generate concise summaries:
   - Keep: Decisions, Lessons, Preferences, Relationships, Milestones
   - Skip: Transient (heartbeats, weather), Already captured in MEMORY.md
4. **Schedule future items** — Extract future-dated reminders and write to `memory/schedule.md` with trigger dates.
5. **Write daily file (idempotent)** — Write the `## Daily Summary (DeepSleep)` section to `memory/YYYY-MM-DD.md`. Before writing, check if a `## Daily Summary (DeepSleep)` header already exists for today — if so, replace it instead of appending a duplicate. This ensures retries and re-runs produce the same result.
6. **Update long-term memory (privacy-safe)** — Merge-update `MEMORY.md` (update in place, don't append duplicates; remove outdated info). **Important:** Do NOT copy private MEMORY.md content into the daily summary file. The daily file may be broadcast to groups in Phase 2 — only include information that originated from those groups' own conversations.

### Phase 2: Morning Dispatch (00:10)

1. **Read yesterday's summary** — Load `memory/YYYY-MM-DD.md` from the previous day.
2. **Send per-group briefs** — For each group with content, send a personalized morning recap via `message(action='send', target='chat:<id>')`. Only include information from that specific group's summary — never cross-leak content between groups or from MEMORY.md.
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
# Phase 1: Pack (adjust timeout for your session count; ~30s per active session)
openclaw cron add \
  --name "deepsleep-pack" \
  --cron "40 23 * * *" \
  --tz "Your/Timezone" \
  --system-event "Execute DeepSleep Phase 1. Read the deepsleep skill and follow the pack process." \
  --timeout-seconds 300

# Phase 2: Dispatch
openclaw cron add \
  --name "deepsleep-dispatch" \
  --cron "10 0 * * *" \
  --tz "Your/Timezone" \
  --system-event "Execute DeepSleep Phase 2. Read the deepsleep skill and follow the dispatch process." \
  --timeout-seconds 120
```

**Timeout guidance:** Phase 1 needs ~30 seconds per active session for history pull + summarization. Default 300s covers ~10 sessions comfortably. For larger deployments, increase to 600s or more.

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

## Phase 3: Session Memory Restore (on demand)

The most critical piece — when the agent receives a message in a group session:

1. Check if `memory/groups/<chat_id>.md` exists
2. If yes, read it to restore context about recent discussions, open questions, and todos
3. This is configured in `AGENTS.md` under "群 Session 记忆恢复"

Without this step, Phases 1-2 only help the human (morning brief), but the agent itself still wakes up with no memory.

### File structure
```
memory/groups/
├── oc_abc123.md    # Group A: recent 3-day summary + open questions
├── oc_def456.md    # Group B: recent 3-day summary + open questions
└── ...
```

Phase 2 generates/updates these files each morning. They are compact (< 2KB each) and designed for fast loading.

## Privacy Notes

- Phase 1 writes a daily summary that Phase 2 broadcasts to groups. Never include private MEMORY.md content in the daily summary.
- Each group only receives its own summary in the morning dispatch — no cross-group content leakage.
- MEMORY.md is updated separately and stays in the main session context only.
- Per-group memory snapshots only contain that group's own conversation summaries.

## Inspirations

Built with insights from the community: agent-sleep (multi-level sleep), memory-reflect (filtering criteria), jarvis-memory-architecture (cron inbox), memory-curator (open questions).
