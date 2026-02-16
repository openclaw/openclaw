# OpenClaw Memory Architecture Deep Dive

**Date:** 2026-02-15
**Purpose:** Ground-truth investigation of how OpenClaw memory works across all backends

---

## Two Separate Systems

### System A: MEMORY.md (Agent's Notebook)

- Agent voluntarily writes observations via `edit`/`write` tools
- Files: `MEMORY.md`, `memory.md`, `memory/*.md`
- OpenClaw docs: "The files are the source of truth; the model only 'remembers' what gets written to disk"
- Agent decides WHAT to remember based on system prompt guidance

### System B: Memory Search Backend (Index)

- Reads .md files from disk → chunks (400 tok, 80 overlap) → embeddings → backend
- Three backends: SQLite (builtin), QMD, MongoDB
- ALL backends index the SAME data using the SAME pipeline
- `memory_get` reads from DISK, not from the backend

## System Prompt (Critical)

`system-prompt.ts:53`:

```
Before answering anything about prior work, decisions, dates, people, preferences,
or todos: run memory_search on MEMORY.md + memory/*.md; then use memory_get to
pull only the needed lines.
```

This is the SAME regardless of which backend is configured.

## Tool Definitions

`memory-tool.ts:42-44`:

```
name: "memory_search"
description: "Mandatory recall step: semantically search MEMORY.md + memory/*.md
(and optional session transcripts)"
```

`memory-tool.ts:107-109`:

```
name: "memory_get"
description: "Safe snippet read from MEMORY.md or memory/*.md with optional
from/lines; use after memory_search to pull only the needed lines"
```

## Session Memory (Experimental)

`memory-search.ts:88`: `DEFAULT_SOURCES = ["memory"]`
`memory-search.ts:127`: `sessionMemory = false` (default)
`memory-search.ts:90-108`: `normalizeSources()` filters out "sessions" unless sessionMemoryEnabled

Session files: `.jsonl` in OpenClaw's session directory
Processing: extract user/assistant messages → concatenate → chunk → embed

## MongoDB Backend Specifics

### Sync Pipeline (mongodb-sync.ts)

- Phase A: Memory files (.md) → chunk → embed → upsert to chunks collection
- Phase B: Session files (.jsonl) → extract → chunk → embed → upsert to same chunks collection
- Phase C: Stale cleanup (delete chunks for removed files)

### Manager (mongodb-manager.ts)

- `search()`: triggers sync if dirty → generates query embedding → mongoSearch()
- `readFile()`: reads from DISK not MongoDB (interface contract)
- File watcher: chokidar on MEMORY.md, memory.md, memory/, extraPaths
- `status()`: hardcodes sources: ["memory", "sessions"]

### Current Schema

- `{prefix}files`: File metadata (\_id=path, hash, mtime, size, source)
- `{prefix}chunks`: Chunked text (\_id=path:start:end, text, embedding, source)

## Key Findings

1. MongoDB is a passive index — data only flows disk → MongoDB, never the reverse
2. Agent never writes to MongoDB — writes to MEMORY.md, file watcher syncs
3. Session memory is off by default — users must manually enable
4. The system prompt anchors agent to "MEMORY.md + memory/\*.md" — backend-agnostic
5. `readFile()` bypasses MongoDB entirely — reads from disk
6. All three backends are interchangeable because they all do the same thing
7. No mechanism for KB ingestion — only .md files and .jsonl sessions

## Sources

- Direct code analysis of OpenClaw source files
- OpenClaw `docs/concepts/memory.md` (via octocode)
- No upstream PRs found related to memory/KB improvements
