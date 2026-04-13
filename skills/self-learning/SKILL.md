---
name: self-learning
description: Autonomous self-learning loop for OpenClaw agents. Auto-captures memories, creates skills from experience, extracts lessons from mistakes, and guards against memory bloat. Inspired by Hermes Agent's learning architecture but built natively for OpenClaw using crons, heartbeats, and subagents. Use when setting up a new OpenClaw agent with self-improving capabilities, or when asked about self-learning, auto-memory, or persistent learning across sessions.
---

# Self-Learning Loop for OpenClaw

Autonomous self-improvement system that makes your OpenClaw agent learn from every interaction — without any code changes to OpenClaw itself.

## What It Does

1. **Memory Nudge** — Auto-reviews conversations and saves durable facts (user preferences, corrections, discoveries)
2. **Skill Auto-Creation** — Detects novel problem-solving approaches and saves them as reusable skills
3. **Lesson Extraction** — Captures mistakes and corrections, promotes recurring patterns to rules
4. **Memory Size Guard** — Prevents context file bloat that causes silent truncation
5. **Stale Cleanup** — Removes outdated entries from memory files

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  HEARTBEAT                       │
│  (runs every ~30min during active sessions)      │
│                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ Memory   │ │ Skill    │ │ Lesson           │ │
│  │ Review   │ │ Check    │ │ Extraction       │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│  ┌──────────────────────────────────────────┐   │
│  │ Memory Size Guard (SOUL/USER/MEMORY.md)  │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│              CRON (every 3 hours)                │
│  Isolated subagent — catches what heartbeat      │
│  misses. Runs independently of active sessions.  │
│                                                  │
│  1. Memory size check + auto-trim               │
│  2. Promote daily notes → MEMORY.md             │
│  3. Lesson pattern detection (3+ = promote)     │
│  4. Skill creation from completed tasks         │
│  5. Stale entry cleanup                         │
└─────────────────────────────────────────────────┘
```

## Setup

### Step 1: Add to HEARTBEAT.md

Add this section to your `HEARTBEAT.md` file (after your mandatory checks):

```markdown
## 🧠 Self-Learning Loop (EVERY heartbeat)

### 1. Memory Review (auto-capture from recent conversation)
- Scan the last 10-20 messages in this session
- Did the user reveal preferences, corrections, personal details, or new patterns?
- Did I learn something about the environment, tools, or workflow?
- If YES → write to `memory/YYYY-MM-DD.md` (daily log) AND update `MEMORY.md` if durable
- If NO → skip silently
- **Size limit:** MEMORY.md must stay under 8000 bytes. If over, trim oldest/least relevant.
- **SOUL.md and USER.md must also stay under 8000 bytes.** Check `wc -c` before editing.

### 2. Skill Auto-Creation Check
- Did I solve a non-trivial problem this session (5+ tool calls, trial-and-error, user correction)?
- Does a skill already exist for this pattern?
- If novel + reusable → create a new skill file in `skills/`
- If existing skill was wrong/incomplete → update it
- **Skip for:** simple one-offs, routine tasks, already documented things

### 3. Lesson Extraction
- Did something break? Did I make a mistake? Did the user correct me?
- If YES → append to `lessons/` with date + pattern + fix
- Search `lessons/` FIRST before doing something tricky (avoid repeat mistakes)
- If same lesson appears 3+ times → promote to AGENTS.md "Promoted Rules"

### 4. Memory Size Guard
- Run: `wc -c SOUL.md USER.md MEMORY.md`
- If ANY file > 8000 bytes → trim it NOW
- Priority: remove duplicates > remove stale info > shorten verbose entries
```

### Step 2: Create the Cron Job

Create a cron job for the background self-learning review. Run this in your OpenClaw chat:

```
Create a cron job called "Self-Learning Loop" that runs every 3 hours.
It should be an isolated agentTurn on Sonnet that:
1. Checks SOUL.md, USER.md, MEMORY.md sizes (must be under 8000 bytes each)
2. Reviews recent memory/ files for facts worth promoting to MEMORY.md
3. Checks lessons/ for patterns appearing 3+ times (promote to AGENTS.md)
4. Checks tasks/done/ for novel approaches worth saving as skills
5. Removes stale entries from MEMORY.md
Delivery: none. Timeout: 120 seconds.
```

### Step 3: Create Required Directories

```bash
mkdir -p memory lessons decisions tasks/active tasks/done skills
```

### Step 4: Seed Memory Files (if they don't exist)

Your workspace should already have:
- `MEMORY.md` — long-term curated memory
- `SOUL.md` — agent identity and personality  
- `USER.md` — user profiles and preferences
- `AGENTS.md` — workspace rules and conventions
- `memory/` — daily log files (`YYYY-MM-DD.md`)
- `lessons/` — mistake patterns and fixes
- `decisions/` — decision logs with reasoning

## How It Compares to Hermes Agent

| Feature | Hermes | This Skill (OpenClaw) |
|---------|--------|----------------------|
| Memory nudge | Every 10 turns (background thread) | Every heartbeat + every 3h cron |
| Skill auto-creation | Every 15 tool calls | Heartbeat + cron checks done tasks |
| Memory flush before compression | Before context compress | Cron + heartbeat guard |
| Memory size guard | 2200 char limit | 8000 byte limit + auto-trim |
| Lesson extraction | ❌ None | ✅ Auto-promote after 3 occurrences |
| User modeling | Honcho (external service) | USER.md + daily memory files |
| Stale cleanup | ❌ None | ✅ Cron removes dead entries |

### Advantages Over Hermes

1. **Lesson extraction** — Hermes doesn't learn from mistakes. We track patterns and promote recurring ones to hard rules.
2. **Memory size guard** — Prevents the silent truncation bug where oversized context files get cut mid-session. This is a real problem that causes agents to "forget" their identity.
3. **Stale cleanup** — Active removal of outdated information. Hermes only adds, never cleans.
4. **No external dependencies** — Hermes uses Honcho (Plastic Labs) for user modeling. We use plain files that survive anything.
5. **Cron isolation** — Background reviews run in isolated sessions, never polluting the main conversation context.

## File Size Rules (Critical)

These limits prevent silent context truncation:

| File | Max Size | What Happens If Exceeded |
|------|----------|--------------------------|
| SOUL.md | 8000 bytes | Agent loses personality mid-session |
| USER.md | 8000 bytes | Agent forgets user preferences |
| MEMORY.md | 8000 bytes | Agent loses project context |

The self-learning cron checks these sizes every 3 hours and auto-trims if needed.

## Tips

- **Daily notes** (`memory/YYYY-MM-DD.md`) are raw logs. MEMORY.md is curated wisdom. Don't dump everything into MEMORY.md.
- **Lessons should be actionable.** Not "X broke" but "X broke because Y. Fix: do Z instead."
- **Skills should be reusable.** If you'd do the same thing again for a different user, it's a skill. If it's one-off, it's a lesson.
- **Review MEMORY.md weekly.** Delete entries about completed projects, deprecated tools, or outdated accounts.
