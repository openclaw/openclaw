# Progressive Memory System — Full Design

**Author**: Claw (main agent)  
**Date**: 2026-02-04  
**Status**: Active — Implementation In Progress  
**Assigned Agent**: `clawdbrain` (via `sessions_spawn`)

---

## 1. Current Memory Architecture (As-Is)

### 1.1 Entry Points

The agent has exactly **two MCP tools** for memory:

| Tool            | Purpose                                                               | Implementation                                                      |
| --------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `memory_search` | Semantic search across MEMORY.md + memory/\*.md + session transcripts | `src/agents/tools/memory-tool.ts` → `MemoryIndexManager.search()`   |
| `memory_get`    | Read specific lines from a memory file                                | `src/agents/tools/memory-tool.ts` → `MemoryIndexManager.readFile()` |

Additionally, the agent can **read/write** any file directly via the `read`/`write` tools, so MEMORY.md and memory/*.md can also be edited directly. But `memory_search` and `memory_get` are the only *semantically aware\* entry points.

### 1.2 Storage Layers

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent MCP Tools                           │
│         memory_search    memory_get    read/write            │
└──────────┬──────────────────┬────────────────┬──────────────┘
           │                  │                │
           ▼                  ▼                ▼
┌──────────────────────────────────────────────────────────────┐
│               MemoryIndexManager (manager.ts)                 │
│                                                               │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐│
│  │ Vector Store │  │   FTS5 Index │  │   Embedding Cache    ││
│  │ (sqlite-vec) │  │  (sqlite)    │  │   (sqlite)           ││
│  └──────┬──────┘  └──────┬───────┘  └──────────────────────┘│
│         │                │                                    │
│         └────────────────┴── SQLite DB per agent             │
│              (hybrid search: cosine + BM25)                   │
└──────────────────────────────────────────────────────────────┘
           │                  │
           ▼                  ▼
┌─────────────────────┐  ┌─────────────────────────────────────┐
│ Markdown Files       │  │ Session Transcripts (JSONL)          │
│                      │  │                                      │
│ • MEMORY.md (24KB)   │  │ • ~/.openclaw/sessions/<agent>/*.jsonl│
│ • memory/*.md        │  │ • Parsed: role + content text         │
│   - 2026-01-25.md    │  │ • Redacted for sensitive content      │
│   - 2026-02-04.md    │  │ • Chunked + embedded like md files    │
│   - reflections.md   │  │                                      │
│   - capture-state    │  │                                      │
└─────────────────────┘  └─────────────────────────────────────┘
```

### 1.3 How It Works

1. **Indexing**: `MemoryIndexManager` watches `MEMORY.md`, `memory/*.md`, and session JSONL files via chokidar. On change, it re-chunks the file (markdown aware, ~256 token chunks with overlap), generates embeddings (OpenAI text-embedding-3-small by default), and stores in SQLite.

2. **Search**: Hybrid approach — vector cosine similarity + BM25 full-text search, merged with configurable weights. Returns top-N snippets with file path, line numbers, and score.

3. **Get**: Direct file read with optional line range. Memory-path-validated (only allows MEMORY.md and memory/\* paths).

4. **System Prompt Integration**: The system prompt (`src/agents/system-prompt.ts`) includes a "Memory Recall" section that instructs the agent to call `memory_search` before answering questions about prior work, decisions, dates, people, or preferences.

### 1.4 Current Problems

| Problem                            | Impact                                                                                                                                  | Severity                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **MEMORY.md is monolithic**        | 24KB, 439 lines loaded in full every session start. Contains everything from channel IDs to architecture deep-dives to wedding details. | High — wastes context tokens    |
| **No progressive disclosure**      | All memory content competes equally. The OpenClaw architecture section costs tokens even when asking about the wedding.                 | High — context pressure         |
| **No structured data**             | Everything is markdown prose. Can't query "what are David's active projects?" without parsing free text.                                | Medium — limits recall quality  |
| **No separation of concerns**      | Preferences, facts, instructions, and project state all live in one flat file. No semantic categories.                                  | Medium — hard to maintain       |
| **Session transcripts are noisy**  | Raw JSONL contains tool calls, system messages, and noise. Useful signal is buried.                                                     | Low — already redacted/filtered |
| **No write-back from search**      | Agent can write files but there's no structured "remember this" tool that categorizes and deduplicates.                                 | Medium — fragile persistence    |
| **Memory and daily notes overlap** | `memory/YYYY-MM-DD.md` (daily notes) vs `MEMORY.md` (long-term). No clear graduation process.                                           | Low — convention-based          |
| **No token budget awareness**      | MEMORY.md is injected without regard to how much context remains. No prioritization.                                                    | Medium — could overflow context |

---

## 2. Progressive Memory System (To-Be)

### 2.1 Design Principles

1. **New tools alongside old** — Never remove or modify `memory_search` / `memory_get`. New tools are additive.
2. **Progressive disclosure** — Always-loaded index (<2K tokens) + on-demand domain files
3. **Multiple storage backends** — Markdown for human-readable, SQLite for structured queries, vector store for semantic search
4. **Categorized memory** — Separate concerns into typed memory entries
5. **Token-aware** — Budget-conscious loading with priority tiers
6. **Graceful degradation** — If new system fails, old `memory_search`/`memory_get` still work exactly as before

### 2.2 Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         Agent MCP Tools                                   │
│                                                                           │
│  EXISTING (unchanged):          NEW (additive):                           │
│  • memory_search                • memory_store        (structured write)  │
│  • memory_get                   • memory_recall       (smart retrieval)   │
│                                 • memory_index_status (health/stats)      │
│                                 • memory_audit        (token analysis)    │
└──────────┬──────────────────────────────────┬────────────────────────────┘
           │                                  │
           ▼                                  ▼
┌─────────────────────────┐    ┌──────────────────────────────────────────┐
│  EXISTING Memory System  │    │         NEW Progressive Memory Engine     │
│  (untouched)             │    │                                           │
│  • MemoryIndexManager    │    │  ┌────────────────────┐                   │
│  • MEMORY.md + memory/*  │    │  │  Memory Index       │                  │
│  • Session transcripts   │    │  │  (always loaded)    │                  │
│  • Vector + FTS search   │    │  │  ~1500 tokens       │                  │
│                          │    │  └────────┬───────────┘                   │
│                          │    │           │                                │
│                          │    │  ┌────────▼───────────┐                   │
│                          │    │  │  Structured Store    │                  │
│                          │    │  │  (SQLite + JSON)     │                  │
│                          │    │  │  • Categories        │                  │
│                          │    │  │  • Priority tiers    │                  │
│                          │    │  │  • Relationships     │                  │
│                          │    │  │  • Token costs       │                  │
│                          │    │  └────────┬───────────┘                   │
│                          │    │           │                                │
│                          │    │  ┌────────▼───────────┐                   │
│                          │    │  │  Domain Files        │                  │
│                          │    │  │  (on-demand load)    │                  │
│                          │    │  │  memory/domains/*.md │                  │
│                          │    │  └────────────────────┘                   │
└─────────────────────────┘    └──────────────────────────────────────────┘
```

### 2.3 New MCP Tools

#### Tool: `memory_store`

**Purpose**: Structured memory write with categorization, deduplication, and priority.

```typescript
// Parameters
{
  category: "preference" | "instruction" | "fact" | "project" | "person" | "decision" | "insight",
  content: string,           // The actual memory content
  context?: string,          // Why this is being stored (for future relevance assessment)
  priority?: "critical" | "high" | "medium" | "low",  // Default: "medium"
  tags?: string[],           // Freeform tags for cross-referencing
  related_to?: string[],     // IDs of related memory entries
  expires?: string,          // ISO date — auto-archive after this date
}

// Returns
{
  id: string,                // Unique memory entry ID
  category: string,
  stored: boolean,
  deduplicated: boolean,     // True if merged with existing similar entry
  token_cost: number,        // Estimated token cost of this entry
}
```

**Storage**: Writes to SQLite structured store AND generates a markdown representation in `memory/domains/<category>.md` for human readability and backward compatibility with `memory_search`.

#### Tool: `memory_recall`

**Purpose**: Smart retrieval that combines semantic search with structured queries and token-budget awareness.

```typescript
// Parameters
{
  query: string,                    // Natural language query
  categories?: string[],            // Filter by category
  priority_min?: string,            // Minimum priority to include
  token_budget?: number,            // Max tokens to return (default: 3000)
  include_context?: boolean,        // Include storage context (default: false)
  format?: "brief" | "detailed",   // Output verbosity (default: "brief")
}

// Returns
{
  entries: Array<{
    id: string,
    category: string,
    content: string,
    priority: string,
    score: number,
    stored_at: string,
    tags: string[],
  }>,
  token_count: number,
  budget_remaining: number,
  total_entries_matched: number,
}
```

**Key difference from `memory_search`**: Returns structured, categorized entries within a token budget, not raw file snippets. Uses the structured store for filtering and ranking, then falls back to `memory_search` for anything not yet migrated.

#### Tool: `memory_index_status`

**Purpose**: Health and statistics for the memory system.

```typescript
// Returns
{
  legacy: {
    files: number,
    chunks: number,
    total_tokens_estimated: number,
    memory_md_size: number,
    memory_dir_files: number,
  },
  progressive: {
    total_entries: number,
    by_category: Record<string, number>,
    by_priority: Record<string, number>,
    total_tokens_estimated: number,
    last_store: string,      // ISO timestamp
    last_recall: string,     // ISO timestamp
    domain_files: string[],
  },
  index: {
    always_loaded_tokens: number,
    on_demand_domains: Array<{ name: string, tokens: number }>,
  }
}
```

#### Tool: `memory_audit`

**Purpose**: Token audit — analyze current memory usage and recommend optimizations.

```typescript
// Parameters
{
  scope?: "all" | "memory_md" | "domains" | "system_prompt",
  recommend?: boolean,       // Generate optimization recommendations
}

// Returns
{
  analysis: {
    total_tokens: number,
    breakdown: Array<{
      source: string,
      tokens: number,
      percentage: number,
      category: string,
    }>,
    duplicates: Array<{
      content_a: string,
      content_b: string,
      similarity: number,
      sources: string[],
    }>,
  },
  recommendations?: Array<{
    action: string,
    description: string,
    estimated_savings_tokens: number,
    risk: "low" | "medium" | "high",
  }>,
}
```

### 2.4 Memory Index (Always-Loaded Component)

The memory index replaces the monolithic MEMORY.md load with a lean, always-in-context summary. Target: **<1500 tokens**.

**Structure** (auto-generated from structured store):

```markdown
# Memory Index

## Critical (always relevant)

- [P] David: America/Denver, Slack U0A9JFQU3S9, efficient+conversational tone
- [I] Never send external messages without asking first
- [I] Track all tasks in #cb-activity (C0AB5HERFFT)
- [P] Trading lingo welcome ("bullish"/"bearish")
- [I] Audio reports → TTS → #cb-notifications
- [I] Long builds → maximum autonomy, batch questions

## Channels

cb-inbox:C0AAP72R7L5 | cb-ideas:C0AB5HFJQM7 | cb-activity:C0AB5HERFFT | cb-notifications:C0AAQJBCU0N | cb-questions:C0AAL8G8C4T | cb-reflections:C0AB5HGRAV7 | cb-bugs:C0AB81Q2VUH | cb-active-work:C0AB924E6E5 | cb-task-completion:C0AAELGRP7Z

## Active Projects → `memory_recall(categories:["project"])`

- OpenClaw/Clawdbrain — agent gateway, main focus
- AI Consulting — $2k/mo target, sprint offer
- Cloud Cell Provisioner — Go, hex arch
- Wedding — Black Canyon Inn

## Domains (use memory_recall to load)

- [openclaw] Architecture, repos, dev patterns
- [people] David details, contacts, relationships
- [preferences] Communication, workflow, tools
- [goals] Career, business, personal targets

[P]=preference [I]=instruction — Full entries via memory_recall
```

This index is injected into the system prompt instead of the full MEMORY.md. The agent uses `memory_recall` to load domain-specific details on demand.

### 2.5 Domain Files (On-Demand)

Located in `memory/domains/`:

| File              | Content                                          | Loaded When                   |
| ----------------- | ------------------------------------------------ | ----------------------------- |
| `openclaw.md`     | Architecture, repos, dev patterns, UI split      | Working on OpenClaw code      |
| `people.md`       | David details, contacts, work info               | People-related queries        |
| `preferences.md`  | Communication style, tools, workflow preferences | Tone/approach questions       |
| `goals.md`        | Career, business, personal targets, timelines    | Planning/strategy discussions |
| `projects.md`     | Active projects, status, key details             | Project work                  |
| `decisions.md`    | Key decisions made, with context and reasoning   | Revisiting past choices       |
| `instructions.md` | Explicit rules and directives                    | Behavioral calibration        |

### 2.6 Structured Store (SQLite)

New SQLite database: `~/.openclaw/memory/progressive.db`

**Schema**:

```sql
CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,           -- preference, instruction, fact, project, person, decision, insight
  content TEXT NOT NULL,
  context TEXT,                      -- why this was stored
  priority TEXT DEFAULT 'medium',    -- critical, high, medium, low
  tags TEXT,                         -- JSON array
  related_to TEXT,                   -- JSON array of entry IDs
  source TEXT,                       -- where this came from (session, manual, migration)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,                   -- auto-archive date
  token_estimate INTEGER,
  embedding BLOB,                    -- vector embedding for semantic search
  archived INTEGER DEFAULT 0
);

CREATE INDEX idx_category ON memory_entries(category);
CREATE INDEX idx_priority ON memory_entries(priority);
CREATE INDEX idx_archived ON memory_entries(archived);
CREATE INDEX idx_created ON memory_entries(created_at);

-- FTS5 for full-text search
CREATE VIRTUAL TABLE memory_entries_fts USING fts5(
  content, context, tags,
  content=memory_entries,
  content_rowid=rowid
);

-- Vector similarity search
CREATE VIRTUAL TABLE memory_entries_vec USING vec0(
  embedding float[1536]
);
```

### 2.7 Token Audit Layer

The token audit operates at two levels:

1. **Static analysis** — Counts tokens in MEMORY.md, memory/\*.md, system prompt sections, and skill metadata. Identifies duplicates across sources. Run via `memory_audit` tool.

2. **Runtime budget** — The progressive memory index tracks estimated token costs. When loading on-demand content, it respects a token budget and prioritizes by entry priority.

**Audit targets**:

- MEMORY.md ↔ system prompt overlap
- MEMORY.md ↔ skill description overlap
- Entries within MEMORY.md that duplicate each other
- Domain files with stale content (not accessed in 30+ days)

---

## 3. Migration Strategy

### 3.1 Phase 1 — New Tools (No Breaking Changes)

1. Create `src/agents/tools/memory-store-tool.ts` — implements `memory_store`
2. Create `src/agents/tools/memory-recall-tool.ts` — implements `memory_recall`
3. Create `src/agents/tools/memory-index-status-tool.ts` — implements `memory_index_status`
4. Create `src/agents/tools/memory-audit-tool.ts` — implements `memory_audit`
5. Create `src/memory/progressive-store.ts` — SQLite structured store
6. Create `src/memory/progressive-index.ts` — Index generation logic
7. Register all new tools in `src/agents/pi-tools.ts` alongside existing tools

**CRITICAL**: `memory_search` and `memory_get` remain completely untouched.

### 3.2 Phase 2 — Populate Structured Store

1. Create migration script: `scripts/migrate-memory-to-progressive.ts`
2. Parse MEMORY.md into categorized entries
3. Parse memory/\*.md files
4. Store all entries in progressive.db
5. Generate domain files in `memory/domains/`
6. Generate the lean memory index

### 3.3 Phase 3 — System Prompt Integration

1. Modify `src/agents/system-prompt.ts` to inject the memory index instead of raw MEMORY.md reference
2. Add a "Progressive Memory" section to the system prompt explaining the new tools
3. Keep the existing "Memory Recall" section pointing to `memory_search`/`memory_get` as fallback

### 3.4 Phase 4 — Token Audit

1. Implement the `memory_audit` tool
2. Run initial audit
3. Apply recommended deduplication

---

## 4. Safety & Rollback

### 4.1 Safeguards

- **MEMORY.md is never modified or deleted** by the migration. It remains the source of truth.
- **`memory_search`/`memory_get` are never changed.** Old code paths work identically.
- **New tools are additive** — if they break, the agent still has full access to the old system.
- **Structured store is write-forward** — entries are added, never deleted (only archived).
- **Domain files are regenerated** from the structured store. If corrupted, re-run migration.

### 4.2 Rollback Plan

If the progressive system causes issues:

1. Remove new tools from tool registry (`src/agents/pi-tools.ts`)
2. Revert system prompt changes
3. Agent falls back to MEMORY.md + `memory_search`/`memory_get` exactly as before
4. Zero data loss — MEMORY.md and memory/\*.md are untouched

### 4.3 Validation Before Activation

Before enabling system prompt changes:

1. All new tools must pass unit tests
2. `memory_recall` must return results equivalent to `memory_search` for the same queries
3. Token count of the memory index must be verified < 2000 tokens
4. `memory_store` → `memory_recall` round-trip must work
5. Domain files must be valid markdown readable by `memory_get`

---

## 5. Future Enhancements & Proposals

### 5.1 Graph-Based Memory (Neo4j / Graphiti Integration)

**Description**: The existing `clawd-memory` skill has a Neo4j knowledge graph with entities (User, Preference, Instruction, Project, Concept, Episode) and relationships. The progressive memory system could use this as a third storage backend for relationship-aware queries like "what projects use this technology?" or "what preferences have changed over time?"

**New tools required**:

- `memory_graph_query` — Cypher queries against the knowledge graph
- `memory_graph_ingest` — Add facts/relationships to the graph

**Benefits**: Relationship-aware recall, temporal tracking, multi-hop reasoning  
**Complexity**: Medium — Neo4j already running, just needs tool wrappers  
**Changes**: New tools + graph sync from progressive store

### 5.2 Temporal Memory Decay

**Description**: Entries lose priority over time unless reinforced. An "importance score" decays logarithmically, with reinforcement on access. Stale entries get auto-archived.

**New tools required**:

- `memory_reinforce` — Explicitly mark a memory as still relevant

**Benefits**: Self-pruning memory, automatic relevance management  
**Complexity**: Low — scoring function on existing schema  
**Changes**: Decay calculation in progressive-store.ts

### 5.3 Cross-Session Memory Consolidation

**Description**: A cron job that periodically reviews session transcripts, extracts significant memories, and stores them via `memory_store`. Like sleeping and consolidating short-term into long-term memory.

**New tools required**: None (uses existing `memory_store` internally)  
**Benefits**: Automatic knowledge capture, reduced manual "remember this" burden  
**Complexity**: Medium — needs LLM call to extract significance  
**Changes**: New cron job + consolidation logic

### 5.4 Embedding Model Upgrade

**Description**: Move from OpenAI `text-embedding-3-small` to a local embedding model (nomic-embed-text, all-MiniLM) for zero-cost, zero-latency embeddings. The infrastructure already supports local embeddings via node-llama.

**New tools required**: None (backend change)  
**Benefits**: Free, fast, private, no API dependency  
**Complexity**: Low — already partially supported  
**Changes**: Config change + model download

### 5.5 Memory Sharing Across Agents

**Description**: Sub-agents currently don't have access to the main agent's memory. A shared memory layer would let sub-agents query relevant context without duplicating MEMORY.md into every workspace.

**New tools required**:

- `memory_shared_recall` — Query shared memory from any agent session

**Benefits**: Better sub-agent context, reduced duplication  
**Complexity**: High — needs session isolation + access control  
**Changes**: New tool + memory scope resolution

---

## 6. Implementation Checklist

See `WORK-QUEUE.md` in this workspace for the detailed task breakdown with acceptance criteria.
