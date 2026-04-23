---
name: project-manager
description: "Project context isolation system. Creates independent STATUS.md per project, enables resume-from-breakpoint, prevents context pollution. Triggers: new project, resume project, save state, project list."
---

# Project Manager - Project Context Isolation

## Problem

Agents are **stateless** between sessions. Without explicit file-backed state, project context is lost when:
- Conversation context truncates
- Switching between projects mid-session  
- Session ends before task completion

The result: agents repeatedly forget where they left off, waste time relearning context, and mix details from different projects.

## Solution

Each project gets its own **`STATUS.md`**, stored in `projects/{name}/`. Project state is:
- **Isolated** — never pollutes global memory
- **Persistent** — survives session restarts
- **Recoverable** — "resume project X" reads the file, not memory

## Directory Structure

```
workspace/
├── MEMORY.md                  # User preferences + cross-project lessons only
├── memory/
│   └── YYYY-MM-DD.md          # Daily logs (reference STATUS.md, no detail)
└── projects/                  # Project isolation
    ├── index.md               # Project index (auto-created on first use)
    └── {project-name}/
        └── STATUS.md          # Project state (only source of truth)
```

## Project Index (`projects/index.md`)

Created automatically on first use:

```markdown
# Project Index
| Project | Directory | Last Updated | Status | Notes |
|---------|-----------|-------------|--------|-------|
```

## Templates

For STATUS.md templates (Full and Light variants), see `references/templates.md`.

---

## Workflows

### Intent Detection (auto-triggered)

| User says | Means | Action |
|-----------|-------|--------|
| "new project X" / "start X" | Create | Initialize project |
| "resume X" / "back to X" | Resume | Read STATUS.md |
| "save state" / "pause" | Pause | Write STATUS.md |
| "what projects" / "project list" | List | Show index.md |
| "switch to X" | Switch | Save current + resume target |

### Resume (Critical Rule)

When user says "resume X" or implies returning to a project:
1. **Read `projects/{name}/STATUS.md`** — always, never guess
2. Summarize: "📖 Resumed `{name}`. State: {one sentence}. Todo: {list}."
3. **Update `index.md`** — move project to top (most recent)

If project not found in index → search `projects/` directory for folder name match → if found, add to index and resume.

### State Update Rule

**Update STATUS.md when** (any one):
- ✅ Completed a subtask
- ✅ Made a decision (record why)
- ✅ User gave new requirements
- ✅ Blocked by external dependency

**Do NOT update** for:
- ❌ Typo fixes / minor edits
- ❌ Thinking through options without deciding
- ❌ Trying different approaches but reverting to original

### Write Safety

Before writing STATUS.md: **read the file first**, then merge changes, then write. This reduces accidental overwrites within a session when the file was modified out-of-band.

> **Note**: True concurrent access from multiple parallel sessions requires file locking or atomic operations at the OS level. This pattern handles single-session safety only.

---

## Integration with Existing Memory

| Info | Where |
|------|-------|
| User preferences | `MEMORY.md` |
| Daily logs | `memory/YYYY-MM-DD.md` |
| Project state | `projects/{name}/STATUS.md` |

**Daily log rule**: Write only a one-line summary + "See projects/{name}/STATUS.md" — do not duplicate details.

---

## Git Integration (optional)

If `projects/{name}/.git/` exists:
- Record `Git: {hash}` in STATUS.md header
- On resume: `git log --oneline -1` to verify state

---

*Complements AGENTS.md memory guidelines. Project state lives only in STATUS.md — not in global memory.*
