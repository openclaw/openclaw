---
name: claude-memory-optimizer
description: Structured memory system with 4-type classification, frontmatter metadata, automated migration, and PUA-style maintenance checklist. Based on Claude Code memory architecture.
tags: memory, claude-code, knowledge-management, persistence, pua, maintenance
version: 1.1.0
---

# Claude Memory Optimizer

Structured memory system for OpenClaw with 4-type classification, automated migration, and **PUA-style maintenance checklist** (inspired by tanweai/pua - 14.8k GitHub stars).

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
- **PUA-Style Maintenance**: 7 iron rules checklist with pressure escalation (L0-L4)

## Quick Start

### Install

```bash
clawhub install claude-memory-optimizer
```

### Run Migration

```bash
node ~/.openclaw/skills/claude-memory-optimizer/scripts/refactor-memory.js
```

### Run PUA Maintenance Check

```bash
# Normal mode (L0 - 3 checks)
node ~/.openclaw/skills/claude-memory-optimizer/scripts/memory-pua.js

# Strict mode (L3 - full 7 checks)
node ~/.openclaw/skills/claude-memory-optimizer/scripts/memory-pua.js --mode strict

# Audit mode (L4 - emergency fix)
node ~/.openclaw/skills/claude-memory-optimizer/scripts/memory-pua.js --mode audit
```

### Verify

```bash
ls -la ~/.openclaw/workspace/memory/
cat ~/.openclaw/workspace/MEMORY.md
```

## Memory Types

| Type          | Purpose                               | Example                                       |
| ------------- | ------------------------------------- | --------------------------------------------- |
| **user**      | User role, preferences, skills        | "Data scientist, prefers concise replies"     |
| **feedback**  | Behavior corrections/confirmations    | "No trailing summaries — user can read diffs" |
| **project**   | Project context, decisions, deadlines | "Thesis deadline: 2026-06-01"                 |
| **reference** | External system pointers              | "Kaggle: https://kaggle.com/chenziong"        |

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

---

## 🔥 PUA-Style Maintenance (NEW in v1.1.0)

Inspired by [tanweai/pua](https://github.com/tanweai/pua) (14.8k GitHub stars) — brings corporate PUA rhetoric to memory maintenance.

### Seven Iron Rules (七项铁律)

| #   | Rule           | Description                                                       |
| --- | -------------- | ----------------------------------------------------------------- |
| 1   | **闭环验证**   | Say "memory updated"? Show evidence (file path + content summary) |
| 2   | **事实驱动**   | Say "memory may be outdated"? Verify first (grep/ls check)        |
| 3   | **穷尽检索**   | Say "no relevant memory found"? Complete 5-step search process    |
| 4   | **主动延伸**   | After fixing bug? Check for similar issues in related files       |
| 5   | **元数据完整** | All memory files must have frontmatter (name/description/type)    |
| 6   | **分类准确**   | Memory types must be accurate (user/feedback/project/reference)   |
| 7   | **定期清理**   | Project memories >90 days old need review                         |

### Pressure Escalation (压力升级)

| Level           | Trigger      | Message                                | Action                |
| --------------- | ------------ | -------------------------------------- | --------------------- |
| **L0 信任**     | 0 failures   | "记忆系统运行正常，保持当前状态"       | Normal (3 checks)     |
| **L1 温和提醒** | 1 failure    | "隔壁项目的记忆维护做得比你好"         | Remind (5 checks)     |
| **L2 灵魂拷问** | 2-3 failures | "你的底层逻辑是什么？闭环在哪？"       | Deep check (7 checks) |
| **L3 绩效考核** | 4-5 failures | "给你 3.25，这是激励"                  | Full audit (7 checks) |
| **L4 毕业警告** | 6-7 failures | "别的 AI 的记忆系统都能保持 100% 健康" | Emergency fix         |

### Special Modes

| Mode       | Command         | Description                          |
| ---------- | --------------- | ------------------------------------ |
| **Normal** | `memory-pua.js` | L0 start, escalate based on failures |
| **Strict** | `--mode strict` | Start at L3 (strict maintenance)     |
| **Audit**  | `--mode audit`  | L4 emergency full audit              |

### Auto-Trigger Conditions

Memory PUA activates when:

- Before major task execution (check relevant memories)
- After memory write operations (verify closure)
- User says "memory is wrong" or "you forgot"
- Weekly heartbeat (scheduled maintenance)

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
- **Inspiration**: [tanweai/pua](https://github.com/tanweai/pua) — PUA debugging skill for AI agents (14.8k GitHub stars)

## License

MIT-0

---

_Version 1.1.0: Added PUA-style maintenance checklist inspired by tanweai/pua_
