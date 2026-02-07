# Cortex Memory Architecture

## Overview

Cortex is a three-tier memory system designed for multi-agent workflows with GPU-accelerated semantic search. It provides persistent context that survives conversation compaction and enables agents to share knowledge across sessions.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agent Context                            │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │   Working    │  │    STM       │  │   Semantic Memory     │  │
│  │   Memory     │  │  (Recent)    │  │   (Long-term)         │  │
│  │  (Pinned)    │  │              │  │                       │  │
│  │              │  │  ~48h decay  │  │  GPU embeddings       │  │
│  │  ALWAYS in   │  │  Keyword +   │  │  Vector similarity    │  │
│  │  context     │  │  Category    │  │  + temporal weight    │  │
│  └──────────────┘  └──────────────┘  └───────────────────────┘  │
│         ▲                 ▲                     ▲                │
│         │                 │                     │                │
│    working_memory    cortex_stm           memory_search         │
│    tool (pin/view)   tool (view)          (semantic)            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │   GPU Embeddings Daemon       │
              │   (localhost:8030)            │
              │                               │
              │   sentence-transformers       │
              │   all-MiniLM-L6-v2            │
              │   RTX 5090                    │
              └───────────────────────────────┘
```

## Memory Tiers

### 1. Working Memory (Episodic)

**Purpose**: Critical context that must NEVER be lost to compaction.

- **Storage**: `~/.openclaw/workspace/memory/working_memory.json`
- **Capacity**: 10 items max (FIFO eviction)
- **Injection**: Always prepended to context via `before_agent_start` hook
- **Tool**: `working_memory` (aliases: `wm`)

**Use cases**:
- Active task instructions ("currently implementing feature X")
- Critical decisions that span multiple sessions
- User preferences that affect current work
- Active project context

**Example**:
```
<working-memory hint="CRITICAL: pinned items - always keep in context">
- [active-task] Implementing GPU embeddings integration for Cortex
- [user-pref] User prefers verbose explanations with code examples
</working-memory>
```

### 2. Short-Term Memory (STM)

**Purpose**: Fast O(1) access to recent context with intelligent relevance scoring.

- **Storage**: `~/.openclaw/workspace/memory/stm.json`
- **Capacity**: 50 items (configurable via `stmCapacity`)
- **Decay**: Exponential with ~48-hour half-life
- **Tool**: `cortex_stm`

**Scoring algorithm**:
```
matchScore = (keywordScore × relevanceWeight) +
             (recencyScore × temporalWeight) +
             (importanceScore × importanceWeight) +
             categoryBonus
```

Where:
- `keywordScore`: Term overlap + exact phrase bonus
- `recencyScore`: `exp(-ageHours / 48)`
- `importanceScore`: Normalized 1-3 scale
- `categoryBonus`: +0.1 base + 0.1 per matching category

**Categories**: Loaded dynamically from `categories.json`. Default includes:
- `trading`, `moltbook`, `coding`, `meta`, `learning`, `personal`, `system`, `general`

**PHASE 3**: Multi-category support - memories can belong to multiple categories simultaneously.

### 3. Semantic Memory (Long-term)

**Purpose**: Knowledge retrieval via vector similarity, independent of exact wording.

- **Storage**: SQLite with embeddings (`~/.openclaw/workspace/memory/embeddings.db`)
- **Model**: all-MiniLM-L6-v2 (384 dimensions)
- **Access**: GPU embeddings daemon (localhost:8030) with Python fallback

**Query flow**:
1. Generate embedding for query text
2. Cosine similarity search in vector store
3. Apply temporal weighting to results
4. Filter by `minMatchScore` threshold (default: 0.3)
5. Deduplicate against STM results

## GPU Embeddings Daemon

The embeddings daemon provides fast, GPU-accelerated vector operations:

```
~/.openclaw/workspace/memory/embeddings_daemon.py
```

**Endpoints**:
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Check daemon availability |
| `/embed` | POST | Generate embeddings for text |
| `/store` | POST | Store memory with embedding |
| `/search` | POST | Semantic search |
| `/stats` | GET | Database statistics |

**Fallback**: If daemon unavailable, Cortex falls back to Python subprocess calls (slower but always available).

## Context Injection Flow

```
before_agent_start hook
         │
         ▼
