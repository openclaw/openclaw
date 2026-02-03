---
name: para-second-brain
version: 3.0.0
description: "Organize your agent's knowledge using PARA (Projects, Areas, Resources, Archive) — then make it ALL searchable with the symlink trick. Find anything instantly. Part of the Hal Stack 🦞"
author: halthelobster
---

# PARA Second Brain 🦞

**By Hal Labs** — Part of the Hal Stack

Your agent's knowledge is scattered. Daily logs, project notes, reference material — but `memory_search` only sees MEMORY.md. This skill makes EVERYTHING searchable.

## The Problem

By default, `memory_search` only indexes:
- `MEMORY.md`
- `memory/*.md` (daily logs)

Your entire `notes/` folder is invisible. You have to manually know where to look.

## The Solution: The Symlink Trick

One command makes your entire knowledge base searchable:

```bash
ln -s /path/to/your/workspace/notes /path/to/your/workspace/memory/notes
```

Now `memory_search` finds content across your entire PARA structure.

| Before | After |
|--------|-------|
| Search only MEMORY.md + daily logs | Search EVERYTHING |
| "I don't have that information" | Finds it instantly |
| Must manually know where to look | Semantic search across all notes |

## Quick Setup

### 1. Create Directory Structure

```
workspace/
├── MEMORY.md              # Curated long-term memory
├── SESSION-STATE.md       # Active working memory (see Bulletproof Memory)
├── memory/
│   ├── YYYY-MM-DD.md      # Daily raw logs
│   └── notes -> ../notes  # Symlink (the trick!)
└── notes/
    ├── projects/          # Active work with end dates
    ├── areas/             # Ongoing responsibilities  
    ├── resources/         # Reference material
    └── archive/           # Completed/inactive items
```

Run this to scaffold:
```bash
mkdir -p memory notes/projects notes/areas notes/resources notes/archive
ln -s $(pwd)/notes $(pwd)/memory/notes
```

### 2. Verify the Symlink

```bash
ls -la memory/notes  # Should show: memory/notes -> /path/to/notes
```

Test it: Ask your agent something that's in `notes/` but NOT in MEMORY.md. If it finds it, the symlink is working.

### 3. Initialize MEMORY.md

Create `MEMORY.md` in workspace root — your curated long-term memory:

```markdown
# MEMORY.md — Long-Term Memory

## About [Human's Name]
- Role/occupation
- Key goals and motivations
- Communication preferences

## Active Context
- Current focus areas
- Ongoing projects (summaries)
- Time-sensitive items

## Preferences & Patterns
- Tools and workflows they prefer
- Decision-making style
- Likes and pet peeves

## Lessons Learned
- What worked
- What didn't
- Principles discovered
```

### 4. Add to AGENTS.md

```markdown
## Memory

You wake up fresh each session. These files are your continuity:
- **SESSION-STATE.md** — Active working memory (current task)
- **Daily notes:** `memory/YYYY-MM-DD.md` — raw logs
- **Long-term:** `MEMORY.md` — curated memories
- **Topic notes:** `notes/` — PARA structure (all searchable via symlink)

### PARA Structure
- `notes/projects/` — Active work with end dates
- `notes/areas/` — Ongoing responsibilities
- `notes/resources/` — Reference material
- `notes/archive/` — Completed/inactive

### Writing Rules
- If it has future value, write it NOW
- Don't rely on "mental notes" — they don't survive
- Text > Brain 📝
```

## PARA Explained

PARA is a knowledge organization system by Tiago Forte. It organizes everything by actionability:

### Projects
**What:** Work with a deadline or end state
**Examples:** "Launch website", "Plan trip", "Client proposal"
**Path:** `notes/projects/website-launch.md`

### Areas
**What:** Ongoing responsibilities with no end date
**Examples:** Health, finances, relationships, career
**Path:** `notes/areas/health.md`

### Resources
**What:** Reference material for future use
**Examples:** Research, tutorials, templates, guides
**Path:** `notes/resources/api-docs.md`

### Archive
**What:** Inactive items from other categories
**Examples:** Completed projects, outdated resources
**Path:** `notes/archive/old-project.md`

## Decision Tree: Where Does This Go?

```
Is it about today specifically?
  → memory/YYYY-MM-DD.md

Is it the current active task?
  → SESSION-STATE.md

Is it a task with an end date?
  → notes/projects/

Is it an ongoing responsibility?
  → notes/areas/

Is it reference material for later?
  → notes/resources/

Is it done or no longer relevant?
  → notes/archive/

Is it a distilled lesson or preference?
  → MEMORY.md
```

## Daily Log Format

Create `memory/YYYY-MM-DD.md` for each day:

```markdown
# YYYY-MM-DD

## Key Events
- [What happened, decisions made]

## Learnings
- [What worked, what didn't]

## Open Threads
- [Carry-forward items]
```

## The Curation Workflow

### Daily (5 min)
- Log notable events to `memory/YYYY-MM-DD.md`
- File topic-specific notes to appropriate `notes/` folder

### Weekly (15 min)
- Review the week's daily logs
- Extract patterns and learnings to MEMORY.md
- Move completed projects to archive

### Monthly (30 min)
- Review MEMORY.md for outdated info
- Consolidate or archive old project notes
- Ensure areas reflect current priorities

## Knowledge Quality

**The core question:** "Will future-me thank me for this?"

### What to Save
- Concepts you actually understand
- Tools you've actually used
- Patterns that worked (with examples)
- Lessons learned from mistakes

### What NOT to Save
- Half-understood concepts (learn first)
- Tools you haven't tried
- Shallow entries without WHY
- Duplicates of existing notes

### Quality Gates
Before saving any curated note:
1. Written for future self who forgot context?
2. Includes WHY, not just WHAT?
3. Has concrete examples?
4. Structured for scanning?

## Unified Search Protocol

When looking for past context, search ALL sources:

```
1. memory_search("query") → MEMORY.md, daily logs, PARA notes
2. session-search (if built) → past conversations
3. grep fallback → exact matches when semantic fails
```

**Don't stop at the first miss.** The answer is usually somewhere.

## Two Memory Layers

| Daily Logs | MEMORY.md |
|------------|-----------|
| Raw, timestamped | Curated, organized |
| Everything captured | Only what matters |
| Chronological | Topical |
| "What happened" | "What I learned" |

Daily logs are your journal. MEMORY.md is your wisdom.

## The Complete Memory Stack

For comprehensive agent memory, combine this with:

| Skill | Purpose |
|-------|---------|
| **PARA Second Brain** (this) | Organize and find knowledge |
| **Bulletproof Memory** | Never lose active context |
| **Proactive Agent** | Act without being asked |

Together, they create an agent that remembers everything, finds anything, and anticipates needs.

## Principles

1. **Searchable > organized** — The symlink trick matters more than perfect structure
2. **Quality over quantity** — Curated notes beat note hoarding
3. **Future-me test** — "Will future-me thank me for this?"
4. **One home per item** — Don't duplicate; link instead
5. **Include the WHY** — Facts without context are useless

---

*Part of the Hal Stack 🦞*

*Pairs well with [Bulletproof Memory](https://clawdhub.com/halthelobster/bulletproof-memory) for context persistence and [Proactive Agent](https://clawdhub.com/halthelobster/proactive-agent) for behavioral patterns.*
