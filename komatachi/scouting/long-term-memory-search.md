# Long-Term Memory and Search - Scouting Report

## Summary

The long-term memory and search component provides persistent semantic search capabilities for OpenClaw agents. It indexes markdown files from designated memory directories (`MEMORY.md`, `memory/*.md`) and optionally session transcripts, enabling agents to recall prior decisions, preferences, todos, and other stored knowledge.

Key capabilities:
- **Vector embeddings** via OpenAI, Gemini, or local (node-llama-cpp) providers
- **Hybrid search** combining vector similarity with BM25 full-text search (FTS5)
- **SQLite storage** with sqlite-vec extension for native vector operations
- **Embedding caching** to avoid redundant API calls
- **Batch embedding APIs** for efficient bulk indexing (OpenAI/Gemini)
- **File watching** for automatic re-indexing on changes
- **Session transcript indexing** (experimental) for searching conversation history
- **Memory tools** exposed to agents (`memory_search`, `memory_get`)
- **CLI interface** for status, indexing, and manual search

## File Index

Key source files organized by distillation target. Cross-references to ROADMAP.md phases.
See detailed tables below for complete listings with line counts and test files.

### Embeddings (-> already distilled: src/embeddings/)
src/memory/embeddings.ts                - Embedding provider factory and abstraction layer
src/memory/embeddings-openai.ts         - OpenAI embedding provider implementation
src/memory/embeddings-gemini.ts         - Gemini embedding provider implementation
src/memory/batch-openai.ts              - OpenAI batch embedding API with polling/timeout
src/memory/batch-gemini.ts              - Gemini batch embedding API integration

### Storage schema (-> deferred, but reference for future Phase 1.1)
src/memory/memory-schema.ts             - SQLite schema: files, chunks, chunks_vec, chunks_fts, cache tables
src/memory/sqlite-vec.ts                - SQLite-vec extension loader for native vector operations
src/memory/sqlite.ts                    - Node sqlite require wrapper

### Search (-> deferred: vector search)
src/memory/manager-search.ts            - Vector similarity and keyword search implementations
src/memory/hybrid.ts                    - Hybrid search: merge vector + BM25 scores with deduplication
src/memory/internal.ts                  - File utilities, text chunking, hashing, cosine similarity

### File sync (-> deferred: file watching/indexing)
src/memory/sync-memory-files.ts         - Memory file synchronization: detect changes, reindex
src/memory/sync-session-files.ts        - Session transcript to memory file sync
src/memory/session-files.ts             - Session file parsing and building

### Manager (-> deferred: orchestrator)
src/memory/manager.ts                   - Main MemoryIndexManager: orchestrates indexing, search, caching, watching
src/memory/manager-cache-key.ts         - Cache key computation for manager instances

### Agent integration (reference)
src/agents/memory-search.ts             - Memory search config resolution and merging for agents
src/agents/tools/memory-tool.ts         - Agent tools: memory_search, memory_get

### CLI (out of scope)
src/cli/memory-cli.ts                   - CLI commands: memory status, index, search

### Peripheral
src/memory/status-format.ts             - Status display formatting helpers
src/memory/provider-key.ts              - Embedding provider key fingerprinting
src/memory/headers-fingerprint.ts       - Header name normalization for caching
src/memory/search-manager.ts            - Factory for getting memory search manager
src/memory/node-llama.ts                - Node-llama-cpp dynamic import (local embeddings)
src/memory/index.ts                     - Module re-exports
src/memory/openai-batch.ts              - Deprecated alias re-export

## Source Files

### Core Memory Module (`src/memory/`)

| File | Lines | Description |
|------|------:|-------------|
| manager.ts | 2,232 | Main MemoryIndexManager class - orchestrates indexing, search, caching |
| batch-gemini.ts | 413 | Gemini batch embedding API integration |
| batch-openai.ts | 382 | OpenAI batch embedding API integration |
| embeddings.ts | 226 | Embedding provider factory and abstraction |
| internal.ts | 241 | File utilities, chunking, hashing, cosine similarity |
| manager-search.ts | 182 | Vector and keyword search implementations |
| embeddings-gemini.ts | 149 | Gemini embedding provider |
| sync-session-files.ts | 130 | Session transcript synchronization |
| hybrid.ts | 111 | Hybrid search merging (vector + BM25) |
| session-files.ts | 106 | Session file parsing and building |
| sync-memory-files.ts | 101 | Memory file synchronization |
| memory-schema.ts | 94 | SQLite schema creation (files, chunks, FTS, cache) |
| embeddings-openai.ts | 86 | OpenAI embedding provider |
| manager-cache-key.ts | 55 | Cache key computation for manager instances |
| status-format.ts | 35 | Status display formatting helpers |
| provider-key.ts | 33 | Embedding provider key fingerprinting |
| sqlite-vec.ts | 24 | SQLite-vec extension loader |
| search-manager.ts | 21 | Factory for getting memory search manager |
| headers-fingerprint.ts | 15 | Header name normalization for caching |
| sqlite.ts | 10 | Node sqlite require wrapper |
| node-llama.ts | 3 | Node-llama-cpp dynamic import |
| index.ts | 2 | Module exports |
| openai-batch.ts | 2 | Re-export (deprecated alias) |

