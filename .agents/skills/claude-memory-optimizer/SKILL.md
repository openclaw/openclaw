---
name: claude-memory-optimizer
description: Structured memory system with 4-type classification (user/feedback/project/reference), frontmatter metadata, and automated migration. Based on Claude Code memory architecture.
tags: memory, claude-code, knowledge-management, persistence
version: 1.0.0
---

# Claude Memory Optimizer

Structured memory system for OpenClaw with 4-type classification and automated migration.

## When to Use

- Setting up memory for the first time in OpenClaw
- Migrating from unstructured `memory/*.md` to organized categories
- Improving memory recall with semantic frontmatter
- Implementing Claude Code-style memory architecture

## Features

- **4-Type Classification**: user, feedback, project, reference
- **Frontmatter Metadata**: structured name/description/type for semantic search
- **Auto-Migration**: one-command refactor of existing memory files
- **Log Mode**: optional append-only daily logs (KAIROS style)

## Quick Start

### Install

```bash
clawhub install claude-memory-optimizer
```

### Run Migration

```bash
node ~/.openclaw/skills/claude-memory-optimizer/scripts/refactor-memory.js
```

### Verify

```bash
ls -la ~/.openclaw/workspace/memory/
cat ~/.openclaw/workspace/MEMORY.md
```

## Memory Types

| Type | Purpose | Example |
|------|---------|---------|
| **user** | User role, preferences, skills | "Data scientist, prefers concise replies" |
| **feedback** | Behavior corrections/confirmations | "No trailing summaries — user can read diffs" |
| **project** | Project context, decisions, deadlines | "Thesis deadline: 2026-06-01" |
| **reference** | External system pointers | "Kaggle: https://kaggle.com/chenziong" |

## Directory Structure

```
memory/
├── user/          # User information
├── feedback/      # Behavior guidance
├── project/       # Project context
├── reference/     # External references
└── logs/          # Append-only logs (optional)
    └── YYYY/
        └── MM/
            └── YYYY-MM-DD.md
```

## Memory File Format

Each memory file uses frontmatter metadata:

```markdown
---
name: Data Science Background
description: User is a data scientist focused on observability and LLMs
type: user
---

User studies at Beijing University of Technology & UCD, GPA 3.95/4.2.
Research: LLM, AI Agents, MCP.

**Skills:** Python, PyTorch, Transformers, NLP

**How to apply:** Use data science terminology, assume ML background.
```

## What NOT to Save

- Code patterns, architecture, file paths (derivable from codebase)
- Git history, recent changes (use `git log`)
- Debugging solutions (fix is in the code)
- Content already in CLAUDE.md
- Ephemeral task details (only useful in current session)

## Configuration

### OpenClaw Config

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

## Usage Examples

### Save User Preference

**User:** "Remember, I prefer concise replies without trailing summaries."

**AI:** Saves to `memory/feedback/reply-style.md`:

```markdown
---
name: Reply Style Preference
description: User wants concise replies, no trailing summaries
type: feedback
---

**Rule:** Keep replies concise, no trailing summaries.

**Why:** User said "I can read the diff myself."

**How to apply:** End responses directly after completing work.
```

### Retrieve Memory

**User:** "What did I say about database testing?"

**AI:** Runs `memory_search query="database testing"` → returns `memory/feedback/db-testing.md`

### Verify Memory

**User:** "Is the experiment design in memory/project/dong-thesis.md still current?"

**AI:** Runs `grep` to verify → detects outdated info → updates memory file.

## Migration Guide

### Before

```
memory/
├── 2026-03-21.md
├── 2026-03-28.md
├── research-memory.md
└── video-memory.md
```

### After

```
memory/
├── project/
│   ├── 2026-03-21-.md
│   ├── 2026-03-28-.md
│   └── research-memory.md
├── reference/
│   └── video-memory.md
└── logs/2026/04/2026-04-02.md
```

## Advanced Features

### Semantic Retrieval (Future)

```typescript
async function findRelevantMemories(query: string, memoryDir: string) {
  const memories = await scanMemoryFiles(memoryDir);
  const selected = await selectRelevantMemories(query, memories);
  return selected.slice(0, 5); // Top 5 relevant memories
}
```

### Verification on Recall (Future)

Before recommending from memory:

1. If memory names a file → `ls` to verify existence
2. If memory names a function → `grep` to confirm
3. If memory conflicts with current state → trust current observation, update memory

> "Memory says X exists" ≠ "X exists now"

## Maintenance

### Daily (Heartbeat)

- Append to `memory/YYYY-MM-DD.md`
- Record decisions, conversations, learnings

### Weekly (Review)

- Read daily notes
- Distill important info to `MEMORY.md`
- Remove outdated entries

### Monthly (Audit)

- Review project progress
- Update long-term goals
- Check `.learnings/` records

## Troubleshooting

### Memory Not Loaded

- Ensure `MEMORY.md` exists in workspace root
- Check `agents.defaults.memorySearch.enabled = true`
- Restart OpenClaw gateway

### Poor Recall Quality

- Add specific `description` in frontmatter
- Use consistent keywords
- Adjust `minScore` (lower = broader matches)

### Migration Fails

- Backup `memory/` directory first
- Run script with `--dry-run` (if available)
- Check file permissions

## References

- Claude Code: `src/memdir/` (memdir.ts, memoryTypes.ts, findRelevantMemories.ts)
- OpenClaw Docs: `docs/concepts/memory.md`
- Related Skills: `memory-setup-openclaw`, `elite-longterm-memory`

## License

MIT-0
