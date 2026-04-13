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
│  6. Log completion status                        │
└─────────────────────────────────────────────────┘
```

## Setup

### Step 1: Add to HEARTBEAT.md

Add this section to your `HEARTBEAT.md` file (after your mandatory checks). **Run all commands from the workspace root** (see Step 1a below):

```markdown
## 🧠 Self-Learning Loop (EVERY heartbeat)

### 1a. Initialize Workspace Root
- Set workspace root for all file operations: `export WORKSPACE=$(git rev-parse --show-toplevel)`
- All file paths below should use `$WORKSPACE` prefix to avoid path issues
- Example: `wc -c "$WORKSPACE/SOUL.md"`

### 1b. Check Lock File (file locking mechanism)
- Before any write operation, check for lock: `if [ -f "$WORKSPACE/memory/.lock" ]; then echo "Locked"; exit 0; fi`
- If lock exists and is older than 5 minutes, consider it stale: `find "$WORKSPACE/memory/.lock" -mmin +5 -delete 2>/dev/null`
- Create lock before starting: `touch "$WORKSPACE/memory/.lock"`
- Remove lock when done (see step 1f below)

### 1c. Missing File Guards
- Before any operation, ensure files exist: `touch "$WORKSPACE/SOUL.md" "$WORKSPACE/USER.md" "$WORKSPACE/MEMORY.md"`
- These are mandatory for the learning loop to function

### 1d. Memory Review (auto-capture from recent conversation)
- Scan the last 10-20 messages in this session
- Did the user reveal preferences, corrections, personal details, or new patterns?
- Did I learn something about the environment, tools, or workflow?
- If YES → write to `$WORKSPACE/memory/YYYY-MM-DD.md` (daily log) AND update `$WORKSPACE/MEMORY.md` if durable
- If NO → skip silently
- **Size limit:** MEMORY.md must stay under 8000 bytes. If over, trim oldest/least relevant.
- **SOUL.md and USER.md must also stay under 8000 bytes.** Check `wc -c "$WORKSPACE/SOUL.md" "$WORKSPACE/USER.md" "$WORKSPACE/MEMORY.md"` before editing.
- **Lesson sourcing:** Tag each lesson with its source in frontmatter: `source: user` for lessons from user messages, `source: agent` for agent-observed lessons. This prevents confusion about where rules came from.

### 1e. Skill Auto-Creation Check
- Did I solve a non-trivial problem this session? Signal: "Did I solve something novel that no existing skill covers, with at least one failed attempt or user correction?"
- Does a skill already exist for this pattern?
- **CRITICAL:** Never overwrite existing skills. If the skill needs updating, edit it in-place. If creating new, always place in `$WORKSPACE/skills/.drafts/` with `Auto-generated:` frontmatter tag for human review.
- Only brand-new skills with no existing file can be auto-created, and even then they go to `.drafts/`.
- **Skip for:** simple one-offs, routine tasks, already documented things

### 1f. Lesson Extraction
- Did something break? Did I make a mistake? Did the user correct me?
- If YES → append to `$WORKSPACE/lessons/` with YAML frontmatter: `id:`, `source:` (user|agent), `count:`, `pattern:`, `fix:`, `date:`
- Search `$WORKSPACE/lessons/` FIRST before doing something tricky (avoid repeat mistakes)
- **Human approval gate for AGENTS.md promotion:** If same lesson appears 3+ times (check `count:` field), DO NOT directly write to AGENTS.md. Instead, notify the user showing the proposed rule and wait for explicit confirmation before updating AGENTS.md.
- If lesson is approved for promotion, move it from lessons/ to AGENTS.md and update the rule set.

### 1g. Memory Size Guard
- Run: `wc -c "$WORKSPACE/SOUL.md" "$WORKSPACE/USER.md" "$WORKSPACE/MEMORY.md"`
- If ANY file > 8000 bytes → trim it NOW
- **Before any trim/truncate operation, create backup:** `cp "$WORKSPACE/SOUL.md" "$WORKSPACE/memory/SOUL.md.bak.$(date +%s)"` (and similarly for USER.md and MEMORY.md)
- Priority: remove duplicates > remove stale info > shorten verbose entries

### 1h. Release Lock File
- When done with all writes: `rm -f "$WORKSPACE/memory/.lock"`
```

### Step 2: Create the Cron Job

Create a cron job for the background self-learning review. Run this in your OpenClaw chat (use OpenClaw's `schedule` skill format):

```
Create a scheduled task called "Self-Learning Loop" using the schedule skill.
Schedule it as a cron job: every 3 hours.
It should be an isolated agentTurn on Sonnet that:

STARTUP:
  1. export WORKSPACE=$(git rev-parse --show-toplevel)
  2. Check for lock at $WORKSPACE/memory/.lock (stale if >5 min old)
  3. Create lock: touch "$WORKSPACE/memory/.lock"

OPERATIONS:
  1. File existence guards: touch "$WORKSPACE/SOUL.md" "$WORKSPACE/USER.md" "$WORKSPACE/MEMORY.md"
  2. Memory size check: wc -c "$WORKSPACE/SOUL.md" "$WORKSPACE/USER.md" "$WORKSPACE/MEMORY.md"
  3. If any file > 8000 bytes:
     - Backup first: cp "$WORKSPACE/SOUL.md" "$WORKSPACE/memory/SOUL.md.bak.$(date +%s)" (and USER.md, MEMORY.md)
     - Auto-trim that file
  4. Reviews recent $WORKSPACE/memory/ files for facts worth promoting to MEMORY.md
  5. Checks $WORKSPACE/lessons/ for patterns with `count:` field >= 3 (requires human approval before AGENTS.md update)
  6. Checks $WORKSPACE/tasks/done/ for novel approaches worth saving as skills (go to .drafts/ with Auto-generated tag)
  7. Removes stale entries from MEMORY.md
  8. Log completion: echo "$(date -Iseconds) OK" >> "$WORKSPACE/memory/cron.log"

