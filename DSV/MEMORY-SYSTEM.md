# OpenClaw Memory System — Analysis

## Overview

OpenClaw has one of the more sophisticated memory implementations in the open-source AI agent space. It combines **file-based persistence** with **vector search** for semantic recall.

## Architecture

### Storage Layer
- **Workspace Markdown files**: Each agent has a workspace directory with plain `.md` files
  - `memory/YYYY-MM-DD.md` — Daily append-only logs (automatic)
  - `MEMORY.md` — Curated long-term memory (agent-managed)
- **SQLite + sqlite-vec**: Local vector database for semantic search
  - Supports OpenAI, Gemini, or local embeddings (node-llama-cpp)
  - Batch embedding support via OpenAI Batch API for cost efficiency

### Search
- **Hybrid search**: BM25 (keyword) + vector similarity combined
- Incremental indexing with file watchers
- Atomic reindexing for consistency
- Async search with caching

### Memory Lifecycle
1. **Auto-flush**: Before context compaction, an agentic turn reminds the model to persist important memories
2. **Daily logs**: Automatic append to date-stamped files
3. **Curated memory**: Agent can update `MEMORY.md` for long-term retention
4. **Session files**: Per-session state synced to workspace

## Key Files
- `src/memory/manager.ts` — Core memory manager
- `src/memory/search.ts` — Hybrid search implementation
- `src/memory/embeddings.ts` — Embedding provider abstraction

## Relevance to X1 Advisor

### What We Can Learn
1. **Hybrid search is better than pure vector**: BM25 catches exact matches that embeddings miss
2. **Markdown as memory format**: Human-readable, version-controllable, easy to debug
3. **Auto-flush before compaction**: Ensures no memory loss during long conversations
4. **Per-workspace isolation**: Clean separation between agents/sessions

### What We'd Do Differently
1. **Team-shared memory**: OpenClaw is single-user; X1 needs team-level shared context
2. **Database-backed**: X1 already has PostgreSQL — may not need SQLite
3. **Structured data**: X1 has structured evaluation data, not just chat logs
4. **Permission model**: X1 needs role-based access to conversation history
