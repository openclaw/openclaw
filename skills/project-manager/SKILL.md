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

---

## Templates

### Full Template (multi-day projects)

```markdown
# {Project Name}
> Last updated: {Date}

## 🎯 Core Goal
[One sentence]

## 📍 Current State
[What just happened]

## 📋 Todo
- [x] Done
- [ ] Next thing

## 🔑 Key Context / Decisions
- Decision: why
- Constraint: explicit requirement
- Link: relevant URL/path

## 🛑 Blocked / Open Questions
[What's paused or needs clarification]
```

### Light Template (single tasks)

```markdown
# {Project Name}
> Last updated: {Date}

## 📍 Current State
[One sentence]

## 🔑 Decision (if any)
[Why you chose this approach]

## 📋 Next Step
- [ ] What comes next
```

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

### Concurrent Safety

Before writing STATUS.md: **read the file first**, then merge changes, then write. Prevents overwrites from multiple concurrent sessions.

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
