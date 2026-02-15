# ClawMongo: MongoDB Backend for OpenClaw

## Project Identity

ClawMongo adds MongoDB as a memory/storage backend for OpenClaw. This is NOT a rewrite of OpenClaw. This is OpenClaw itself, with a third memory backend option (`"mongodb"`) alongside the existing `"builtin"` (SQLite) and `"qmd"` backends.

**This project is a fork of https://github.com/openclaw/openclaw.**

The only files we create or modify are those needed to wire MongoDB as a storage backend. Everything else in OpenClaw stays untouched.

## What We Built

A `MongoDBMemoryManager` class that implements OpenClaw's existing `MemorySearchManager` interface, replacing SQLite with MongoDB for:

- **Chunk storage** (text chunks with embeddings) -> MongoDB collection with Vector Search index
- **File tracking** (file metadata for change detection) -> MongoDB collection
- **Embedding cache** (cached embeddings from providers) -> MongoDB collection
- **Full-text search** (FTS5 in SQLite) -> MongoDB `$search` (Atlas Search / mongot)
- **Vector search** (sqlite-vec extension) -> MongoDB `$vectorSearch`
- **Hybrid search** (BM25 + cosine merged) -> `$scoreFusion` (8.2+), `$rankFusion` (8.0+), or JS merge fallback

## Target: MongoDB 8.2+

All editions (Atlas and Community) support the full feature set when running MongoDB 8.2+. The implementation gracefully degrades on older versions or bare Community installs without mongot.

## The Interface Contract (DO NOT CHANGE)

This is the interface we implement. It lives in `src/memory/types.ts` and we do NOT modify it:

```typescript
export interface MemorySearchManager {
  search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]>;
  readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }>;
  status(): MemoryProviderStatus;
  sync?(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
}
```

## Files Created

| File                            | Purpose                                                                                   | Status |
| ------------------------------- | ----------------------------------------------------------------------------------------- | ------ |
| `src/memory/mongodb-manager.ts` | Main `MongoDBMemoryManager` class implementing `MemorySearchManager`                      | Done   |
| `src/memory/mongodb-schema.ts`  | Collection setup, standard indexes, search indexes, capability detection                  | Done   |
| `src/memory/mongodb-search.ts`  | Search implementations: vector, keyword, hybrid ($scoreFusion/$rankFusion/JS), dispatcher | Done   |
| `src/memory/mongodb-sync.ts`    | File sync: list disk files, hash comparison, chunk + embed, bulk upsert, stale cleanup    | Done   |

## Files Modified (minimal, surgical changes)

| File                           | Change                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/config/types.memory.ts`   | Added `"mongodb"` to `MemoryBackend` union, `MemoryMongoDBConfig` type with deployment profiles/embedding modes/fusion methods, `mongodb?` field to `MemoryConfig` |
| `src/memory/types.ts`          | Added `"mongodb"` to `MemoryProviderStatus.backend` union                                                                                                          |
| `src/memory/backend-config.ts` | Added `ResolvedMongoDBConfig` type, MongoDB config resolution branch with defaults and `OPENCLAW_MONGODB_URI` env var support                                      |
| `src/memory/search-manager.ts` | Added MongoDB factory branch with `MONGODB_MANAGER_CACHE` and `buildMongoDBCacheKey()`                                                                             |

## Deployment Tiers (4 Profiles)

| Profile                    | Description                | Vector Search          | Text Search            | Hybrid Fusion                  | Automated Embedding                   |
| -------------------------- | -------------------------- | ---------------------- | ---------------------- | ------------------------------ | ------------------------------------- |
| **`atlas-default`** (M10+) | Full Atlas cluster         | Native `$vectorSearch` | Native `$search`       | `$scoreFusion` / `$rankFusion` | Voyage AI (Public Preview)            |
| **`atlas-m0`**             | Free/shared tier           | Native (3 index limit) | Native (3 index limit) | `$scoreFusion` / `$rankFusion` | Voyage AI                             |
| **`community-mongot`**     | Self-hosted with mongot    | Native `$vectorSearch` | Native `$search`       | `$scoreFusion` / `$rankFusion` | Voyage AI (Public Preview, Jan 2026+) |
| **`community-bare`**       | Self-hosted without mongot | JS cosine fallback     | `$text` index fallback | JS merge only                  | No (managed mode only)                |

**Key insight (Sep 2025+):** MongoDB Community Edition gained native `$vectorSearch` and `$search` via the open-source mongot engine. Community+mongot is now functionally equivalent to Atlas for search capabilities.

### Capability Detection

The implementation probes the connected MongoDB at startup to detect what's available:

```typescript
type DetectedCapabilities = {
  vectorSearch: boolean; // $vectorSearch / $search supported (mongot available)
  textSearch: boolean; // Atlas Search / mongot text search available
  scoreFusion: boolean; // $scoreFusion stage recognized (8.2+)
  rankFusion: boolean; // $rankFusion stage recognized (8.0+)
  automatedEmbedding: boolean; // Voyage AI auto-embedding supported
};
```

Detection uses non-destructive probes: `$rankFusion`/`$scoreFusion` on a dummy collection, `listSearchIndexes()` to check mongot availability.

## Search Architecture

### Hybrid Search Cascade

The search dispatcher (`mongoSearch()`) cascades through strategies until one succeeds:

```
$scoreFusion (8.2+)
  ├── sigmoid normalization, weighted avg (0.7 vector / 0.3 text)
  └── fails? ↓