**Subtotal: 4,653 lines**

### Agent Integration (`src/agents/`)

| File | Lines | Description |
|------|------:|-------------|
| memory-search.ts | 291 | Memory search config resolution and merging |
| tools/memory-tool.ts | 112 | Agent tools: `memory_search` and `memory_get` |

**Subtotal: 403 lines**

### CLI Interface (`src/cli/`)

| File | Lines | Description |
|------|------:|-------------|
| memory-cli.ts | 657 | CLI commands: status, index, search |

**Subtotal: 657 lines**

---

## Total Lines of Code

| Category | Lines |
|----------|------:|
| Core Memory Module | 4,653 |
| Agent Integration | 403 |
| CLI Interface | 657 |
| **Total Source** | **5,713** |

## Test Files

| File | Lines |
|------|------:|
| src/memory/manager.batch.test.ts | 480 |
| src/memory/index.test.ts | 463 |
| src/cli/memory-cli.test.ts | 367 |
| src/memory/embeddings.test.ts | 327 |
| src/memory/manager.embedding-batches.test.ts | 293 |
| src/agents/memory-search.test.ts | 259 |
| src/memory/internal.test.ts | 127 |
| src/memory/manager.vector-dedupe.test.ts | 101 |
| src/memory/manager.sync-errors-do-not-crash.test.ts | 97 |
| src/memory/manager.atomic-reindex.test.ts | 92 |
| src/memory/hybrid.test.ts | 86 |
| src/memory/manager.async-search.test.ts | 82 |
| src/agents/tools/memory-tool.does-not-crash-on-errors.test.ts | 61 |

**Total Test Lines: 2,835**

**Number of Existing Test Files: 13**

## Complexity Assessment: HIGH

### Reasoning

1. **Large core class**: The `MemoryIndexManager` class alone is 2,232 lines with extensive state management:
   - Multiple embedding providers (OpenAI, Gemini, local)
   - Fallback provider switching on errors
   - Concurrent file indexing with batching
   - File system watching and debouncing
   - Session delta tracking
   - Embedding cache management
   - SQLite database operations
   - Vector extension loading with timeouts

2. **Multiple integration points**:
   - Three embedding providers (OpenAI, Gemini, node-llama-cpp)
   - Batch APIs for both OpenAI and Gemini with polling/timeout logic
   - SQLite + sqlite-vec extension
   - File system watchers (chokidar)
   - Session transcript event subscriptions

3. **Hybrid search algorithm**: Combines vector similarity scores with BM25 text search, requiring weighted score merging and deduplication.

4. **Async complexity**: Heavy use of:
   - Promise-based concurrency with limits
   - Retry logic with exponential backoff
   - Timeouts for embedding operations
   - Debounced file watching

5. **Configuration complexity**: Deep nested config with many options for:
   - Provider selection and fallback
   - Chunking parameters
   - Sync triggers and intervals
   - Query parameters (max results, min score, hybrid weights)
   - Batch settings
   - Cache settings

6. **Database schema**: Multiple tables (files, chunks, chunks_vec, chunks_fts, embedding_cache, meta) with foreign key relationships.

7. **Error handling**: Extensive error recovery including:
   - Provider fallback on errors
   - Batch failure tracking with limits
   - Atomic reindexing with temp databases
   - Graceful degradation when sqlite-vec unavailable

## Estimated Tests Required

Based on the complexity and current coverage gaps, the following test areas need attention:

### Unit Tests Needed (~40-50 tests)

| Area | Estimated Tests |
|------|----------------:|
| Embedding providers (OpenAI/Gemini/local edge cases) | 8-10 |
| Batch API error handling and retries | 6-8 |
| Chunk splitting and overlap | 4-5 |
| Hybrid search score merging | 4-5 |
| Config resolution and validation | 5-6 |
| Session file parsing | 4-5 |
| Cache eviction and pruning | 3-4 |
| Vector table dimension handling | 3-4 |
| File watcher debouncing | 2-3 |

### Integration Tests Needed (~15-20 tests)

| Area | Estimated Tests |
|------|----------------:|
| Full indexing workflow | 4-5 |
| Search with various providers | 4-5 |
| Provider fallback scenarios | 3-4 |
| Atomic reindex recovery | 2-3 |
| CLI command integration | 2-3 |

### Edge Case Tests (~10-15 tests)

| Area | Estimated Tests |
|------|----------------:|
| Large file handling | 2-3 |
| Concurrent search during indexing | 2-3 |
| Database corruption recovery | 2-3 |
| Network timeout handling | 2-3 |
| Unicode/special characters | 2-3 |

---

**Estimated Total Tests for Good Coverage: 65-85 tests**

Current coverage appears moderate with 13 test files, but given the complexity of the manager class and the multiple integration points, additional tests focusing on error paths, edge cases, and provider-specific behavior would significantly improve confidence.
