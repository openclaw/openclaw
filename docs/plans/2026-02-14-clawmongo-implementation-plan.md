# ClawMongo Implementation Plan: MongoDB Backend for OpenClaw

**Date**: 2026-02-14
**Target**: MongoDB 8.2+ (all editions)
**Research**: `docs/research/2026-02-14-mongodb-capabilities-atlas-vs-community.md`

---

## 0. Key Decisions

| Decision            | Choice                           | Rationale                                                                                    |
| ------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- |
| Min MongoDB version | **8.2+**                         | Enables $scoreFusion everywhere (Atlas + Community)                                          |
| Default fusion      | **$scoreFusion**                 | Score-based with sigmoid normalization. More flexible than $rankFusion                       |
| Default embedding   | **Automated**                    | MongoDB Voyage AI autoEmbed when available. Falls back to managed (OpenClaw pipeline)        |
| Community strategy  | **Native first**                 | Community 8.2+ with mongot has native $vectorSearch/$search. JS fallback only without mongot |
| Default weights     | **0.7 vector / 0.3 text**        | Matches OpenClaw's existing hybrid defaults                                                  |
| Clone source        | `github.com/romiluz13/ClawMongo` | OpenClaw fork with MongoDB additions                                                         |

---

## 1. Project Setup

### Step 1.1: Clone the OpenClaw Fork

```bash
cd /Users/rom.iluz/Dev/ClawMongo-v2
git clone https://github.com/romiluz13/ClawMongo.git .
```

If the directory has existing files (CLAWMONGO_FRESH_START.md, .claude/, docs/):

```bash
# Clone to temp, then merge
git clone https://github.com/romiluz13/ClawMongo.git /tmp/clawmongo-fork
cp -r /tmp/clawmongo-fork/.git .
git checkout -- .
# Re-add our files
git add CLAWMONGO_FRESH_START.md docs/ .claude/
```

### Step 1.2: Add MongoDB Driver

```bash
pnpm add mongodb
```

### Step 1.3: Verify OpenClaw Builds

```bash
pnpm install
pnpm build       # Must pass with zero errors
pnpm test        # Baseline - all existing tests must pass
```

---

## 2. Update CLAWMONGO_FRESH_START.md

The spec needs these updates to reflect current MongoDB capabilities (Feb 2026):

### 2a. Update Deployment Tiers Table (line ~245)

**Replace** the 3-tier table with 4 tiers:

| Tier                   | Description               | Vector Search        | Text Search          | Hybrid Search         | Auto Embedding    |
| ---------------------- | ------------------------- | -------------------- | -------------------- | --------------------- | ----------------- |
| **Atlas M10+**         | Full Atlas cluster        | Native $vectorSearch | Native $search       | $scoreFusion (native) | Coming Soon       |
| **Atlas M0/Free**      | Free tier (3 index limit) | Native $vectorSearch | Native $search       | $scoreFusion (native) | Coming Soon       |
| **Community + mongot** | Self-hosted with mongot   | Native $vectorSearch | Native $search       | $scoreFusion (native) | Public Preview    |
| **Community (bare)**   | Self-hosted, no mongot    | JS cosine fallback   | $text index fallback | JS merge fallback     | N/A (use managed) |

### 2b. Update Search Operations Mapping (~line 122)

Add `$scoreFusion` as the primary hybrid method:

| SQLite Operation        | MongoDB Equivalent                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vec_distance_cosine()` | `$vectorSearch` with `cosine` similarity                                                                                                            |
| `bm25(chunks_fts)`      | `$search` with `text` operator                                                                                                                      |
| `mergeHybridResults()`  | **Primary**: `$scoreFusion` (8.2+, sigmoid normalization). **Fallback**: `$rankFusion` (8.0+). **Last resort**: JS merge via `mergeHybridResults()` |

### 2c. Update MongoDB Superpowers Section (~line 156)

Update Automated Embedding section: now Public Preview on Community Edition (Jan 2026), not just future. Update the status from "Jan 2026" speculation to confirmed availability.

### 2d. Update Key Behavioral Differences (~line 129)

Add: "Community Edition 8.2+ with mongot has native $vectorSearch and $search - same operators as Atlas. JS fallback only needed when mongot is not installed."

### 2e. Update Important Compatibility Note (~line 241)

Change: "$rankFusion requires MongoDB 8.0+, $scoreFusion requires MongoDB 8.2+. Both work on Atlas, Enterprise, AND Community Edition. For bare Community without mongot, fall back to JS merge."

---

## 3. Configuration Changes (4 Surgical Modifications)

### 3a. `src/config/types.memory.ts`

**Add** to `MemoryBackend` union:

```typescript
export type MemoryBackend = "builtin" | "qmd" | "mongodb";
```

**Add** new config type:

```typescript
export interface MemoryMongoDBConfig {
  /** Connection string. Env fallback: OPENCLAW_MONGODB_URI */
  uri?: string;
  /** Database name. Default: "openclaw" */
  database?: string;
  /** Collection prefix. Default: "openclaw_" */
  collectionPrefix?: string;
  /** Deployment profile. Default: "atlas-default" */
  deploymentProfile?: "atlas-default" | "atlas-m0" | "community-mongot" | "community-bare";
  /** Embedding mode. Default: "automated" */
  embeddingMode?: "automated" | "managed";
  /** Hybrid fusion method. Default: "scoreFusion" */
  fusionMethod?: "scoreFusion" | "rankFusion" | "js-merge";
  /** Vector quantization. Default: "none" */
  quantization?: "none" | "scalar" | "binary";
}
```

**Add** to `MemoryConfig`:

```typescript
mongodb?: MemoryMongoDBConfig;
```

### 3b. `src/memory/types.ts`

**Add** `"mongodb"` to `MemoryProviderStatus.backend`:

```typescript
backend: "builtin" | "qmd" | "mongodb";
```

### 3c. `src/memory/backend-config.ts`

**Add** `ResolvedMongoDBConfig` type:

```typescript
export interface ResolvedMongoDBConfig {
  uri: string;
  database: string;
  collectionPrefix: string;
  deploymentProfile: "atlas-default" | "atlas-m0" | "community-mongot" | "community-bare";
  embeddingMode: "automated" | "managed";
  fusionMethod: "scoreFusion" | "rankFusion" | "js-merge";
  quantization: "none" | "scalar" | "binary";
}
```

**Add** MongoDB resolution branch in the config resolution function:

```typescript
if (config.backend === "mongodb") {
  const uri = config.mongodb?.uri ?? process.env.OPENCLAW_MONGODB_URI;
  if (!uri) throw new Error("MongoDB URI required: set memory.mongodb.uri or OPENCLAW_MONGODB_URI");
  return {
    backend: "mongodb",
    mongodb: {
      uri,
      database: config.mongodb?.database ?? "openclaw",
      collectionPrefix: config.mongodb?.collectionPrefix ?? "openclaw_",
      deploymentProfile: config.mongodb?.deploymentProfile ?? "atlas-default",
      embeddingMode: config.mongodb?.embeddingMode ?? "automated",
      fusionMethod: config.mongodb?.fusionMethod ?? "scoreFusion",
      quantization: config.mongodb?.quantization ?? "none",
    },
  };
}
```

**Add** `mongodb?` to `ResolvedMemoryBackendConfig`:

```typescript
mongodb?: ResolvedMongoDBConfig;
```

### 3d. `src/memory/search-manager.ts`

**Add** MongoDB factory branch in `getMemorySearchManager()`:

```typescript
if (resolved.backend === "mongodb" && resolved.mongodb) {
  const { MongoDBMemoryManager } = await import("./mongodb-manager.js");
  const manager = await MongoDBMemoryManager.create(params);
  return { manager };
}
```

---

## 4. New Files: MongoDB Backend Implementation

### 4a. `src/memory/mongodb-schema.ts` — Collection Setup & Indexes

**Purpose**: Create collections, standard indexes, search indexes, vector search indexes.

**Collections** (with `openclaw_` prefix):

| Collection                 | Schema                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `openclaw_files`           | `{ _id: path, source, hash, mtime, size }`                                                      |
| `openclaw_chunks`          | `{ _id: chunkId, path, source, startLine, endLine, hash, model, text, embedding[], updatedAt }` |
| `openclaw_embedding_cache` | `{ _id: compositeKey, provider, model, providerKey, hash, embedding[], dims, updatedAt }`       |
| `openclaw_meta`            | `{ _id: key, value }`                                                                           |

**Standard Indexes**:

```typescript
// openclaw_chunks
{ path: 1 }                    // idx_chunks_path
{ source: 1 }                  // idx_chunks_source
{ path: 1, hash: 1 }          // idx_chunks_path_hash (for sync lookups)
{ updatedAt: -1 }             // idx_chunks_updated (for recency boost)

