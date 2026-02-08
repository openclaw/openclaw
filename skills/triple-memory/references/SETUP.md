# Triple Memory Setup Reference

## Full Config Example

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-lancedb"
    },
    "entries": {
      "memory-lancedb": {
        "enabled": true,
        "config": {
          "embedding": {
            "apiKey": "sk-...",
            "model": "text-embedding-3-small"
          },
          "autoRecall": true,
          "autoCapture": true
        }
      }
    }
  }
}
```

## AGENTS.md Template

Add to your workspace AGENTS.md:

```markdown
## Every Session

Before doing anything else:
1. Read `memory/active-context.md` for current session state
2. Run `sync --start` on git-notes-memory (silently)

## Triple Memory System

### 1. LanceDB (Auto)
- Auto-recall injects `<relevant-memories>` before responses
- Auto-capture stores preferences/decisions

### 2. Git-Notes (Structured)
\`\`\`bash
python3 skills/git-notes-memory/memory.py -p $WORKSPACE sync --start
python3 skills/git-notes-memory/memory.py -p $WORKSPACE remember '{"key":"value"}' -t tags -i h
\`\`\`

### 3. File Search (Workspace)
\`\`\`bash
./scripts/file-search.sh "query" [limit]
\`\`\`
```

## Memory File Templates

### memory/active-context.md
```markdown
# Active Context

## Current Focus
- (what you're working on)

## Recent Decisions
- (key decisions made)

## Open Tasks
- [ ] Task 1
- [ ] Task 2
```

### MEMORY.md
```markdown
# Long-Term Memory

## Key Info
- (important persistent info)

## Lessons Learned
- (things to remember)
```