┌─────────────────────────┐
│ 1. Load Working Memory  │  ← Always first, CRITICAL items
│    (pinned items)       │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 2. STM Keyword Match    │  ← Fast O(1), recent context
│    (top 3 by score)     │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 3. Semantic Search      │  ← GPU-accelerated, long-term
│    (top 3, deduplicated)│
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Prepend to prompt       │
│ as structured context   │
└─────────────────────────┘
```

**Output format**:
```xml
<working-memory hint="CRITICAL: pinned items - always keep in context">
- [label] content...
</working-memory>

<episodic-memory hint="recent events (last 48h)">
- [category/recency] content...
</episodic-memory>

<semantic-memory hint="related knowledge from long-term memory">
- [category/score=0.85] content...
</semantic-memory>
```

## Auto-Capture System

Cortex automatically captures significant conversation moments via the `agent_end` hook.

**Importance triggers**:
| Pattern | Importance |
|---------|------------|
| `lesson learned`, `realized that` | 2.5 |
| `important:`, `critical:`, `key insight` | 2.5 |
| `remember this`, `don't forget` | 2.0 |
| `decision:`, `chose to`, `decided to` | 2.0 |
| `bug fix`, `fixed`, `resolved` | 1.5 |
| `created`, `built`, `implemented` | 1.5 |
| `preference`, `prefer`, `like to` | 1.5 |

**Capture criteria**:
- Content length: 20-1000 characters
- No tool outputs or system messages
- Importance >= 1.5
- Not markdown-heavy (< 3 code blocks)

## Configuration

```typescript
configSchema: Type.Object({
  enabled: Type.Boolean({ default: true }),
  autoCapture: Type.Boolean({ default: true }),
  stmFastPath: Type.Boolean({ default: true }),
  temporalRerank: Type.Boolean({ default: true }),
  temporalWeight: Type.Number({ default: 0.5 }),      // Recency importance
  importanceWeight: Type.Number({ default: 0.4 }),    // User-assigned importance
  stmCapacity: Type.Number({ default: 50 }),          // Max STM items
  minMatchScore: Type.Number({ default: 0.3 }),       // Filter threshold
  episodicMemoryTurns: Type.Number({ default: 20 }),  // Working memory turns
})
```

## Tools Reference

### `working_memory` (alias: `wm`)

Manage episodic working memory.

| Action | Description |
|--------|-------------|
| `pin` | Add item (content required, optional label) |
| `view` | List all pinned items |
| `unpin` | Remove item by index |
| `clear` | Remove all items |

### `cortex_add`

Store memory with importance rating. **PHASE 3: Multi-category support.**

| Parameter | Description |
|-----------|-------------|
| `content` | Memory text |
| `category` | Single category (deprecated, use categories) |
| `categories` | Array of categories (e.g., `["technical", "trading"]`) |
| `importance` | 1.0 (routine) to 3.0 (critical) |

### `cortex_stm`

View recent short-term memory. **PHASE 3: Multi-category support.**

| Parameter | Description |
|-----------|-------------|
| `limit` | Max items (default: 10) |
| `category` | Filter by single category |
| `categories` | Filter by multiple categories (any match) |

### `cortex_stats`

Show memory system statistics (RAM cache, hot tier, token budget).

### `cortex_dedupe` (PHASE 3)

Find and handle duplicate memories.

| Parameter | Description |
|-----------|-------------|
| `category` | Scope to single category |
| `categories` | Scope to multiple categories |
| `similarity_threshold` | Content similarity 0-1 (default: 0.95) |
| `action` | `report`, `merge`, or `delete_older` |

