# ClawMongo: MongoDB-Native Memory Architecture Brainstorm

**Date:** 2026-02-15
**Status:** BRAINSTORM (no code — planning only)
**Author:** Research synthesis from OpenClaw deep dive + MongoDB AI agent best practices + real-life testing

---

## Table of Contents

1. [The Problem: Why MongoDB is "Better SQLite" Today](#1-the-problem)
2. [How OpenClaw Memory Actually Works (Ground Truth)](#2-how-openclaw-memory-works)
3. [Gap Analysis: What MongoDB CAN Do vs What We Use](#3-gap-analysis)
4. [MongoDB's Official AI Agent Memory Architecture](#4-mongodb-official-architecture)
5. [The Vision: MongoDB as Active Knowledge Engine](#5-the-vision)
6. [Proposed Collection Architecture](#6-proposed-collections)
7. [KB Ingestion: Making It Out-of-the-Box](#7-kb-ingestion)
8. [New Agent Tools](#8-new-agent-tools)
9. [Data Flow Diagrams](#9-data-flow)
10. [Upstream Compatibility Strategy](#10-upstream-compatibility)
11. [Open Questions & Trade-offs](#11-open-questions)
12. [Phased Roadmap](#12-roadmap)

---

## 1. The Problem: Why MongoDB is "Better SQLite" Today {#1-the-problem}

### What Real-Life Testing Revealed

After publishing `@romiluz/clawmongo@2.0.0-rc.5` and running it against a real Telegram bot, two critical issues surfaced:

1. **The bot favors MEMORY.md over MongoDB** — It writes observations to `MEMORY.md` on disk, not to MongoDB. The system prompt explicitly says "run memory_search on MEMORY.md + memory/\*.md". MongoDB is invisible to the agent.

2. **Data is not modeled correctly** — MongoDB stores the exact same chunked text that SQLite stores. Same pipeline, same schema, same limitations. No structured data, no typed observations, no knowledge base.

### The Identity Problem

Today's data pipeline is **identical** across all three backends:

```
SQLite:   disk .md files → chunk (400 tok, 80 overlap) → embed → SQLite FTS
QMD:      disk .md files → chunk (400 tok, 80 overlap) → embed → QMD index
MongoDB:  disk .md files → chunk (400 tok, 80 overlap) → embed → MongoDB collections
```

MongoDB is acting as a **passive index over flat files**, not as a database. It has:

- No structured data (just chunked text blobs)
- No knowledge base (only indexes what's already on disk)
- No direct writes from the agent (agent writes to MEMORY.md, file watcher syncs)
- No data that doesn't also exist as a .md or .jsonl file on disk

**The bot's own diagnosis** (from real testing): "The agent is currently just a Chat Logger with Vector Search. It is missing the Active Knowledge Graph logic to structure data into specific collections."

### Root Causes

| Root Cause                                        | Location                     | Impact                                     |
| ------------------------------------------------- | ---------------------------- | ------------------------------------------ |
| System prompt says "MEMORY.md + memory/\*.md"     | `system-prompt.ts:53`        | Agent only thinks about .md files          |
| `memory_search` tool description says "MEMORY.md" | `memory-tool.ts:44`          | Agent anchors to files, not database       |
| `memory_get` reads from DISK, not MongoDB         | `mongodb-manager.ts:285-344` | Even readFile() bypasses MongoDB           |
| `sessionMemory` defaults to `false`               | `memory-search.ts:127`       | Session transcripts not indexed by default |
| `sources` defaults to `["memory"]` only           | `memory-search.ts:88`        | "sessions" source excluded by default      |
| No `memory_write` tool exists                     | N/A                          | Agent cannot write structured data to DB   |
| No KB ingestion mechanism                         | N/A                          | Business knowledge cannot enter the system |
| `readFile()` is an interface contract             | `types.ts`                   | All backends must read from disk           |

---

## 2. How OpenClaw Memory Actually Works (Ground Truth) {#2-how-openclaw-memory-works}

### Two Completely Separate Systems

**System A: MEMORY.md (Agent's Notebook)**

- The agent voluntarily writes observations using `edit`/`write` tools
- Written to disk: `MEMORY.md`, `memory.md`, or files under `memory/`
- Agent decides WHAT to remember (system prompt nudges, but agent chooses)
- This is the **source of truth** per OpenClaw's design: "The files are the source of truth; the model only 'remembers' what gets written to disk"

**System B: Memory Search Backend (Index)**

- Reads .md files from disk → chunks them → generates embeddings → stores in backend
- Returns search results when agent calls `memory_search`
- `memory_get` reads lines from DISK .md files (not from the backend!)
- The backend is an **index** — it makes .md files searchable, nothing more

### Session Memory (Experimental, Off by Default)

- Reads `.jsonl` transcript files from OpenClaw's session directory
- Extracts `user`/`assistant` messages, concatenates as `"User: ... \nAssistant: ..."`
- Chunks the same way as .md files (400 tokens, 80 overlap)
- Gated by `experimental.sessionMemory: false` AND `sources: ["memory"]`
- Even when enabled, it's the same pipeline: flat text → chunks → embeddings

### The Sync Pipeline (What MongoDB Currently Does)

```
Phase A: Memory Files
  listMemoryFiles(workspaceDir, extraPaths)  → .md files only
  for each changed file:
    readFile from disk → chunkMarkdown(400 tok, 80 overlap)
    embedBatch(chunks) → upsert to {prefix}chunks collection
    upsertFileMetadata → {prefix}files collection

Phase B: Session Files (if agentId provided)
  listSessionFilesForAgent(agentId) → .jsonl files
  for each changed file:
    buildSessionEntry → extract user/assistant text → concatenate
    chunkMarkdown → embedBatch → upsert to same chunks collection

Phase C: Stale Cleanup
  Find chunks whose path no longer exists on disk → delete
```

### Current MongoDB Schema

**`{prefix}files` collection** — File metadata

```json
{
  "_id": "MEMORY.md",           // string, relative path
  "source": "memory",           // or "sessions"
  "hash": "sha256...",
  "mtime": 1234567890,
  "size": 4096,
  "updatedAt": ISODate
}
```

**`{prefix}chunks` collection** — Chunked text with embeddings

```json
{
  "_id": "MEMORY.md:1:15",     // path:startLine:endLine
  "path": "MEMORY.md",
  "source": "memory",           // or "sessions"
  "startLine": 1,
  "endLine": 15,
  "hash": "sha256...",
  "model": "voyage-4-large",
  "text": "chunk content...",
  "embedding": [0.1, 0.2, ...], // 1024-dim (managed mode only)
  "updatedAt": ISODate
}
```

That's it. Two collections holding chunked text from flat files. This is the "better SQLite" problem.

---

## 3. Gap Analysis: What MongoDB CAN Do vs What We Use {#3-gap-analysis}

| MongoDB Capability                       | Currently Used?           | Potential                                             |
| ---------------------------------------- | ------------------------- | ----------------------------------------------------- |
| Flexible document model                  | Barely — flat chunks only | Structured observations, typed memory, rich KB docs   |
| ACID Transactions                        | Yes (sync atomicity)      | Multi-collection atomic writes for complex ingestion  |
| Vector Search ($vectorSearch)            | Yes (query-time)          | Also for KB retrieval, cross-session memory lookup    |
| Full-Text Search ($text)                 | Yes (fallback)            | KB search with relevance scoring                      |
| Hybrid Search ($rankFusion/$scoreFusion) | Yes (dispatcher)          | KB + memory combined search                           |
| Aggregation Pipeline                     | Minimal (analytics)       | Complex KB queries, faceted search, entity extraction |
| TTL Indexes                              | Yes (cache/memory expiry) | Session memory auto-expiry, KB freshness              |
| Change Streams                           | Yes (cross-instance)      | Real-time KB updates, collaborative editing           |
| Schema Validation                        | No                        | Enforce KB document quality, structured memory types  |
| GridFS                                   | No                        | Large file storage for ingested documents             |
| Time Series Collections                  | No                        | Agent activity analytics, performance tracking        |
| Capped Collections                       | No                        | Bounded conversation history                          |
| $lookup                                  | No                        | Join KB docs with agent observations                  |
| Atlas Search (if available)              | Partial                   | Fuzzy search, facets, autocomplete for KB             |

### What We're Leaving on the Table

1. **No structured data** — Everything is chunked text blobs. No typed observations (decisions, preferences, facts, todos).
2. **No knowledge base** — Users cannot import business documents, FAQs, product docs, architecture specs into the system.
3. **No agent-to-DB writes** — Agent can only write to disk files. MongoDB is read-only from agent's perspective.
4. **No semantic relationships** — Chunks are isolated. No concept of "this decision relates to that project."
5. **No conversation persistence** — Sessions stored as `.jsonl` files, not in MongoDB. Rebuilt from files each sync.
6. **No multi-modal data** — Only .md text. No support for PDFs, code files, API docs, etc.

---

## 4. MongoDB's Official AI Agent Memory Architecture {#4-mongodb-official-architecture}

### What MongoDB Recommends (from official docs + blog posts + dev.to)

MongoDB's reference architecture for AI agents uses **separate, purpose-built collections**:

**1. Conversation History (Short-term Memory)**

```json
{
  "sessionId": "session-123",
  "userId": "user-456",
  "messages": [
    {
      "role": "user",
      "content": "What's our database architecture?",
      "timestamp": ISODate,
      "metadata": {
        "tool_calls_made": 2,
        "search_performed": true
      }
    }
  ],
  "metadata": {
    "totalMessages": 42,
    "lastActivity": ISODate
  }
}
```

Pattern: Atomic `$push` + `$inc` for appending messages. `$slice: -N` for retrieval.

**2. Knowledge Base (Long-term Memory)**

- Embeddings stored alongside source documents
- Pre-filtered vector search: `$vectorSearch` + structured `filter` in single pass
- Business logic scoring in aggregation pipeline (not just vector similarity)

**3. User/Agent Memory (Persistent Observations)**

- Activity logs, saved items, preferences
- Structured subdocuments with typed fields

**4. Bidirectional Data Flow (Key Insight)**

- Agents READ from DB via vector search + filters
- Agents WRITE to DB via atomic upserts (conversations, observations, tool outputs)
- This is what ClawMongo is missing: agents only READ, never WRITE

### Memory Types in Literature (MongoDB + Academic)

| Memory Type            | Description                      | ClawMongo Analog             | Status                 |
| ---------------------- | -------------------------------- | ---------------------------- | ---------------------- |
| **Working Memory**     | Current conversation context     | System prompt + tool results | Built-in (LLM context) |
| **Episodic Memory**    | Past conversation transcripts    | Session .jsonl files         | Partially implemented  |
| **Semantic Memory**    | Factual knowledge & concepts     | MEMORY.md observations       | Flat file only         |
| **Procedural Memory**  | How to perform tasks             | Agent system prompt + skills | Built-in               |
| **Associative Memory** | Cross-reference between memories | None                         | NOT implemented        |
| **Long-term Memory**   | Persistent knowledge base        | None                         | NOT implemented        |

---

## 5. The Vision: MongoDB as Active Knowledge Engine {#5-the-vision}

### Core Principle

> **MongoDB is not an index. MongoDB IS the memory.**

The fundamental shift: stop treating MongoDB as a mirror of disk files, and start treating it as the **source of truth** for agent knowledge.

### Current Flow (Passive Index)

```
Agent writes → MEMORY.md (disk) → file watcher → sync → MongoDB (index)
Session .jsonl (disk) → sync → MongoDB (index)
Agent searches → MongoDB → returns chunk from indexed .md file
Agent reads → DISK (never MongoDB)
```

### Proposed Flow (Active Knowledge Engine)

```
Layer 1: Legacy Compatibility (unchanged)
  MEMORY.md (disk) → sync → MongoDB      [backward compatible with OpenClaw]
  memory/*.md (disk) → sync → MongoDB    [backward compatible with OpenClaw]
  Session .jsonl → sync → MongoDB         [backward compatible with OpenClaw]

Layer 2: MongoDB-Native Memory (NEW)
  Agent → memory_write tool → MongoDB     [structured observations, typed data]
  Agent → kb_search tool → MongoDB        [dedicated KB retrieval]
  Wizard/CLI → kb_ingest → MongoDB        [document ingestion pipeline]

Layer 3: Smart Retrieval (ENHANCED)
  memory_search → unified search across ALL layers
    → chunks (legacy .md files)
    → structured_memory (typed observations)
    → knowledge_base (ingested documents)
    → sessions (conversation history)
```

### The Three Pillars

**Pillar 1: Knowledge Base (KB)**

- Business documents, FAQs, architecture specs, product docs
- Ingested via wizard, CLI command, or API
- Chunked, embedded, and stored DIRECTLY in MongoDB
- No .md files required — MongoDB IS the storage

**Pillar 2: Structured Agent Memory**

- Typed observations: decisions, preferences, facts, todos, people, projects
- Agent writes DIRECTLY to MongoDB via `memory_write` tool
- Replaces the "dump everything in MEMORY.md" pattern
- Queryable by type, key, timestamp, confidence

**Pillar 3: Conversation Memory (Sessions)**

- Real-time session storage in MongoDB (not batch from .jsonl)
- Structured: sessionId, role, content, tools, metadata
- Auto-enabled for MongoDB users (no experimental flag)

---

## 6. Proposed Collection Architecture {#6-proposed-collections}

### Collection Map

```
{prefix}chunks          — (EXISTING) Chunked .md files [backward compat]
{prefix}files           — (EXISTING) File metadata [backward compat]
{prefix}knowledge_base  — (NEW) Ingested business documents
{prefix}structured_mem  — (NEW) Typed agent observations
{prefix}conversations   — (NEW) Real-time session history
{prefix}meta            — (EXISTING, extended) Resume tokens, sync state, KB metadata
```

### 6.1 Knowledge Base Collection (`{prefix}knowledge_base`)

```json
{
  "_id": ObjectId,
  "title": "API Architecture Guide",
  "source": {
    "type": "file",              // "file" | "url" | "manual" | "api" | "clipboard"
    "path": "/docs/api-guide.md",
    "url": null,
    "mimeType": "text/markdown",
    "originalName": "api-guide.md",
    "importedBy": "wizard",      // "wizard" | "cli" | "api" | "agent"
    "importedAt": ISODate
  },
  "content": "Full document text...",
  "chunks": [
    {
      "index": 0,
      "text": "Chunk text...",
      "startOffset": 0,
      "endOffset": 398,
      "embedding": [0.1, 0.2, ...]  // managed mode
    }
  ],
  "tags": ["architecture", "api"],
  "category": "technical",
  "language": "en",
  "hash": "sha256...",             // dedup key
  "embedding": [0.1, 0.2, ...],   // full-doc summary embedding
  "updatedAt": ISODate,
  "expiresAt": null                // optional TTL
}
```

**Why embed chunks as subdocuments?**

- Atomic: whole document updated in one write
- No orphan chunks when document is deleted
- BUT: 16MB BSON limit → documents with many chunks need the chunks collection approach

**Alternative: Separate KB chunks collection**

```
{prefix}kb_chunks — for documents that exceed 16MB when chunked
```

This is the safer approach for production. Store the source document in `knowledge_base`, chunks in `kb_chunks` with `docId` reference.

### 6.2 Structured Memory Collection (`{prefix}structured_mem`)

```json
{
  "_id": ObjectId,
  "type": "decision",           // "decision" | "preference" | "person" | "todo"
                                // | "fact" | "project" | "architecture" | "custom"
  "key": "database:mongodb",    // dedup/lookup key (type:specific)
  "value": "We chose MongoDB 8.2 for the memory backend because...",
  "context": "Discussion during sprint planning, Feb 2026",
  "confidence": 0.9,            // 0.0-1.0, agent self-assessed
  "source": "agent",            // "agent" | "user" | "session" | "ingestion"
  "sessionId": "session-abc",   // which session this came from
  "agentId": "main",
  "embedding": [0.1, 0.2, ...],
  "tags": ["database", "architecture"],
  "supersedes": null,            // _id of previous version (for updates)
  "createdAt": ISODate,
  "updatedAt": ISODate,
  "expiresAt": null              // optional TTL for temporary observations
}
```

**Key design decisions:**

- `key` field enables upsert: agent can update "preferred_language" without creating duplicates
- `confidence` lets the agent express uncertainty
- `supersedes` enables versioning without deleting history
- `type` enables filtered queries: "show me all decisions" or "what preferences exist?"
- `embedding` enables semantic search: "what do we know about the database?"

### 6.3 Conversations Collection (`{prefix}conversations`)

```json
{
  "_id": ObjectId,
  "sessionId": "session-abc-123",
  "agentId": "main",
  "messages": [
    {
      "role": "user",
      "content": "What's our API architecture?",
      "timestamp": ISODate,
      "metadata": {}
    },
    {
      "role": "assistant",
      "content": "Based on memory search, our API uses...",
      "timestamp": ISODate,
      "metadata": {
        "tools_used": ["memory_search", "kb_search"],
        "kb_docs_referenced": ["api-guide"],
        "confidence": 0.85
      }
    }
  ],
  "metadata": {
    "totalMessages": 42,
    "lastActivity": ISODate,
    "topics": ["api", "architecture"],  // auto-extracted
    "summary": "Discussion about API architecture..."  // periodic summary
  },
  "createdAt": ISODate,
  "updatedAt": ISODate
}
```

**Pattern: $push for append, $slice for retrieval (last N messages)**

### 6.4 Indexes

```javascript
// Knowledge Base
{ "source.type": 1, "category": 1 }           // filter by source + category
{ "tags": 1 }                                   // filter by tags
{ "hash": 1 }, { unique: true }                 // dedup
{ "updatedAt": 1 }                              // freshness sort
// + vector index on "embedding" field
// + vector index on "chunks.embedding" (or separate kb_chunks collection)
// + $text index on "content" + "title"

// Structured Memory
{ "type": 1, "key": 1 }, { unique: true }      // lookup by type+key
{ "type": 1, "updatedAt": -1 }                 // recent by type
{ "agentId": 1, "sessionId": 1 }               // per-agent/session
{ "tags": 1 }                                   // tag-based lookup
// + vector index on "embedding"
// + $text index on "value" + "context"

// Conversations
{ "sessionId": 1 }, { unique: true }            // one doc per session
{ "agentId": 1, "updatedAt": -1 }              // recent by agent
// + vector index on summary embedding (for cross-session search)
```

---

## 7. KB Ingestion: Making It Out-of-the-Box {#7-kb-ingestion}

### The User's Mandate

> "every usecase of openclaw needs kb - this is must and we have to make it out of the box"
> "not logical to keep kb in md files! we are here to leverage mongodb"

### Ingestion Sources (Priority Order)

| Source                      | Method                  | Priority | Complexity                                    |
| --------------------------- | ----------------------- | -------- | --------------------------------------------- |
| Markdown files (.md)        | CLI command / wizard    | P0 (MVP) | Low                                           |
| Text files (.txt)           | CLI command             | P0       | Low                                           |
| Directories (recursive)     | CLI command / wizard    | P0       | Low                                           |
| PDF documents               | CLI command + parser    | P1       | Medium (needs pdf-parse)                      |
| URLs / web pages            | CLI command + scraper   | P1       | Medium (needs fetch + html-to-text)           |
| Code files (.ts, .py, etc.) | CLI command             | P1       | Low (text, but needs language-aware chunking) |
| JSONL / JSON                | CLI command             | P1       | Low                                           |
| Clipboard / manual text     | Wizard prompt           | P2       | Low                                           |
| API endpoint                | Config + periodic fetch | P3       | High                                          |
| Google Drive / Notion       | MCP integration         | P3       | High (auth)                                   |

### Ingestion Pipeline Design

```
Input (file/url/text)
  │
  ▼
Format Detection
  │ .md → markdown chunking (existing chunkMarkdown)
  │ .txt → paragraph-based chunking
  │ .pdf → pdf-parse → text → chunking
  │ .html/url → readability → text → chunking
  │ code → language-aware chunking (functions/classes)
  │ .json/.jsonl → document-per-item
  │
  ▼
Chunking (configurable)
  │ Default: 400 tokens, 80 overlap (same as memory files)
  │ KB override: configurable via kb.chunking.tokens / kb.chunking.overlap
  │ Code: function/class boundaries
  │
  ▼
Embedding Generation
  │ managed mode → embedding provider (Voyage, OpenAI, etc.)
  │ automated mode → MongoDB handles via Voyage AI autoEmbed
  │
  ▼
MongoDB Storage
  │ → {prefix}knowledge_base (source document + metadata)
  │ → {prefix}kb_chunks (chunked text + embeddings) [if separate]
  │ → Dedup via content hash
  │
  ▼
Index Updates
  │ → Vector index on embeddings
  │ → $text index on content
  │ → Tag/category indexes
```

### CLI Command Design

```bash
# Ingest a single file
clawmongo kb ingest ./docs/api-guide.md

# Ingest a directory (recursive)
clawmongo kb ingest ./docs/ --recursive

# Ingest from URL
clawmongo kb ingest https://example.com/api-docs --source url

# Ingest with tags and category
clawmongo kb ingest ./architecture.md --tags architecture,design --category technical

# List ingested documents
clawmongo kb list
clawmongo kb list --category technical

# Search knowledge base (CLI)
clawmongo kb search "how does authentication work"

# Remove document
clawmongo kb remove <doc-id>

# Re-ingest (update)
clawmongo kb ingest ./docs/api-guide.md --force

# Stats
clawmongo kb stats
```

### Wizard Integration

During `clawmongo onboard` or `clawmongo configure`:

```
? Do you have documents to import into the knowledge base?
  > Yes, import now
    Skip for now (import later with: clawmongo kb ingest)

? What would you like to import?
  > Files or directory
    URL / web page
    Paste text manually

? Path to import: ./docs/
  Scanning... found 12 .md files, 3 .txt files

? Tags for this import (comma-separated, optional): architecture, api
? Category: technical

  Importing 15 files...
  ████████████████████████ 15/15
  ✓ 15 documents imported, 127 chunks created
  ✓ Knowledge base ready. The agent can now search these documents.
```

### Config Schema Addition

```typescript
interface MemoryMongoDBConfig {
  // ... existing fields ...

  // Knowledge Base configuration
  kb?: {
    /** Enable KB features (default: true when MongoDB backend) */
    enabled?: boolean;
    /** Custom chunking for KB documents */
    chunking?: {
      tokens?: number; // default: 600 (larger than memory chunks)
      overlap?: number; // default: 100
    };
    /** Auto-import paths on startup */
    autoImportPaths?: string[];
    /** Auto-import refresh interval (hours, 0 = disabled) */
    autoRefreshHours?: number;
    /** Maximum document size (bytes) before rejecting */
    maxDocumentSize?: number; // default: 10MB
  };
}
```

---

## 8. New Agent Tools {#8-new-agent-tools}

### 8.1 Enhanced `memory_search` (Modify Existing)

Current: searches only chunks from .md files
Proposed: **unified search across ALL data layers**

```
memory_search(query, { sources?, maxResults?, filter? })

sources: ["memory", "sessions", "kb", "structured"]  // default: all
filter: { type?, tags?, category?, dateRange? }       // optional

Returns results from ALL active sources, ranked by relevance.
Each result tagged with its source layer for transparency.
```

System prompt update (MongoDB-specific):

```
## Memory Recall
Before answering anything about prior work, decisions, dates, people, preferences,
or todos: run memory_search to search your knowledge base and memory. If searching
for factual/reference information, include source="kb". Results come from your
knowledge base, structured memory, session history, and memory files.
```

### 8.2 `memory_write` (NEW)

```
memory_write({ type, key, value, context?, confidence?, tags? })

type: "decision" | "preference" | "person" | "todo" | "fact" | "project" | "architecture"
key: unique identifier (e.g., "preferred_language:typescript")
value: the observation text
context: when/why this was learned (optional)
confidence: 0.0-1.0 (optional, default 0.8)
tags: string[] (optional)

Upserts to {prefix}structured_mem collection.
Key = dedup identifier: same type+key updates the existing record.
```

**Why this matters:** Instead of the agent writing "We decided to use TypeScript" to MEMORY.md (unstructured, unsearchable by type), it writes a structured decision to MongoDB with type="decision", key="language:typescript". Later, "what decisions have we made?" returns ONLY decisions, not every random chunk that mentions the word "decision."

### 8.3 `kb_search` (NEW)

```
kb_search({ query, filter?, maxResults? })

filter: { tags?, category?, source?, dateRange? }

Dedicated search over the knowledge base collection.
Returns: title, source, snippet, score, metadata.
```

**Why separate from memory_search?** The agent can be explicit: "I need to check the architecture docs" → `kb_search`. vs "What do I know about this topic?" → `memory_search` (all sources).

### 8.4 `kb_ingest` (NEW, optional — agent-triggered)

```
kb_ingest({ content, title, source?, tags?, category? })

Allows the agent to save external information directly to KB.
Example: agent fetches a web page, decides it's relevant, ingests it.
```

This is lower priority — most KB ingestion should happen via CLI/wizard, not during conversation.

---

## 9. Data Flow Diagrams {#9-data-flow}

### Current Flow (v2.0.0-rc.5)

```
                    ┌─────────────┐
                    │  Agent LLM  │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │ edit/write  │ memory_search│ memory_get
              ▼             ▼             ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │MEMORY.md │ │ MongoDB  │ │  DISK    │
        │  (disk)  │ │ (index)  │ │ (read)   │
        └────┬─────┘ └──────────┘ └──────────┘
             │              ▲
             │  file watcher│ sync
             └──────────────┘

Data only flows: Disk → MongoDB (one direction)
Agent writes to disk, reads index from MongoDB, reads files from disk.
MongoDB is passive.
```

### Proposed Flow (v3.0)

```
                         ┌─────────────┐
                         │  Agent LLM  │
                         └──────┬──────┘
                                │
        ┌───────────┬───────────┼───────────┬───────────┐
        │ edit/write│ memory_   │ memory_   │ kb_       │
        │           │ write     │ search    │ search    │
        ▼           ▼           ▼           ▼           │
  ┌──────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐    │
  │MEMORY.md │ │struct_  │ │ UNIFIED │ │   KB    │    │
  │  (disk)  │ │mem (DB) │ │ SEARCH  │ │  (DB)   │    │
  └────┬─────┘ └─────────┘ └────┬────┘ └────┬────┘    │
       │                        │            │          │
       │ sync                   │ searches   │          │
       ▼                        ▼            │          │
  ┌─────────┐           ┌──────────────┐    │          │
  │ chunks  │───────────│   MongoDB    │◄───┘          │
  │ (legacy)│           │  (source of  │               │
  └─────────┘           │   truth)     │◄──────────────┘
                        └──────┬───────┘
                               ▲
                   ┌───────────┤
                   │           │
             ┌──────────┐ ┌──────────┐
             │ CLI/     │ │ Sessions │
             │ Wizard   │ │ (real-   │
             │ kb ingest│ │  time)   │
             └──────────┘ └──────────┘

Data flows BOTH directions:
- Legacy: Disk → MongoDB (backward compat)
- New: Agent → MongoDB (direct writes)
- New: CLI → MongoDB (KB ingestion)
- New: Sessions → MongoDB (real-time, not batch)
MongoDB is active source of truth.
```

---

## 10. Upstream Compatibility Strategy {#10-upstream-compatibility}

### The Constraint

> "i am not here to improve openclaw source files - i am here to add mongodb and leverage its full power"

All changes must be **additive**. Existing OpenClaw code paths (builtin SQLite, QMD) must remain untouched.

### Strategy: Layered Enhancement

| Layer                    | What Changes                                            | Impact on OpenClaw                                               |
| ------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------- |
| New collections          | Add `knowledge_base`, `structured_mem`, `conversations` | Zero — new MongoDB-only collections                              |
| New tools                | Add `memory_write`, `kb_search`, `kb_ingest`            | Additive — new tools registered only when MongoDB backend active |
| Enhanced `memory_search` | Search across all layers                                | Transparent — existing interface, richer results                 |
| System prompt            | MongoDB-aware memory recall section                     | Conditional — only when MongoDB backend detected                 |
| CLI commands             | `clawmongo kb ingest/list/search/stats`                 | New commands — don't exist in OpenClaw                           |
| Wizard updates           | KB import step in onboard/configure                     | Conditional — only when MongoDB selected                         |
| Config schema            | Add `kb` section to MemoryMongoDBConfig                 | Additive — new optional fields                                   |

### Files That Would Change (OpenClaw Source)

| File               | Change Type                            | Risk                                           |
| ------------------ | -------------------------------------- | ---------------------------------------------- |
| `system-prompt.ts` | Add MongoDB-aware memory section       | LOW — conditional, won't affect other backends |
| `memory-tool.ts`   | Modify description when MongoDB active | LOW — conditional string change                |
| `memory-search.ts` | Auto-enable sessions for MongoDB       | LOW — config default override                  |
| `tool-policy.ts`   | Register new tools in group:memory     | LOW — additive                                 |

### Files That Are ClawMongo-Only (No OpenClaw Impact)

| File                                 | Purpose                            |
| ------------------------------------ | ---------------------------------- |
| `mongodb-kb.ts` (new)                | KB ingestion pipeline              |
| `mongodb-kb-search.ts` (new)         | KB-specific search                 |
| `mongodb-structured-memory.ts` (new) | Structured memory CRUD             |
| `mongodb-conversations.ts` (new)     | Real-time session storage          |
| `commands/kb.ts` (new)               | CLI commands for KB management     |
| `mongodb-schema.ts` (modify)         | Add new collection schemas/indexes |
| `mongodb-manager.ts` (modify)        | Wire new features                  |
| `mongodb-sync.ts` (modify)           | Add KB sync pipeline               |

---

## 11. Open Questions & Trade-offs {#11-open-questions}

### Q1: Should `memory_write` REPLACE writing to MEMORY.md?

**Option A: Replace** — Agent writes to MongoDB only, MEMORY.md becomes legacy

- Pro: Clean architecture, MongoDB is truly source of truth
- Con: Breaks OpenClaw convention, MEMORY.md is "the file" for memory

**Option B: Dual-write** — Agent writes to MEMORY.md AND MongoDB

- Pro: Backward compatible, MEMORY.md still works if MongoDB is down
- Con: Redundant, sync complexity, which is truth?

**Option C: Supplement** — Agent writes structured observations to MongoDB, informal notes to MEMORY.md

- Pro: Best of both worlds, each store for what it's good at
- Con: Agent must decide where to write, added complexity

**Recommendation: Option C** — MEMORY.md for informal notes (agent's "notebook"), MongoDB for structured data (decisions, facts, preferences). The system prompt can guide this distinction.

### Q2: Embedded chunks vs separate chunks collection for KB?

**Option A: Embedded** — Chunks as subdocuments in knowledge_base

- Pro: Atomic updates, no orphans, simpler queries
- Con: 16MB BSON limit, large docs with many chunks

**Option B: Separate** — `kb_chunks` collection with docId reference

- Pro: No size limit, can index chunks independently
- Con: Two collections to maintain, orphan risk

**Recommendation: Option B** — Separate `kb_chunks` collection. Consistent with existing `chunks` pattern. Production-safe for large documents.

### Q3: Should KB search be merged into `memory_search` or separate?

**Option A: Merged** — `memory_search` queries all layers

- Pro: One tool for agent, simpler system prompt
- Con: May return noisy results mixing KB + personal observations

**Option B: Separate** — `memory_search` for memory, `kb_search` for KB

- Pro: Agent can be precise about what to search
- Con: Two tools to maintain, agent must know which to use

**Recommendation: Both** — `memory_search` searches everything by default (with optional `sources` filter). `kb_search` is a convenience tool for KB-specific queries. The agent learns to use the right tool for the right job.

### Q4: Real-time session storage vs batch from .jsonl?

**Option A: Real-time** — Each message written to MongoDB as it happens

- Pro: Instant availability, no sync delay, true source of truth
- Con: Requires hooking into OpenClaw's message pipeline (deeper integration)

**Option B: Enhanced batch** — Keep .jsonl sync but with better defaults

- Pro: Minimal code changes, backward compatible
- Con: Still file-dependent, sync delay, duplicate data

**Recommendation: Start with Option B (quick win)**, evolve to Option A as the architecture matures. Auto-enable sessionMemory + sessions source for MongoDB users as immediate fix.

### Q5: How to handle embedding costs for KB ingestion?

KB ingestion could generate many embeddings at once (e.g., 100 docs × 10 chunks = 1000 embeddings).

- Batch embedding with rate limiting
- Progress bar during ingestion
- Config: `kb.maxDocumentSize` to prevent accidentally ingesting huge files
- Option to skip embeddings and rely on $text search only
- Automated embedding mode (MongoDB handles it) removes this concern

### Q6: What about KB freshness / auto-refresh?

Some KB documents may change (API docs, architecture guides). Options:

- Manual re-ingest via `clawmongo kb ingest --force`
- Config: `autoImportPaths` + `autoRefreshHours` for periodic re-import
- Hash-based skip (already implemented for memory files — reuse pattern)

### Q7: Multi-agent KB sharing?

If multiple agents share a MongoDB database, KB should be shared but structured memory should be per-agent.

- KB collection: no agentId field (shared by all agents in the database)
- Structured memory: has `agentId` field (per-agent observations)
- Conversations: has `agentId` + `sessionId` (per-session)

---

## 12. Phased Roadmap {#12-roadmap}

### Phase 0: Quick Wins (Config Fixes)

- Auto-enable `sessionMemory: true` when MongoDB backend is selected
- Auto-set `sources: ["memory", "sessions"]` for MongoDB backend
- System prompt: remove "MEMORY.md" mention when MongoDB active, use generic "your memory"
- **Risk:** Low. Config changes only.
- **Impact:** Sessions immediately searchable without user config.

### Phase 1: KB Ingestion MVP

- New collection: `{prefix}knowledge_base` + `{prefix}kb_chunks`
- KB ingestion pipeline: .md and .txt files → chunk → embed → store
- CLI command: `clawmongo kb ingest <path>` (files and directories)
- CLI command: `clawmongo kb list`, `clawmongo kb search`, `clawmongo kb stats`
- Wizard: "Do you have documents to import?" step
- Enhanced `memory_search`: include KB results in search
- New tool: `kb_search` (dedicated KB search)
- **Risk:** Medium. New collections, new CLI commands, new tool.
- **Impact:** Users can import business documents. Agent can find them.

### Phase 2: Structured Agent Memory

- New collection: `{prefix}structured_mem`
- New tool: `memory_write` (agent writes structured observations to MongoDB)
- Updated system prompt: guide agent to use `memory_write` for decisions/preferences/facts
- Type-filtered queries: "show me all decisions" → `{ type: "decision" }`
- Versioning via `supersedes` field
- **Risk:** Medium-High. Changes agent behavior (where it writes).
- **Impact:** Agent stops dumping everything in MEMORY.md. Structured, queryable memory.

### Phase 3: Enhanced Session Memory

- New collection: `{prefix}conversations` (structured, not chunked text)
- Real-time message append (hook into message pipeline)
- Topic extraction and periodic summary generation
- Cross-session search: "what did we discuss about authentication?"
- **Risk:** High. Requires deeper integration with OpenClaw's session system.
- **Impact:** True conversation memory, not just chunked transcript text.

### Phase 4: Advanced KB Features

- PDF ingestion (pdf-parse)
- URL/web page ingestion (fetch + readability)
- Code file ingestion (language-aware chunking)
- Auto-refresh for watched paths
- `kb_ingest` agent tool (agent-triggered ingestion)
- **Risk:** Medium. External dependencies (pdf-parse, readability).
- **Impact:** Rich multi-format knowledge base.

### Phase 5: Intelligence Layer

- Associative memory: cross-reference between observations
- Auto-tagging via LLM (extract tags/category from ingested docs)
- Memory consolidation: periodic LLM pass to merge/summarize old memories
- "What don't I know?" — agent identifies knowledge gaps
- **Risk:** High. LLM-in-the-loop for data processing.
- **Impact:** The agent becomes truly intelligent about its own knowledge.

---

## Summary: What Makes ClawMongo Different

| Feature        | OpenClaw (SQLite)     | OpenClaw (QMD)              | ClawMongo (MongoDB)                    |
| -------------- | --------------------- | --------------------------- | -------------------------------------- |
| Storage        | Local SQLite file     | Local QMD index             | MongoDB database                       |
| Data model     | Chunked text blobs    | Chunked text + QMD features | **Structured collections**             |
| Knowledge Base | None (only .md files) | None (only .md files)       | **Full KB ingestion**                  |
| Agent writes   | MEMORY.md (disk)      | MEMORY.md (disk)            | **memory_write (DB)**                  |
| Session memory | Experimental, off     | Experimental, off           | **On by default**                      |
| Search         | Embedding similarity  | QMD ranking                 | **Hybrid: vector + text + structured** |
| KB search      | N/A                   | N/A                         | **Dedicated kb_search tool**           |
| CLI tools      | None                  | None                        | **kb ingest/list/search/stats**        |
| Multi-instance | No                    | No                          | **Yes (shared DB + change streams)**   |
| Transactions   | No                    | No                          | **ACID transactions**                  |
| Schema         | None                  | None                        | **Validated document schemas**         |

**ClawMongo's pitch:** "Don't just remember what the agent writes in a file. Remember EVERYTHING — business documents, structured decisions, conversation history — and make it all instantly searchable."

---

## Appendix A: Research Sources

- OpenClaw source code: `system-prompt.ts`, `memory-tool.ts`, `memory-search.ts`, `mongodb-sync.ts`, `mongodb-manager.ts`, `session-files.ts`, `internal.ts`
- OpenClaw docs: `docs/concepts/memory.md` (via octocode)
- MongoDB official: "Build AI Agents with MongoDB" (Atlas docs)
- MongoDB blog: "Don't Just Build Agents, Build Memory-Augmented AI Agents" (Jul 2025)
- Dev.to: "Building Intelligent AI Agents with MongoDB Atlas: Bidirectional Data Flow" (Dec 2025)
- MongoDB resources: "What Is Agent Memory?" guide
- Real-life testing: ClawMongo rc.5 on Telegram bot with Community MongoDB + mongot
- Bot self-diagnosis: "Just a Chat Logger with Vector Search, missing Active Knowledge Graph logic"

## Appendix B: The Bot's Conversation (Key Insights)

From the real-life test where the bot analyzed its own architecture:

1. Bot found architecture data in `sessions` collection via vector search (proving sessions DO work when enabled)
2. Bot identified storing everything in session logs is "lazy" — needs structured collections
3. Bot suggested: projects collection, schemas collection, tasks collection
4. Bot correctly identified root cause: "agent is just a Chat Logger with Vector Search, missing Active Knowledge Graph logic"
5. Bot proposed: "structured collections for different types of knowledge with proper metadata and relationships"

The bot was right about the problem. The solution in this document goes further: not just structured collections, but a complete knowledge management system with KB ingestion, typed memory, and enhanced agent tools.
