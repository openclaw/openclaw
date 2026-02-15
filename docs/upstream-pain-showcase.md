# Upstream Pain Showcase: How MongoDB Backend Solves OpenClaw Issues

This document maps specific open upstream issues to how the MongoDB memory backend addresses each one. All references are to the OpenClaw GitHub repository.

---

## Issue #16021: Hybrid Scoring Drops from 95% to 40%

**Problem:** The builtin `hybrid.ts` AND-joins all full-text search tokens (`"word1" AND "word2" AND ...`). This means a query like "how to configure memory" requires ALL tokens to appear in a document. Hit rate drops from 95% (single-term) to ~40% (multi-term) because most documents contain only some of the query terms.

**MongoDB Solution:** Our backend uses three layers of hybrid search that avoid this bug entirely:

1. **Level 1 ($scoreFusion / $rankFusion):** Server-side fusion on MongoDB 8.2+/8.0+. These operators handle tokenization and scoring internally with OR-join semantics -- no AND-join bug.
2. **Level 2 ($vectorSearch + $search keyword):** Separate vector and keyword pipelines merged client-side. The keyword pipeline uses MongoDB's native `$search` operator which uses OR-join by default.
3. **Level 3 (JS fallback):** For Community Edition without mongot, `mongodb-hybrid.ts` implements OR-join FTS with Reciprocal Rank Fusion (RRF) scoring (`1/(k+rank)` with k=60). This replaces the broken upstream `mergeHybridResults()` import.

**Files:** `src/memory/mongodb-hybrid.ts`, `src/memory/mongodb-search.ts` (Level 3 import)

---

## Issue #9888: Total Persistence Failure (Local Files Corrupted/Lost)

**Problem:** The builtin backend stores memory as local flat files. Users report total data loss when files are corrupted, accidentally deleted, or lost during system crashes. There is no recovery mechanism.

**MongoDB Solution:** Data lives in MongoDB, not local files. MongoDB provides:

- Write-ahead journaling (crash recovery)
- Replica set replication (redundancy)
- Point-in-time backups (Atlas)
- `withTransaction()` for atomic multi-document writes

Local files are still the source of truth for MEMORY.md content (the agent's notebook), but the indexed search data is safely stored in MongoDB collections with proper durability guarantees.

---

## Issue #3479: Compaction Context Loss

**Problem:** When conversation context is compacted (to fit token limits), all memory context accumulated during the session is lost. The agent starts fresh with no recollection of what was discussed.

**MongoDB Solution:** The `structured_mem` collection stores persistent key-value observations that survive compaction. When the agent writes structured memory via `memory_write` (e.g., `{type: "preference", key: "language", value: "TypeScript"}`), this data persists in MongoDB across all sessions and compactions. The agent can retrieve it via `memory_search` which queries structured_mem alongside other sources.

**Files:** `src/memory/mongodb-structured-memory.ts`

---

## Issue #2254: Session Bloat (Large Sessions Slow Everything)

**Problem:** Large session transcript files grow unbounded. Indexing them produces excessive chunks that slow down search and consume storage.

**MongoDB Solution:** Two mechanisms address session bloat:

1. **Hash-based dedup:** Session files are only re-indexed when their content hash changes. Unchanged sessions are skipped entirely (`mongodb-sync.ts` hash comparison).
2. **TTL indexes:** `embeddingCacheTtlDays` (default 30) auto-expires old embedding cache entries. `memoryTtlDays` (configurable, default disabled) can auto-expire old memory chunks.
3. **maxSessionChunks:** Configurable cap (default 50) on chunks per session file. When a session produces more chunks than the limit, only the last N (most recent) chunks are kept.

**Files:** `src/memory/mongodb-sync.ts`, `src/memory/mongodb-schema.ts` (TTL indexes), `src/memory/backend-config.ts` (maxSessionChunks)

---

## Issue #11308: QMD 20+ Bugs (Subprocess Chain Unreliable)

**Problem:** The QMD (Query Memory Daemon) backend relies on a subprocess chain: OpenClaw spawns QMD, which manages its own indexes, search, and embedding. This architecture has 20+ open bugs including timeouts, zombie processes, race conditions, and silent failures.

**MongoDB Solution:** No subprocess chain. The MongoDB backend queries MongoDB directly from the Node.js process:

- Search: `$vectorSearch`, `$search`, `$text` queries directly to MongoDB
- Indexing: `bulkWrite` for chunk upserts
- Embedding: Direct API calls to embedding providers (Voyage, OpenAI, etc.)

Zero IPC overhead, zero zombie processes, zero subprocess lifecycle management.

**Files:** `src/memory/mongodb-search.ts`, `src/memory/mongodb-sync.ts`, `src/memory/mongodb-manager.ts`

---

## Issue #11480: Bind-Mount SQLite Failures in Containers

**Problem:** The builtin backend uses SQLite (via `node:sqlite` DatabaseSync). When running in Docker containers with bind-mounted volumes, SQLite frequently fails with locking errors, corrupt databases, or filesystem incompatibilities.

**MongoDB Solution:** MongoDB is a network database. The connection is over TCP (`mongodb://` or `mongodb+srv://`), not a local file. There are no bind-mount issues, no filesystem locking, no SQLite WAL mode conflicts. Works identically in Docker, Kubernetes, or bare metal.

---

## Issue #14716: DatabaseSync Failures

**Problem:** Node.js `node:sqlite` (DatabaseSync) has known issues with concurrent access, WAL mode in certain environments, and crashes under load.

**MongoDB Solution:** MongoDB is accessed via the official `mongodb` driver over TCP. There is no local database file. The driver handles connection pooling (`maxPoolSize`, `minPoolSize`), automatic reconnection, and concurrent access natively. Multiple processes can safely share the same MongoDB instance.

**Files:** `src/memory/mongodb-manager.ts` (MongoClient with pool config)

---

## Issue #10324: No Transactions (Crash = Data Loss)

**Problem:** The builtin backend has no transaction support. A crash during a multi-step write (e.g., delete old chunks + insert new chunks) leaves the data in an inconsistent state -- old chunks deleted but new ones not yet written.

**MongoDB Solution:** `withTransaction()` pattern throughout the codebase:

- **File sync:** Delete old chunks + upsert new chunks + update metadata -- all atomic
- **Session sync:** Same atomic pattern for session transcript files
- **Stale cleanup:** Atomic deletion of stale chunks and file metadata
- **KB re-ingestion:** Delete old KB chunks + insert new -- wrapped in `withTransaction()`
- **KB document removal:** Delete chunks + delete document -- atomic

All transaction sites gracefully fall back to non-transactional writes on standalone topology (no replica set) via `isTransactionNotSupported()` detection.

**Files:** `src/memory/mongodb-sync.ts`, `src/memory/mongodb-kb.ts`

---

## Issue #13440: Multi-Instance Conflicts

**Problem:** Running multiple OpenClaw instances (e.g., different agents, different terminals) causes conflicts. Each instance maintains its own local index, leading to stale data, duplicate entries, and race conditions.

**MongoDB Solution:** All instances share the same MongoDB database. Two features enable safe multi-instance operation:

1. **Shared collections:** All instances read/write the same `chunks`, `files`, `knowledge_base`, `kb_chunks`, and `structured_mem` collections. Upserts with deterministic `_id` values prevent duplicates.
2. **Change Streams (opt-in):** When `enableChangeStreams: true`, instances receive real-time notifications of changes made by other instances via MongoDB Change Streams. This triggers re-sync without polling.

**Files:** `src/memory/mongodb-change-stream.ts`, `src/memory/mongodb-manager.ts`
