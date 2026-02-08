---
name: vestige
description: Cognitive memory system using FSRS-6 spaced repetition. Memories fade naturally like human memory. Use for persistent recall across sessions.
---

# Vestige Memory Skill

Cognitive memory system based on 130 years of memory research. FSRS-6 spaced repetition, spreading activation, synaptic tagging—all running 100% local.

## Binary Location

```
~/bin/vestige-mcp
~/bin/vestige
~/bin/vestige-restore
```

## When to Use

- **Persistent memory** across sessions
- **User preferences** ("I prefer TypeScript", "I always use dark mode")
- **Bug fixes** and solutions worth remembering
- **Project patterns** and architectural decisions
- **Reminders** and future triggers

## Quick Commands

### Search Memory

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"query":"user preferences"}}}' | ~/bin/vestige-mcp 2>/dev/null | jq -r '.result.content[0].text // .error.message'
```

### Save Memory (Smart Ingest)

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"smart_ingest","arguments":{"content":"User prefers Swiss Modern design style for presentations","tags":["preference","design"]}}}' | ~/bin/vestige-mcp 2>/dev/null | jq -r '.result.content[0].text // .error.message'
```

### Simple Ingest

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ingest","arguments":{"content":"TKPay Offline project: POC 2 months, MVP 2 months, budget 250K DH","tags":["project","tkpay"]}}}' | ~/bin/vestige-mcp 2>/dev/null | jq -r '.result.content[0].text // .error.message'
```

### Check Stats

```bash
~/bin/vestige stats
```

### Health Check

```bash
~/bin/vestige health
```

## MCP Tools Available

| Tool | Description |
|------|-------------|
| `search` | Unified search (keyword + semantic + hybrid) |
| `smart_ingest` | Intelligent ingestion with duplicate detection |
| `ingest` | Simple memory storage |
| `memory` | Get, delete, or check memory state |
| `codebase` | Remember patterns and architectural decisions |
| `intention` | Set reminders and future triggers |
| `promote_memory` | Mark memory as helpful (strengthens) |
| `demote_memory` | Mark memory as wrong (weakens) |

## Trigger Words

| User Says | Action |
|-----------|--------|
| "Remember this" | `smart_ingest` immediately |
| "Don't forget" | `smart_ingest` with high priority |
| "I always..." / "I never..." | Save as preference |
| "I prefer..." / "I like..." | Save as preference |
| "This is important" | `smart_ingest` + `promote_memory` |
| "Remind me..." | Create `intention` |

## Session Start Routine

At the start of conversations, search for relevant context:

```bash
# Search user preferences
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"query":"user preferences instructions"}}}' | ~/bin/vestige-mcp 2>/dev/null | jq -r '.result.content[0].text'

# Search project context
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"query":"current project context"}}}' | ~/bin/vestige-mcp 2>/dev/null | jq -r '.result.content[0].text'
```

## Helper Script

For easier usage, create `~/bin/vmem`:

```bash
#!/bin/bash
# Vestige Memory Helper
ACTION=$1
shift

case $ACTION in
  search)
    echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"search\",\"arguments\":{\"query\":\"$*\"}}}" | ~/bin/vestige-mcp 2>/dev/null | jq -r '.result.content[0].text // .error.message'
    ;;
  save)
    echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"smart_ingest\",\"arguments\":{\"content\":\"$*\"}}}" | ~/bin/vestige-mcp 2>/dev/null | jq -r '.result.content[0].text // .error.message'
    ;;
  stats)
    ~/bin/vestige stats
    ;;
  *)
    echo "Usage: vmem [search|save|stats] [content]"
    ;;
esac
```

## Data Location

- **macOS**: `~/Library/Application Support/com.vestige.core/`
- **Linux**: `~/.local/share/vestige/`
- **Embedding cache**: `~/Library/Caches/com.vestige.core/fastembed/`

## Integration Notes

Vestige complements the existing `memory/` folder system:
- **memory/*.md** = Human-readable daily logs
- **MEMORY.md** = Curated long-term notes
- **Vestige** = Semantic search + automatic decay + spaced repetition

Use Vestige for:
- Things you want to recall semantically (not just keyword search)
- Preferences that should persist indefinitely
- Solutions worth remembering (with automatic decay if unused)
