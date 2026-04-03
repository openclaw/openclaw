# Claude Memory Optimizer

> Structured memory system for OpenClaw with 4-type classification, automated migration, and **PUA-style maintenance checklist**.

## 🎯 Overview

Based on Claude Code's memory architecture, this skill brings structured, file-based memory management to OpenClaw with:

- **4-Type Classification**: user, feedback, project, reference
- **Frontmatter Metadata**: structured name/description/type
- **Auto-Migration**: one-command refactor of existing memory files
- **Log Mode**: optional append-only daily logs
- **PUA-Style Maintenance**: 7 iron rules + pressure escalation (inspired by [tanweai/pua](https://github.com/tanweai/pua) - 14.8k GitHub stars)

**New in v1.1.0**: Memory PUA maintenance checklist with corporate PUA rhetoric to prevent AI "memory slacking".

## 📦 Installation

```bash
clawhub install claude-memory-optimizer
```

## 🚀 Quick Start

### 1. Run Migration

```bash
node ~/.openclaw/skills/claude-memory-optimizer/scripts/refactor-memory.js
```

### 2. Run PUA Maintenance Check

```bash
# Normal mode (L0 - starts with 3 basic checks)
node ~/.openclaw/skills/claude-memory-optimizer/scripts/memory-pua.js

# Strict mode (L3 - full 7 checks from start)
node ~/.openclaw/skills/claude-memory-optimizer/scripts/memory-pua.js --mode strict

# Audit mode (L4 - emergency full audit)
node ~/.openclaw/skills/claude-memory-optimizer/scripts/memory-pua.js --mode audit
```

### 3. Verify Structure

```bash
ls -la ~/.openclaw/workspace/memory/
cat ~/.openclaw/workspace/MEMORY.md
```

### 4. Configure OpenClaw

Edit your OpenClaw config:

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "enabled": true,
        "provider": "local",
        "maxResults": 20,
        "minScore": 0.3
      },
      "compaction": {
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 4000
        }
      }
    }
  }
}
```

### 5. Restart Gateway

```bash
openclaw gateway restart
```

## 📁 Directory Structure

```
memory/
├── user/          # User information (role, preferences, skills)
├── feedback/      # Behavior guidance (corrections, confirmations)
├── project/       # Project context (decisions, deadlines)
├── reference/     # External references (links, dashboards)
└── logs/          # Append-only logs (optional KAIROS mode)
    └── YYYY/MM/DD.md
```

## 📝 Memory File Format

Each memory file uses frontmatter:

```markdown
---
name: Data Science Background
description: User is a data scientist focused on LLMs and observability
type: user
---

User studies at Beijing University of Technology & UCD, GPA 3.95/4.2.
Research: LLM, AI Agents, MCP.

**Skills:** Python, PyTorch, Transformers, NLP
```

## 🎓 Examples

### User Memory

```markdown
---
name: Communication Preference
description: User prefers concise replies without summaries
type: user
---

**Preference:** No trailing summaries at end of responses.

**Why:** "I can read the diff myself."
```

### Feedback Memory

```markdown
---
name: Database Testing Rule
description: Integration tests must hit real database, not mocks
type: feedback
---

**Rule:** No database mocks in integration tests.

**Why:** Mock/prod divergence masked a broken migration last quarter.

**How to apply:** All integration tests use real PostgreSQL container.
```

### Project Memory

```markdown
---
name: Thesis Deadline
description: PhD thesis submission due 2026-06-01
type: project
---

**Deadline:** 2026-06-01

**Why:** Graduation requirement, legal flagging for compliance.

**How to apply:** Prioritize thesis work over side projects after March.
```

### Reference Memory

```markdown
---
name: Kaggle Profile
description: User's Kaggle profile with competition history
type: reference
---

**URL:** https://kaggle.com/chenziong

**Achievements:**

- 🥇 Gold: Child Mind Institute (2024.12)
- 🥉 Bronze: LLM-Detect-AI-Generated-Text
```

## ⚠️ What NOT to Save

- ❌ Code patterns, architecture (derivable from codebase)
- ❌ Git history (use `git log`)
- ❌ Debugging solutions (fix is in the code)
- ❌ CLAUDE.md content (already documented)
- ❌ Ephemeral task details (current session only)

## 🔧 Scripts

### refactor-memory.js

Migrates existing `memory/*.md` files to categorized structure.

```bash
node scripts/refactor-memory.js
```

**Features:**

- Auto-detects memory type from keywords
- Generates frontmatter
- Updates `MEMORY.md` index
- Creates log directory structure

## 📊 Comparison

| Feature         | Before             | After                        |
| --------------- | ------------------ | ---------------------------- |
| Classification  | None               | 4 types                      |
| Metadata        | None               | Frontmatter                  |
| Structure       | Flat `memory/*.md` | Categorized `memory/{type}/` |
| Semantic Search | Basic keyword      | LLM-powered (future)         |
| Verification    | None               | On-recall check (future)     |

## 🛠️ Advanced

### Semantic Retrieval (Future)

```typescript
async function findRelevantMemories(query: string) {
  const memories = await scanMemoryFiles(memoryDir);
  const selected = await selectRelevantMemories(query, memories);
  return selected.slice(0, 5);
}
```

### Verification on Recall (Future)

```markdown
## Before recommending from memory

- If memory names a file → `ls` to verify
- If memory names a function → `grep` to confirm
- If conflict with current state → trust observation, update memory
```

## 📚 References

- Claude Code: `src/memdir/`
- OpenClaw Docs: `docs/concepts/memory.md`
- Related: `memory-setup-openclaw`, `elite-longterm-memory`

## 📄 License

MIT-0