**Actions**:
- `report`: List duplicate groups without changes
- `merge`: Keep newest, sum access_counts, keep highest importance
- `delete_older`: Keep most recent, remove duplicates

### `cortex_update` (PHASE 3)

Update memory importance or categories.

| Parameter | Description |
|-----------|-------------|
| `memory_id` | Memory ID, timestamp, or content snippet |
| `importance` | New importance score 1.0-3.0 |
| `categories` | New categories array |

### `cortex_edit` (PHASE 3)

Edit or append to existing memory content.

| Parameter | Description |
|-----------|-------------|
| `memory_id` | Memory ID or content snippet to match |
| `append` | Content to add to existing memory |
| `replace` | New content to replace memory |

Content changes trigger automatic re-embedding via GPU daemon.

### `cortex_move` (PHASE 3)

Move memory to different categories.

| Parameter | Description |
|-----------|-------------|
| `memory_id` | Memory ID or content snippet to match |
| `to_categories` | New categories array (replaces existing) |

No re-embedding needed (content unchanged).

## Multi-Agent Context Sharing

Cortex enables context sharing across agents through:

1. **Shared STM file**: All agents read/write the same `stm.json`
2. **Shared embeddings database**: Semantic search spans all stored memories
3. **Category tagging**: Agents can query by category to find relevant context
4. **Working memory**: Pinned items are shared across all agent invocations

**Best practices**:
- Use `cortex_add` with explicit categories for cross-agent knowledge
- Pin critical shared context with `working_memory pin`
- Use high importance (2.0+) for decisions that affect multiple agents
- Query with category filters when looking for specific types of context

## Performance Characteristics

| Operation | Typical Latency |
|-----------|-----------------|
| Working memory load | < 1ms |
| STM keyword match | < 5ms |
| GPU semantic search | 10-50ms |
| Python fallback search | 200-500ms |
| Memory store (GPU) | 20-100ms |

## File Layout

### Source Code (in repo)
```
extensions/cortex/
├── index.ts                    # Plugin entry point, tools, hooks
├── cortex-bridge.ts            # TypeScript-Python bridge
├── ARCHITECTURE.md             # This file
├── openclaw.plugin.json        # Plugin manifest
└── python/                     # Python backend (PHASE 3: moved to repo)
    ├── stm_manager.py          # STM operations
    ├── embeddings_daemon.py    # GPU server (flask)
    ├── embeddings_manager.py   # Python embedding operations
    ├── collections_manager.py  # Collections operations
    ├── local_embeddings.py     # sentence-transformers wrapper
    ├── maintenance.py          # Cleanup and sync
    └── ...
```

### Data Files (in user home)
```
~/.openclaw/workspace/memory/
├── stm.json                    # Short-term memory data
├── working_memory.json         # Pinned items
├── categories.json             # Dynamic category definitions
├── .local_embeddings.db        # SQLite vector store (GPU daemon)
├── .embeddings.db              # SQLite vector store (fallback)
└── collections/                # Collection files by category
```

Python scripts use the `CORTEX_DATA_DIR` environment variable to locate data files.
The TypeScript bridge sets this automatically when spawning Python processes.

## Troubleshooting

### GPU daemon not responding

```bash
# Check if daemon is running
curl http://localhost:8030/health

# Start daemon manually (set data dir)
cd /path/to/helios/extensions/cortex/python
CORTEX_DATA_DIR=~/.openclaw/workspace/memory python3 embeddings_daemon.py
```

### STM not matching expected items

- Check `minMatchScore` threshold (lower = more results)
- Verify query terms are > 2 characters
- Check category detection for query

### Working memory not persisting

- Verify write permissions on `working_memory.json`
- Check max 10 item limit (oldest items are evicted)

---

**Last Updated**: 2026-02-07
**Cortex Version**: 2.0.0 (Phase 3 - Multi-category, Dedup, Edit tools)