$rankFusion (8.0+)
  ├── Reciprocal Rank Fusion with weights
  └── fails? ↓
JS Merge (separate queries)
  ├── Run $vectorSearch + $search in parallel, merge with mergeHybridResults()
  └── fails? ↓
Vector Only ($vectorSearch)
  └── fails? ↓
Keyword Only ($search)
  └── fails? ↓
$text Index (Community without mongot)
  └── fails? → empty results
```

### Embedding Modes

| Mode                      | How It Works                                                                                                                                                                  | When to Use                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **`automated`** (default) | MongoDB generates embeddings at index-time and query-time using Voyage AI. Index uses `type: "autoEmbed"`. Queries use `query: { text }` in `$vectorSearch`.                  | Community+mongot v8.2+ (Preview). Atlas support coming soon. |
| **`managed`**             | OpenClaw generates embeddings using its existing provider pipeline (Voyage/OpenAI/Gemini/local). Index uses `type: "vector"` on `embedding` field. Queries use `queryVector`. | Community bare, Atlas, or when you need a specific provider  |

### Fusion Methods

| Method                      | MongoDB Version | How It Works                                                              |
| --------------------------- | --------------- | ------------------------------------------------------------------------- |
| **`scoreFusion`** (default) | 8.2+            | Score-based fusion with sigmoid normalization, weighted average           |
| **`rankFusion`**            | 8.0+            | Reciprocal Rank Fusion (less sensitive to score distribution differences) |
| **`js-merge`**              | Any             | Separate vector + keyword queries merged in application code              |

## Configuration

```json5
{
  memory: {
    backend: "mongodb",
    mongodb: {
      uri: "mongodb+srv://...", // or OPENCLAW_MONGODB_URI env var
      database: "openclaw", // default: "openclaw"
      collectionPrefix: "openclaw_", // default: "openclaw_"
      deploymentProfile: "atlas-default", // atlas-default | atlas-m0 | community-mongot | community-bare
      embeddingMode: "automated", // automated | managed
      fusionMethod: "scoreFusion", // scoreFusion | rankFusion | js-merge
      quantization: "none", // none | scalar | binary
    },
  },
}
```

## MongoDB Collections

| Collection                 | Schema                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `openclaw_chunks`          | `{ _id: "path:startLine:endLine", path, source, startLine, endLine, hash, model, text, embedding?, updatedAt }` |
| `openclaw_files`           | `{ _id: path, source, hash, mtime, size, updatedAt }`                                                           |
| `openclaw_embedding_cache` | `{ provider, model, providerKey, hash, embedding, dims, updatedAt }` with composite unique index                |
| `openclaw_meta`            | `{ _id: key, value }`                                                                                           |

### Indexes

**Standard indexes** (all editions):

- `chunks`: `{ path: 1 }`, `{ source: 1 }`, `{ path: 1, hash: 1 }`, `{ updatedAt: -1 }`
- `embedding_cache`: `{ provider: 1, model: 1, providerKey: 1, hash: 1 }` (unique), `{ updatedAt: 1 }`

**Search indexes** (Atlas / Community+mongot):

- Text search: Atlas Search index on `text` field with `lucene.standard` analyzer, `source`/`path` as token filters, `updatedAt` as date filter
- Vector search (managed mode): `type: "vector"` index on `embedding` field, 1536 dimensions, cosine similarity, `source`/`path` as filter fields
- Vector search (automated mode): `type: "autoEmbed"` index on `text` field, model `voyage-4-large`, `source`/`path` as filter fields. MongoDB generates and manages embeddings automatically via Voyage AI.

### Index Budget (Atlas M0)

Atlas M0 free tier has a limit of 3 combined search/vector indexes. The `assertIndexBudget()` function checks this before creating indexes. On managed/self-managed profiles, there is no limit.

## MongoDB Superpowers

Features that make the MongoDB backend genuinely better than SQLite:

### 1. Automated Embedding (Public Preview, Jan 2026)

MongoDB generates embeddings at index-time and query-time using built-in Voyage AI. No external API calls, no embedding pipeline to manage, no sync to keep embeddings fresh. OpenClaw's SQLite backend spends 800+ lines managing embedding generation — with automated mode, MongoDB handles all of it natively.

### 2. Native Hybrid Search Fusion

`$scoreFusion` and `$rankFusion` combine vector + text search results in a single aggregation pipeline, server-side. SQLite requires running two separate queries and merging in JavaScript.

### 3. Vector Quantization (GA)

Automatic quantization of float embeddings to `scalar` (int8, 3.75x RAM reduction) or `binary` (int1, 24x RAM reduction) while retaining 90-95% accuracy. SQLite has no equivalent.

### 4. Atlas Search Compound Operator

`compound` operator with `must`/`should`/`mustNot`/`filter` clauses and score boosting. Enables richer text search than SQLite FTS5's simple BM25 — boost recent documents, boost memory over sessions, boost exact matches, all in a single query.

### 5. Change Streams (Future)

Real-time feed of collection changes without polling. Enables multi-device memory sync and collaborative memory editing. Not used in current implementation but available as a MongoDB advantage.

## Code Reuse

OpenClaw's well-factored internals are reused extensively:

- **`internal.ts`**: `chunkMarkdown()`, `hashText()`, `listMemoryFiles()`, `buildFileEntry()`, `cosineSimilarity()`
- **`hybrid.ts`**: `mergeHybridResults()`, `HybridVectorResult`, `HybridKeywordResult` (used for JS merge fallback)
- **`embeddings.ts`**: Full embedding provider pipeline (Voyage/OpenAI/Gemini/local) for managed mode
- **`session-files.ts`**: Session transcript listing and parsing
- Only the storage layer (SQLite -> MongoDB) and search execution (SQL -> aggregation pipelines) are replaced.

## Anti-Patterns (DO NOT)

- **DO NOT** rewrite OpenClaw features that already work. We are adding a backend, not rebuilding the platform.
- **DO NOT** modify OpenClaw's agent runtime, channel adapters, tool execution, canvas, CLI, or any non-memory code.
- **DO NOT** add MongoDB to session storage (sessions use append-only JSON files — that stays as-is).
- **DO NOT** over-abstract. One concrete `MongoDBMemoryManager` class, not a framework.

## Testing Strategy

1. **Unit tests**: Test `MongoDBMemoryManager` methods against a real MongoDB instance (use `mongodb-memory-server` for CI or a local `mongod`)
2. **Parity tests**: Run the same queries against both SQLite and MongoDB backends, verify results are equivalent
3. **Follow OpenClaw's existing test patterns**: `src/memory/manager.*.test.ts` conventions

## Upstream Sync

Since this is a fork:

- `git remote add upstream https://github.com/openclaw/openclaw.git`
- `git fetch upstream && git merge upstream/main` periodically
- Conflicts will only occur in the 4 files we modified (config types, backend-config, search-manager, types)
- These conflicts are small and predictable

## Success Criteria

The backend is done when:

1. A user can set `"memory": { "backend": "mongodb" }` in their config
2. OpenClaw boots, connects to MongoDB, creates collections/indexes
3. Capabilities are auto-detected (vector search, text search, fusion support)
4. Memory files are synced to MongoDB (chunked, optionally embedded, indexed)
5. `memory_search` tool returns relevant results using hybrid search
6. `memory_get` tool reads files correctly
7. `memory status` shows the MongoDB backend with correct stats
8. Graceful degradation across all 4 deployment profiles
9. Upstream OpenClaw updates merge cleanly