// openclaw_embedding_cache
{ provider: 1, model: 1, providerKey: 1, hash: 1 }  // unique compound
{ updatedAt: 1 }              // idx_cache_updated (for TTL/cleanup)

// openclaw_files
// _id is the path (natural key), no extra indexes needed
```

**Search Index** (Atlas Search / mongot):

```typescript
// Atlas Search index on openclaw_chunks
{
  name: "openclaw_chunks_text",
  type: "search",
  definition: {
    mappings: {
      dynamic: false,
      fields: {
        text: { type: "string", analyzer: "lucene.standard" },
        source: { type: "token" },       // filter field
        path: { type: "token" },          // filter field
        updatedAt: { type: "date" }       // for recency scoring
      }
    }
  }
}
```

**Vector Search Index** on `openclaw_chunks`:

```typescript
// Mode 1: Automated Embedding (default)
{
  name: "openclaw_chunks_vector",
  type: "vectorSearch",
  definition: {
    fields: [{
      type: "vector",
      path: "embedding",
      numDimensions: 1536,
      similarity: "cosine",
      quantization: "scalar",     // configurable
      // When automated embedding is available:
      autoEmbed: {
        sourceField: "text",
        model: "voyage-4-large"
      }
    }, {
      type: "filter",
      path: "source"
    }, {
      type: "filter",
      path: "path"
    }]
  }
}

