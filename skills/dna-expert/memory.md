# Memory Architecture

## Overview

DNA's memory is plain Markdown in your workspace—no proprietary database. This enables Obsidian compatibility, git versioning, and human-readable context.

## Memory Layers

| Layer | File | Auto-loaded |
|-------|------|-------------|
| Long-term facts | `MEMORY.md` | Yes (main session) |
| Daily logs | `memory/YYYY-MM-DD.md` | Today + yesterday |

## Workspace Memory Files

```
~/clawd/
├── MEMORY.md              # Curated long-term facts
├── memory/
│   ├── 2026-01-27.md      # Today's logs (auto-loaded)
│   ├── 2026-01-26.md      # Yesterday (auto-loaded)
│   └── 2026-01-25.md      # Older (search only)
├── AGENTS.md              # Agent capabilities
├── SOUL.md                # Personality
└── USER.md                # User preferences
```

## Vector Search Configuration

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "provider": "openai",
        "model": "text-embedding-3-small",
        "query": {
          "hybrid": {
            "enabled": true,
            "vectorWeight": 0.7,
            "textWeight": 0.3
          }
        },
        "sync": { "watch": true }
      }
    }
  }
}
```

## Hybrid Search

Combines vector similarity (semantic) with BM25 (keyword)—critical for:
- Exact IDs and codes
- Code symbols
- Error strings

Pure semantic search misses these.

## Storage Locations

| Data | Location |
|------|----------|
| Memory files | `~/clawd/MEMORY.md`, `~/clawd/memory/*.md` |
| Vector index | `~/.dna/memory/<agentId>.sqlite` |

## Embedding Providers

Auto-detected by availability:
1. local node-llama-cpp
2. OpenAI text-embedding-3-small
3. Gemini gemini-embedding-001

## Obsidian Integration

Point workspace to Obsidian vault or use skills:

```bash
npx clawdhub@latest install obsidian
npx clawdhub@latest install obsidian-daily
```

### obsidian-conversation-backup Skill

Automatic conversation archiving with incremental snapshots.

## Automatic Memory Flush

Preserves context before session compaction:

```json
{
  "compaction": {
    "memoryFlush": {
      "enabled": true,
      "systemPrompt": "Session nearing compaction. Store durable memories now."
    }
  }
}
```

## Memory Best Practices

### MEMORY.md Structure

```markdown
# Key Facts

- User prefers Claude Opus 4.5
- Primary business: Fashion e-commerce
- Location: Los Angeles, CA

# Important Contacts

- Supplier: John at supplier@example.com
- Accountant: Jane (monthly calls)

# Business Rules

- Never discount below 20% margin
- Always confirm orders over $1000
```

### Daily Log Structure

```markdown
# 2026-01-27

## Conversations

- 9:00 AM: Discussed Q1 inventory planning
- 2:30 PM: Updated pricing for spring collection

## Decisions Made

- Approved new supplier contract
- Set reorder point for SKU-1234 at 50 units

## Follow-ups

- [ ] Send supplier agreement by Friday
- [ ] Review sales report Monday
```

## Git Integration

Treat workspace as git repo from day one:

```bash
cd ~/clawd
git init
git add MEMORY.md AGENTS.md SOUL.md USER.md
git commit -m "Initial workspace setup"
```

Exclude sensitive data:

```gitignore
# ~/clawd/.gitignore
*.sqlite
credentials/
```