CLEANUP:
  - Release lock: rm -f "$WORKSPACE/memory/.lock"

Delivery: none. Timeout: 120 seconds.
```

**Schedule format reference:** Use OpenClaw's native `schedule` skill to define cron-like behavior. Example:
```yaml
schedule:
  interval: 3h
  isolation: true
  timeout: 120s
```

### Step 3: Lesson File Format Specification

Lessons stored in `lessons/` must follow this YAML frontmatter format:

```yaml
---
id: lesson-name-unique-id
source: agent  # or "user" — track where this lesson came from
count: 2       # how many times we've encountered this pattern
pattern: "Description of the mistake/pattern that keeps recurring"
fix: "Specific actionable fix to apply instead"
date: 2026-01-15
---

Optional additional context here.
```

The `count:` field is used by the cron to determine promotion eligibility (count >= 3 means it's ready for human review before AGENTS.md update).

### Step 4: Create Required Directories

```bash
mkdir -p memory lessons decisions tasks/active tasks/done skills skills/.drafts
```

### Step 5: Seed Memory Files (if they don't exist)

Your workspace should already have:
- `MEMORY.md` — long-term curated memory
- `SOUL.md` — agent identity and personality  
- `USER.md` — user profiles and preferences
- `AGENTS.md` — workspace rules and conventions
- `memory/` — daily log files (`YYYY-MM-DD.md`) and cron log (`cron.log`)
- `lessons/` — mistake patterns and fixes (with YAML frontmatter)
- `decisions/` — decision logs with reasoning

### Step 6: Disable/Enable Learning (Optional)

To pause all learning steps in both heartbeat and cron:
```bash
touch memory/.no-learn
```

To resume:
```bash
rm memory/.no-learn
```

The heartbeat and cron should check for this file at startup: `if [ -f "$WORKSPACE/memory/.no-learn" ]; then exit 0; fi`

## How It Compares to Hermes Agent

| Feature | Hermes | This Skill (OpenClaw) |
|---------|--------|----------------------|
| Memory nudge | Every 10 turns (background thread) | Every heartbeat + every 3h cron |
| Skill auto-creation | Every 15 tool calls | Heartbeat + cron checks done tasks |
| Memory flush before compression | Before context compress | Cron + heartbeat guard |
| Memory size guard | 2200 char limit | 8000 byte limit + auto-trim |
| Lesson extraction | ❌ None | ✅ Auto-promote after 3 occurrences (with human gate) |
| User modeling | Honcho (external service) | USER.md + daily memory files |
| Stale cleanup | ❌ None | ✅ Cron removes dead entries |
| Skill overwrite protection | ❌ None | ✅ New skills go to .drafts/ only |
| File locking | ❌ None | ✅ Lock mechanism prevents race conditions |
| CWD path handling | ❌ None | ✅ Workspace-anchored paths with $WORKSPACE |

### Advantages Over Hermes

1. **Lesson extraction** — Hermes doesn't learn from mistakes. We track patterns and promote recurring ones to hard rules (with human approval gate).
2. **Memory size guard** — Prevents the silent truncation bug where oversized context files get cut mid-session. This is a real problem that causes agents to "forget" their identity.
3. **Stale cleanup** — Active removal of outdated information. Hermes only adds, never cleans.
4. **No external dependencies** — Hermes uses Honcho (Plastic Labs) for user modeling. We use plain files that survive anything.
5. **Cron isolation** — Background reviews run in isolated sessions, never polluting the main conversation context.
6. **Skill overwrite safety** — New auto-generated skills never clobber existing ones; they go to `.drafts/` for review.
7. **Race condition prevention** — Lock file mechanism prevents concurrent writes to shared memory files.
8. **Observability** — Cron logs completion status so users can verify the loop is running.

## File Size Rules (Critical)

These limits prevent silent context truncation:

| File | Max Size | What Happens If Exceeded |
|------|----------|--------------------------|
| SOUL.md | 8000 bytes | Agent loses personality mid-session |
| USER.md | 8000 bytes | Agent forgets user preferences |
| MEMORY.md | 8000 bytes | Agent loses project context |

The self-learning cron checks these sizes every 3 hours and auto-trims if needed. Before trimming, it creates a timestamped backup in `memory/`.

## Tips

- **Daily notes** (`memory/YYYY-MM-DD.md`) are raw logs. MEMORY.md is curated wisdom. Don't dump everything into MEMORY.md.
- **Lessons should be actionable.** Not "X broke" but "X broke because Y. Fix: do Z instead." Include the `id:`, `source:`, `count:`, `pattern:`, `fix:`, and `date:` fields in the YAML frontmatter.
- **Skills should be reusable.** If you'd do the same thing again for a different user, it's a skill. If it's one-off, it's a lesson. New auto-generated skills go to `skills/.drafts/` with `Auto-generated:` frontmatter tag until a human reviews and moves them to `skills/`.
- **Review MEMORY.md weekly.** Delete entries about completed projects, deprecated tools, or outdated accounts.
- **Promoted lessons should be archived.** Once a lesson is promoted to AGENTS.md as a rule, remove or archive it from `lessons/` to prevent the directory from becoming an unbounded mix of staging and archive.
- **Verify cron execution.** Check `memory/cron.log` to confirm the learning loop is running. Entry format: `2026-01-15T10:30:45+00:00 OK`.