// Mode 2: Managed Embedding (OpenClaw pipeline fills embedding field)
{
  name: "openclaw_chunks_vector",
  type: "vectorSearch",
  definition: {
    fields: [{
      type: "vector",
      path: "embedding",
      numDimensions: 1536,    // matches voyage-4-large
      similarity: "cosine",
      quantization: "scalar"  // configurable
    }, {
      type: "filter",
      path: "source"
    }, {
      type: "filter",
      path: "path"
    }]
  }
}
```

**Key functions**:

- `ensureCollections(db, prefix)` — Create collections if not exist
- `ensureStandardIndexes(db, prefix)` — Create standard indexes
- `ensureSearchIndexes(db, prefix, profile, embeddingMode)` — Create search/vector indexes
- `detectCapabilities(db)` — Probe what features are available (returns tier)
- `assertIndexBudget(profile, planned)` — Check M0 limits (max 3)

**Capability Detection** (ported from v1's fusion probe pattern):

```typescript
async function detectCapabilities(db: Db): Promise<DetectedCapabilities> {
  // 1. Try $vectorSearch probe → native vector available?
  // 2. Try $search probe → native text search available?
  // 3. Try $scoreFusion probe → native fusion available?
  // 4. Try $rankFusion probe → fallback fusion available?
  // 5. Return { vectorSearch, textSearch, scoreFusion, rankFusion, automatedEmbedding }
}
```

### 4b. `src/memory/mongodb-search.ts` — Search Implementations

**Purpose**: Vector search, keyword search, hybrid search using MongoDB.

**Port from v1**: Adapt `MongoVectorRetriever`, `MongoLexicalRetriever`, `AdaptiveFusionRetriever` patterns to work within OpenClaw's `MemorySearchManager.search()` contract.

**Vector Search** (native path):

```typescript
async function vectorSearch(
  collection: Collection,
  query: string,
  queryVector: number[],
  opts: { maxResults: number; minScore: number; source?: string; indexName: string },
): Promise<MemorySearchResult[]> {
  const pipeline = [
    {
      $vectorSearch: {
        index: opts.indexName,
        path: "embedding",
        queryVector,
        numCandidates: opts.maxResults * 20, // 20x rule
        limit: opts.maxResults,
        ...(opts.source ? { filter: { source: opts.source } } : {}),
      },
    },
    {
      $project: {
        _id: 0,
        path: 1,
        startLine: 1,
        endLine: 1,
        text: 1,
        source: 1,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ];
  // Map to MemorySearchResult[]
}
```

**Keyword Search** (native path):

```typescript
async function keywordSearch(
  collection: Collection,
  query: string,
  opts: { maxResults: number; minScore: number; source?: string; indexName: string },
): Promise<MemorySearchResult[]> {
  const pipeline = [
    {
      $search: {
        index: opts.indexName,
        compound: {
          must: [{ text: { query, path: "text" } }],
          ...(opts.source ? { filter: [{ equals: { path: "source", value: opts.source } }] } : {}),
        },
      },
    },
    { $limit: opts.maxResults * 4 },
    {
      $project: {
        _id: 0,
        path: 1,
        startLine: 1,
        endLine: 1,
        text: 1,
        source: 1,
        score: { $meta: "searchScore" },
      },
    },
  ];
  // Map to MemorySearchResult[]
}
```

**Hybrid Search** with $scoreFusion (PRIMARY - MongoDB 8.2+):

```typescript
async function hybridSearch(
  collection: Collection,
  query: string,
  queryVector: number[],
  opts: {
    maxResults: number;
    minScore: number;
    source?: string;
    vectorIndexName: string;
    textIndexName: string;
    vectorWeight: number; // default 0.7
    textWeight: number; // default 0.3
  },
): Promise<MemorySearchResult[]> {
  const sourceFilter = opts.source ? { filter: { source: opts.source } } : {};

  const pipeline = [
    {
      $scoreFusion: {
        input: {
          pipelines: {
            vector: [
              {
                $vectorSearch: {
                  index: opts.vectorIndexName,
                  path: "embedding",
                  queryVector,
                  numCandidates: opts.maxResults * 20,
                  limit: opts.maxResults * 4,
                  ...sourceFilter,
                },
              },
            ],
            text: [
              {
                $search: {
                  index: opts.textIndexName,
                  compound: {
                    must: [{ text: { query, path: "text" } }],
                    ...(opts.source
                      ? { filter: [{ equals: { path: "source", value: opts.source } }] }
                      : {}),
                  },
                },
              },
              { $limit: opts.maxResults * 4 },
            ],
          },
          normalization: "sigmoid",
        },
        combination: {
          weights: {
            vector: opts.vectorWeight,
            text: opts.textWeight,
          },
          method: "avg",
        },
        scoreDetails: false,
      },
    },
    { $limit: opts.maxResults },
    {
      $project: {
        _id: 0,
        path: 1,
        startLine: 1,
        endLine: 1,
        text: 1,
        source: 1,
        score: { $meta: "searchScore" },
      },
    },
  ];
  // Map to MemorySearchResult[], filter by minScore
}
```

**Fallback Chain**:

1. Try `$scoreFusion` (8.2+) → if unsupported stage error:
2. Try `$rankFusion` (8.0+) → if unsupported:
3. Run vector + keyword separately, merge with `mergeHybridResults()` from OpenClaw's `hybrid.ts`
4. For bare Community (no mongot): JS `cosineSimilarity()` + `lexicalTokenScore()` from v1's `shared.ts`

### 4c. `src/memory/mongodb-sync.ts` — File Sync Logic

**Purpose**: Sync memory files from disk to MongoDB. This is the most complex piece.

**Port from**: OpenClaw's `manager-sync-ops.ts` (999 lines) and `manager-embedding-ops.ts` (804 lines), adapting SQLite writes to MongoDB writes.

**Key operations**:

1. **List files on disk**: Reuse `listMemoryFiles()` from `internal.ts`
2. **Compare hashes**: Query `openclaw_files` collection, compare with disk
3. **Chunk changed files**: Reuse `chunkMarkdown()` from `internal.ts`
4. **Generate embeddings**:
   - **Automated mode**: Skip embedding generation entirely — MongoDB autoEmbed handles it at index time. Just store text in chunks, no `embedding` field needed.
   - **Managed mode**: Reuse OpenClaw's embedding pipeline (`createEmbeddingProvider()` from `embeddings.ts`), store resulting vectors in `embedding` field.
5. **Upsert chunks**: `bulkWrite()` with `updateOne` + `upsert: true`
6. **Delete stale chunks**: Remove chunks for deleted/moved files
7. **Update file metadata**: Upsert into `openclaw_files`
8. **Progress reporting**: Call `progress()` callback throughout

**Sync function signature**:

```typescript
async function syncToMongoDB(params: {
  db: Db;
  prefix: string;
  embeddingMode: "automated" | "managed";
  embeddingProvider?: EmbeddingProvider;
  reason?: string;
  force?: boolean;
  progress?: (update: MemorySyncProgressUpdate) => void;
}): Promise<void>;
```

**Batch upsert pattern** (ported from v1):

```typescript
const ops = chunks.map((chunk) => ({
  updateOne: {
    filter: { _id: chunk.id },
    update: { $set: { ...chunk, updatedAt: new Date() } },
    upsert: true,
  },
}));
await collection.bulkWrite(ops, { ordered: false });
```

**Session transcript syncing**: Reuse `listSessionFiles()` from `session-files.ts`, chunk and index same as memory files but with `source: "sessions"`.

### 4d. `src/memory/mongodb-manager.ts` — Main Manager Class

**Purpose**: Implements `MemorySearchManager` interface. Orchestrates all other modules.

```typescript
import type {
  MemorySearchManager,
  MemorySearchResult,
  MemoryProviderStatus,
  MemorySyncProgressUpdate,
  MemoryEmbeddingProbeResult,
} from "./types.js";

export class MongoDBMemoryManager implements MemorySearchManager {
  private client: MongoClient;
  private db: Db;
  private config: ResolvedMongoDBConfig;
  private capabilities: DetectedCapabilities;

  // Static factory (async initialization)
  static async create(params: MemorySearchManagerParams): Promise<MongoDBMemoryManager> {
    const config = params.resolved.mongodb!;
    const client = new MongoClient(config.uri, {
      appName: "openclaw-mongodb-memory",
      serverSelectionTimeoutMS: 5000,
    });
    await client.connect();
    const db = client.db(config.database);

    // Setup collections and indexes
    await ensureCollections(db, config.collectionPrefix);
    await ensureStandardIndexes(db, config.collectionPrefix);
    const capabilities = await detectCapabilities(db);
    await ensureSearchIndexes(
      db,
      config.collectionPrefix,
      config.deploymentProfile,
      config.embeddingMode,
    );

    return new MongoDBMemoryManager(client, db, config, capabilities, params);
  }

  // === Interface Methods ===

  async search(query, opts?): Promise<MemorySearchResult[]> {
    // Determine search strategy based on capabilities
    // 1. If hybrid capable → hybridSearch() with $scoreFusion
    // 2. Else if vector capable → vectorSearch()
    // 3. Else → keywordSearch() or JS fallback
    // Filter by opts.sessionKey for source filtering
    // Apply minScore threshold
    // Return top maxResults
  }

  readFile(params): Promise<{ text: string; path: string }> {
    // Read from DISK, not from MongoDB!
    // Same implementation as SQLite backend
    // Reuse file reading logic from internal.ts
  }

  status(): MemoryProviderStatus {
    return {
      backend: "mongodb",
      provider:
        this.config.embeddingMode === "automated" ? "voyage-ai-automated" : embeddingProvider.name,
      model: this.config.embeddingMode === "automated" ? "voyage-4-large" : embeddingProvider.model,
      custom: {
        deploymentProfile: this.config.deploymentProfile,
        embeddingMode: this.config.embeddingMode,
        fusionMethod: this.config.fusionMethod,
        capabilities: this.capabilities,
        collections: {
          /* collection stats */
        },
        indexStatus: {
          /* search index availability */
        },
      },
    };
  }

  async sync(params?): Promise<void> {
    await syncToMongoDB({
      db: this.db,
      prefix: this.config.collectionPrefix,
      embeddingMode: this.config.embeddingMode,
      embeddingProvider: this.embeddingProvider,
      reason: params?.reason,
      force: params?.force,
      progress: params?.progress,
    });
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    if (this.config.embeddingMode === "automated") {
      // Automated mode: embeddings always "available" (MongoDB handles it)
      return { available: true, provider: "voyage-ai-automated", model: "voyage-4-large" };
    }
    // Managed mode: delegate to OpenClaw's existing probe
  }

  async probeVectorAvailability(): Promise<boolean> {
    return this.capabilities.vectorSearch;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
```

### 4e. `src/memory/mongodb-manager.test.ts` — Tests

**Testing approach**:

- Use `mongodb-memory-server` for unit tests (fast, no external deps)
- Note: `mongodb-memory-server` may not support mongot/search indexes — mock those paths
- For search index tests, use a real Atlas cluster or skip in CI

**Test categories**:

1. **Connection**: Create/close manager
2. **Sync**: File sync, chunk upsert, stale cleanup
3. **Search**: Vector, keyword, hybrid (mock search indexes)
4. **Status**: Verify status output format
5. **readFile**: Verify disk read (not DB read)
6. **Capability detection**: Profile-based behavior
7. **Parity**: Same queries produce equivalent results to SQLite backend

---

## 5. Implementation Order (Phases)

### Phase 1: Foundation (MVP Boot)

1. Clone fork, add mongodb dep, verify build
2. Create `mongodb-schema.ts` — collections + standard indexes
3. Create `mongodb-manager.ts` — skeleton with `create()`, `close()`, `status()`, `readFile()`
4. Wire config changes (all 4 files)
5. **Milestone**: `openclaw --memory-backend mongodb` boots, connects, creates collections

### Phase 2: Sync Engine

6. Create `mongodb-sync.ts` — file listing, hash comparison, chunking
7. Implement `sync()` in manager — managed mode first (OpenClaw embedding pipeline)
8. Batch upsert with `bulkWrite()`
9. Stale chunk cleanup
10. **Milestone**: Memory files synced to MongoDB with embeddings

### Phase 3: Search Quality

11. Create `mongodb-search.ts` — vector, keyword, hybrid
12. Implement native `$vectorSearch` path
13. Implement native `$search` path
14. Implement `$scoreFusion` hybrid (primary)
15. Implement `$rankFusion` hybrid (fallback)
16. Implement JS merge (last resort fallback)
17. **Milestone**: `memory_search` returns relevant results

### Phase 4: Automated Embedding

18. Add automated embedding mode to sync (skip embedding generation)
19. Add autoEmbed to vector search index definition
20. Add capability detection for automated embedding
21. **Milestone**: Zero-config embedding — just store text, MongoDB indexes it

### Phase 5: Deployment Compatibility

22. Implement capability detection probe
23. Atlas M0 index budget checking
24. Community mongot detection
25. Community bare fallback (JS cosine + $text)
26. Helpful error messages for misconfiguration
27. **Milestone**: Works on all 4 deployment tiers

### Phase 6: Tests & Polish

28. Unit tests with mongodb-memory-server
29. Parity tests (SQLite vs MongoDB)
30. Status formatting and diagnostics
31. Update CLAWMONGO_FRESH_START.md with lessons learned
32. **Milestone**: Ship-ready

---

## 6. MongoDB Superpowers: What Makes This Better Than SQLite

These are concrete advantages the MongoDB backend provides over SQLite:

| Capability              | SQLite                                | MongoDB                                            | Advantage                             |
| ----------------------- | ------------------------------------- | -------------------------------------------------- | ------------------------------------- |
| **Automated Embedding** | 800+ lines of embedding pipeline code | `autoEmbed` in index definition                    | Eliminates entire embedding subsystem |
| **Hybrid Search**       | Custom JS merge function              | Native `$scoreFusion` with normalization           | Better relevance, no custom code      |
| **Vector Quantization** | Not available                         | `scalar` (3.75x) or `binary` (24x)                 | Massive RAM savings at scale          |
| **Score Boosting**      | Basic BM25 rank                       | `compound` with `should` clauses + score functions | Boost recency, source priority        |
| **Multi-device Sync**   | Local file only                       | Cloud database (Atlas)                             | Access memory from anywhere           |
| **Search Relevance**    | FTS5 (basic)                          | Lucene-powered Atlas Search                        | Better tokenization, stemming, fuzzy  |
| **Scalability**         | Single file DB                        | Sharded, replicated, cloud-native                  | Unlimited scale                       |
| **Observability**       | None                                  | Collection stats, index stats, profiler            | Full operational visibility           |

---

## 7. File Summary

### New Files (5)

| File                                 | Lines (est.) | Purpose                                         |
| ------------------------------------ | ------------ | ----------------------------------------------- |
| `src/memory/mongodb-manager.ts`      | ~300         | Main class, MemorySearchManager implementation  |
| `src/memory/mongodb-schema.ts`       | ~250         | Collections, indexes, capability detection      |
| `src/memory/mongodb-search.ts`       | ~400         | Vector, keyword, hybrid search pipelines        |
| `src/memory/mongodb-sync.ts`         | ~500         | File sync, chunk upsert, embedding coordination |
| `src/memory/mongodb-manager.test.ts` | ~300         | Tests                                           |

### Modified Files (4)

| File                           | Change Size | What                                    |
| ------------------------------ | ----------- | --------------------------------------- |
| `src/config/types.memory.ts`   | ~20 lines   | Add "mongodb" union + config type       |
| `src/memory/types.ts`          | ~1 line     | Add "mongodb" to backend union          |
| `src/memory/backend-config.ts` | ~25 lines   | Add resolved config + resolution branch |
| `src/memory/search-manager.ts` | ~5 lines    | Add factory branch                      |

### Reused (not modified)

| File                          | What We Reuse                                                              |
| ----------------------------- | -------------------------------------------------------------------------- |
| `src/memory/internal.ts`      | `chunkMarkdown()`, `hashText()`, `listMemoryFiles()`, `cosineSimilarity()` |
| `src/memory/hybrid.ts`        | `mergeHybridResults()` (JS fallback only)                                  |
| `src/memory/embeddings.ts`    | `createEmbeddingProvider()` (managed mode only)                            |
| `src/memory/session-files.ts` | Session transcript listing                                                 |

---

## 8. Patterns Ported from ClawMongo v1

| v1 Pattern                                         | Adapted For v2                               | Key Change                               |
| -------------------------------------------------- | -------------------------------------------- | ---------------------------------------- |
| `AdaptiveFusionRetriever` with `$rankFusion` probe | Hybrid search with `$scoreFusion` as primary | Upgrade from $rankFusion to $scoreFusion |
| `MongoVectorRetriever` native + fallback           | `vectorSearch()` in mongodb-search.ts        | Adapt to MemorySearchResult type         |
| `MongoLexicalRetriever` native + fallback          | `keywordSearch()` in mongodb-search.ts       | Adapt to MemorySearchResult type         |
| Deployment profiles (3 tiers)                      | 4 deployment profiles                        | Add community-mongot tier                |
| `tryNativeFusionProbe()`                           | `detectCapabilities()`                       | Expand to probe all features             |
| `ensureCoreIndexes()` + budget check               | `ensureSearchIndexes()` + budget check       | Add autoEmbed support                    |
| `normalizeScopeFilter()`, `cosineSimilarity()`     | Reused directly or adapted                   | Minimal changes                          |

---

## 9. Risk Mitigation

| Risk                                            | Mitigation                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| Automated Embedding is "Public Preview"         | Default to automated but detect at startup; fall back to managed if autoEmbed fails  |
| $scoreFusion requires 8.2+                      | Detect version at connect; fall back to $rankFusion (8.0+) then JS merge             |
| mongodb-memory-server can't test search indexes | Mock search paths in unit tests; integration tests against real Atlas                |
| Community mongot setup is complex               | Provide clear error messages; detect mongot presence via probe                       |
| Atlas M0 index budget (3 max)                   | Budget checker prevents creation; combine text+vector into fewer indexes if needed   |
| OpenClaw upstream changes to modified files     | Only 4 files modified; changes are additive (new union members, new config branches) |

---

## 10. Success Criteria

- [ ] `"memory": { "backend": "mongodb" }` in config boots OpenClaw with MongoDB
- [ ] Collections created with correct schema and indexes
- [ ] Memory files synced (chunked, embedded, indexed)
- [ ] `memory_search` returns relevant results via $scoreFusion hybrid
- [ ] `memory_get` reads files from disk correctly
- [ ] `memory status` shows MongoDB diagnostics
- [ ] Works on Atlas M10+, Atlas M0, Community+mongot, Community bare
- [ ] Automated embedding mode eliminates external embedding calls
- [ ] All existing OpenClaw tests still pass
- [ ] New tests cover MongoDB-specific paths
