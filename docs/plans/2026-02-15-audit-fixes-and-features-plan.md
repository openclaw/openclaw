# Audit Fixes, New Features, and Discussion Update Plan

> **For Claude:** REQUIRED: Follow this plan task-by-task using TDD.
> **Research:** See `docs/research/2026-02-15-change-streams-ttl-analytics-research.md`

**Goal:** Complete remaining MongoDB audit fixes, implement Change Streams for real-time sync, TTL indexes for auto-expiry, aggregation analytics for stats, and update Discussion #16586 with transaction news and E2E results.

**Architecture:** Additive changes to existing mongodb-schema.ts, mongodb-sync.ts, mongodb-manager.ts, backend-config.ts, and types.memory.ts. New file for Change Streams watcher, new file for analytics aggregation. All changes are opt-in configuration, never modify default backend behavior.

**Tech Stack:** MongoDB 8.2+ (Community), Node.js mongodb driver, vitest, chokidar (existing), TypeScript

**Prerequisites:**

- 215 tests passing (190 unit + 25 E2E)
- Docker MongoDB 8.2 Community replica set on port 27018
- Transactions fully implemented with withTransaction() wrappers
- Branch: `feat/mongodb-memory-backend`

---

## Relevant Codebase Files

### Patterns to Follow

- `src/memory/mongodb-sync.ts` (lines 150-234) - Transaction wrapper pattern (syncFileAtomically)
- `src/memory/mongodb-manager.ts` (lines 422-464) - File watcher pattern (chokidar ensureWatcher/scheduleWatchSync)
- `src/memory/mongodb-schema.ts` (lines 77-105) - Standard index creation pattern (ensureStandardIndexes)
- `src/memory/mongodb-schema.ts` (lines 111-221) - Search index creation pattern
- `src/memory/mongodb-search.ts` (lines 409-550) - Search dispatcher cascade
- `src/memory/backend-config.ts` (lines 271-305) - MongoDB config resolution pattern
- `src/config/types.memory.ts` (lines 15-32) - MemoryMongoDBConfig type definition

### Configuration Files

- `src/config/types.memory.ts` - All MongoDB config types
- `src/memory/backend-config.ts` - Config resolution with defaults and validation

### Test Files

- `src/memory/mongodb-sync.test.ts` - Unit test pattern with mocked collections
- `src/memory/mongodb-schema.test.ts` - Schema/index unit tests
- `src/memory/mongodb-e2e.e2e.test.ts` - E2E tests against real MongoDB

---

## Phase 1: Remaining Audit Fixes (Priority: HIGH)

> **Exit Criteria:** All MEDIUM audit findings fixed, all LOW findings addressed or explicitly deferred, 215+ tests passing, TSC clean.

### Task 1.1: Configurable numDimensions for Vector Index [MEDIUM]

**Problem:** `mongodb-schema.ts:195` hardcodes `numDimensions: 1536`. Voyage-4-large uses 1024, not 1536. Other providers use different dimensions (e.g., OpenAI text-embedding-3-small = 1536, Cohere = 1024, Nomic = 768).

**Files:**

- Modify: `src/config/types.memory.ts` (add `numDimensions` to MemoryMongoDBConfig)
- Modify: `src/memory/backend-config.ts` (resolve numDimensions with default)
- Modify: `src/memory/mongodb-schema.ts:195` (use passed numDimensions instead of hardcoded 1536)
- Modify: `src/memory/mongodb-manager.ts` (pass numDimensions to ensureSearchIndexes)
- Test: `src/memory/mongodb-schema.test.ts` (add test for custom numDimensions)
- Test: `src/memory/backend-config.test.ts` (add test for numDimensions resolution)

**Step 1: Write failing test for schema**

In `mongodb-schema.test.ts`, add a test that verifies `ensureSearchIndexes` passes the correct numDimensions to the search index definition.

```typescript
it("uses custom numDimensions in vector index", async () => {
  const chunks = createMockCol();
  vi.mocked(chunksCollection).mockReturnValue(chunks);

  await ensureSearchIndexes(db, "test_", "atlas-default", "managed", "none", 1024);

  const call = chunks.createSearchIndex.mock.calls.find(
    (c: unknown[]) => (c[0] as { type: string }).type === "vectorSearch",
  );
  expect(call).toBeDefined();
  const def = (call![0] as { definition: { fields: Array<{ numDimensions?: number }> } })
    .definition;
  const vectorField = def.fields.find((f: { type: string }) => f.type === "vector");
  expect(vectorField?.numDimensions).toBe(1024);
});
```

**Step 2: Run test, verify fails**

Run: `npx vitest run src/memory/mongodb-schema.test.ts`
Expected: FAIL (ensureSearchIndexes does not accept numDimensions parameter)

**Step 3: Add numDimensions to types**

In `src/config/types.memory.ts`, add to `MemoryMongoDBConfig`:

```typescript
/** Number of dimensions for vector embeddings. Default: 1024 (Voyage-4-large) */
numDimensions?: number;
```

**Step 4: Resolve in backend-config.ts**

Add to `ResolvedMongoDBConfig`:

```typescript
numDimensions: number;
```

In `resolveMemoryBackendConfig`, add resolution:

```typescript
numDimensions:
  typeof mongoCfg?.numDimensions === "number" &&
  Number.isFinite(mongoCfg.numDimensions) &&
  mongoCfg.numDimensions > 0
    ? Math.floor(mongoCfg.numDimensions)
    : 1024,
```

**Step 5: Update ensureSearchIndexes signature**

In `mongodb-schema.ts`, add `numDimensions` parameter (default 1024):

```typescript
export async function ensureSearchIndexes(
  db: Db,
  prefix: string,
  profile: MemoryMongoDBDeploymentProfile,
  embeddingMode: MemoryMongoDBEmbeddingMode,
  quantization: "none" | "scalar" | "binary" = "none",
  numDimensions: number = 1024,
): Promise<{ text: boolean; vector: boolean }> {
```

Replace hardcoded `1536` on line 195 with `numDimensions`.

**Step 6: Update mongodb-manager.ts**

In the `create()` factory, pass numDimensions:

```typescript
await ensureSearchIndexes(
  db,
  prefix,
  mongoCfg.deploymentProfile,
  mongoCfg.embeddingMode,
  mongoCfg.quantization,
  mongoCfg.numDimensions,
);
```

**Step 7: Run tests, verify passes**

Run: `npx vitest run src/memory/mongodb-schema.test.ts src/memory/backend-config.test.ts`
Expected: PASS

**Step 8: Run full suite**

Run: `npx vitest run src/memory/`
Expected: All 190+ tests pass, 0 regressions

**Step 9: Commit**

```bash
git add src/config/types.memory.ts src/memory/backend-config.ts src/memory/mongodb-schema.ts src/memory/mongodb-manager.ts src/memory/mongodb-schema.test.ts src/memory/backend-config.test.ts
git commit -m "fix: make vector index numDimensions configurable (was hardcoded 1536)"
```

---

### Task 1.2: Fix \_id Type Casting Fragility [MEDIUM]

**Problem:** `mongodb-sync.ts` uses `as unknown as ObjectId` pattern in 4 places (lines 60, 107, 403, 606). Our `_id` is a string (path-based), not ObjectId. The casting works but is fragile and misleading.

**Files:**

- Modify: `src/memory/mongodb-sync.ts` (lines 60, 107, 403, 606 - use proper filter typing)
- Test: `src/memory/mongodb-sync.test.ts` (verify string \_id works correctly)

**Step 1: Write test verifying string \_id filter works**

Add a test in `mongodb-sync.test.ts` that verifies `upsertFileMetadata` sends a string \_id in the filter, not an ObjectId.

**Step 2: Run test, verify fails (or passes if it's just a type fix)**

**Step 3: Replace type casting pattern**

In all 4 locations, replace:

```typescript
{
  _id: entry.path as unknown as Document["_id"];
}
```

with:

```typescript
{
  _id: entry.path;
}
```

This works because MongoDB accepts any type for `_id` including strings. The `Collection` generic can be typed or the filter can use a generic `Document` type. If TypeScript complains, use `as const` or extend the filter type:

```typescript
const filter: { _id: string } = { _id: entry.path };
```

Similarly for the stale cleanup (line 403):

```typescript
staleFileIds.push(storedPath);
```

And the deleteMany:

```typescript
await filesCol.deleteMany({ _id: { $in: staleFileIds } }, { session });
```

**Step 4: Run TSC**

Run: `npx tsc --noEmit`
Expected: 0 errors in src/memory/

**Step 5: Run tests**

Run: `npx vitest run src/memory/mongodb-sync.test.ts`
Expected: All pass

**Step 6: Commit**

```bash
git add src/memory/mongodb-sync.ts src/memory/mongodb-sync.test.ts
git commit -m "fix: remove fragile _id type casting (string _id, not ObjectId)"
```

---

### Task 1.3: Add maxPoolSize Config [LOW]

**Problem:** `mongodb-manager.ts:116` creates MongoClient with only timeout configs. No maxPoolSize setting, which matters for production deployments.

**Files:**

- Modify: `src/config/types.memory.ts` (add `maxPoolSize` to MemoryMongoDBConfig)
- Modify: `src/memory/backend-config.ts` (resolve with default 10)
- Modify: `src/memory/mongodb-manager.ts:116` (pass maxPoolSize to MongoClient options)
- Test: `src/memory/backend-config.test.ts` (test maxPoolSize resolution)

**Step 1: Add config option**

In `types.memory.ts`:

```typescript
/** Max connection pool size. Default: 10 */
maxPoolSize?: number;
```

In `backend-config.ts` ResolvedMongoDBConfig:

```typescript
maxPoolSize: number;
```

Resolution:

```typescript
maxPoolSize:
  typeof mongoCfg?.maxPoolSize === "number" &&
  Number.isFinite(mongoCfg.maxPoolSize) &&
  mongoCfg.maxPoolSize > 0
    ? Math.floor(mongoCfg.maxPoolSize)
    : 10,
```

**Step 2: Pass to MongoClient**

In `mongodb-manager.ts`, update the client constructor:

```typescript
const client = new MongoClient(mongoCfg.uri, {
  serverSelectionTimeoutMS: 10_000,
  connectTimeoutMS: 10_000,
  maxPoolSize: mongoCfg.maxPoolSize,
});
```

**Step 3: Test and commit**

Run: `npx vitest run src/memory/backend-config.test.ts`
Run: `npx tsc --noEmit`

```bash
git add src/config/types.memory.ts src/memory/backend-config.ts src/memory/mongodb-manager.ts src/memory/backend-config.test.ts
git commit -m "feat: add maxPoolSize config for MongoDB connection pool"
```

---

### Task 1.4: Improve automatedEmbedding Capability Detection [LOW]

**Problem:** `mongodb-schema.ts:342` sets `automatedEmbedding = result.vectorSearch`, which is imprecise. Not all vectorSearch-capable deployments support autoEmbed.

**Files:**

- Modify: `src/memory/mongodb-schema.ts:340-342` (try creating a dummy autoEmbed index to detect)

**Decision:** DEFER to Phase 4. The current behavior is safe because automated embedding is only used when the user explicitly configures `embeddingMode: "automated"`. If autoEmbed is not supported, the search index creation will fail gracefully (existing error handling in ensureSearchIndexes catches this). Adding a probe here would add a slow index creation/deletion cycle on every startup. The risk is low.

---

### Task 1.5: Schema Validation [LOW]

**Decision:** DEFER to post-PR. MongoDB JSON Schema validation would add enforcement but our documents are consistently shaped by the sync code. This is defense-in-depth, not a correctness fix. Can be added as a separate enhancement PR.

---

## Phase 2: TTL Indexes for Auto-Expiry (Priority: MEDIUM)

> **Exit Criteria:** TTL index on embedding_cache with configurable `embeddingCacheTtlDays`. Optional TTL on files collection via `memoryTtlDays`. 220+ tests passing.

### Task 2.1: TTL Index on embedding_cache Collection

**Problem:** Stale embeddings accumulate forever in embedding_cache. Research confirms TTL indexes work on all MongoDB editions.

**Files:**

- Modify: `src/config/types.memory.ts` (add `embeddingCacheTtlDays`)
- Modify: `src/memory/backend-config.ts` (resolve with default 30)
- Modify: `src/memory/mongodb-schema.ts` (add TTL index in ensureStandardIndexes)
- Test: `src/memory/mongodb-schema.test.ts` (verify TTL index created)
- Test: `src/memory/backend-config.test.ts` (verify config resolution)

**Step 1: Write failing test**

```typescript
it("creates TTL index on embedding_cache when ttlDays is set", async () => {
  const cache = createMockCol();
  vi.mocked(embeddingCacheCollection).mockReturnValue(cache);

  await ensureStandardIndexes(db, "test_", { embeddingCacheTtlDays: 30 });

  // Find the TTL index call
  const ttlCall = cache.createIndex.mock.calls.find((c: unknown[]) => {
    const opts = c[1] as { expireAfterSeconds?: number };
    return opts?.expireAfterSeconds !== undefined;
  });
  expect(ttlCall).toBeDefined();
  expect(ttlCall![1]).toMatchObject({
    expireAfterSeconds: 30 * 24 * 60 * 60,
    name: "idx_cache_ttl",
  });
});
```

**Step 2: Run test, verify fails**

Run: `npx vitest run src/memory/mongodb-schema.test.ts`
Expected: FAIL

**Step 3: Add config types**

In `types.memory.ts` MemoryMongoDBConfig:

```typescript
/** TTL for cached embeddings in days. Default: 30. Set 0 to disable. */
embeddingCacheTtlDays?: number;
/** TTL for memory files in days. Default: 0 (disabled). WARNING: expired files are auto-deleted. */
memoryTtlDays?: number;
```

In `backend-config.ts` ResolvedMongoDBConfig:

```typescript
embeddingCacheTtlDays: number;
memoryTtlDays: number;
```

Resolution (following existing numeric validation pattern):

```typescript
embeddingCacheTtlDays:
  typeof mongoCfg?.embeddingCacheTtlDays === "number" &&
  Number.isFinite(mongoCfg.embeddingCacheTtlDays) &&
  mongoCfg.embeddingCacheTtlDays >= 0
    ? Math.floor(mongoCfg.embeddingCacheTtlDays)
    : 30,
memoryTtlDays:
  typeof mongoCfg?.memoryTtlDays === "number" &&
  Number.isFinite(mongoCfg.memoryTtlDays) &&
  mongoCfg.memoryTtlDays >= 0
    ? Math.floor(mongoCfg.memoryTtlDays)
    : 0,
```

**Step 4: Update ensureStandardIndexes**

Change signature to accept TTL options:

```typescript
export async function ensureStandardIndexes(
  db: Db,
  prefix: string,
  ttlOpts?: { embeddingCacheTtlDays?: number; memoryTtlDays?: number },
): Promise<number> {
```

After the existing embedding_cache indexes, add:

```typescript
// TTL index on embedding_cache for auto-expiry (per `index-ttl` rule)
// TTL indexes require a Date field. `updatedAt` is already indexed above.
// MongoDB's background thread checks every ~60 seconds for expired documents.
if (ttlOpts?.embeddingCacheTtlDays && ttlOpts.embeddingCacheTtlDays > 0) {
  const seconds = ttlOpts.embeddingCacheTtlDays * 24 * 60 * 60;
  await cache.createIndex({ updatedAt: 1 }, { name: "idx_cache_ttl", expireAfterSeconds: seconds });
  applied++;
  log.info(`created TTL index on embedding_cache: ${ttlOpts.embeddingCacheTtlDays} days`);
}
```

**IMPORTANT:** The existing `idx_cache_updated` index on `{ updatedAt: 1 }` will conflict with a TTL index on the same field. TTL index is also a regular index. We need to either:

- Drop idx_cache_updated and replace it with the TTL version (TTL indexes work as regular indexes too)
- OR use a different field name for TTL

Best approach: When TTL is configured, skip creating `idx_cache_updated` and use the TTL index instead (which also supports queries on `updatedAt`). When TTL is 0/disabled, create the regular index as before.

**Step 5: Update mongodb-manager.ts create()**

Pass TTL config to ensureStandardIndexes:

```typescript
await ensureStandardIndexes(db, prefix, {
  embeddingCacheTtlDays: mongoCfg.embeddingCacheTtlDays,
  memoryTtlDays: mongoCfg.memoryTtlDays,
});
```

**Step 6: Run tests**

Run: `npx vitest run src/memory/mongodb-schema.test.ts src/memory/backend-config.test.ts`
Expected: All pass

**Step 7: Commit**

```bash
git add src/config/types.memory.ts src/memory/backend-config.ts src/memory/mongodb-schema.ts src/memory/mongodb-manager.ts src/memory/mongodb-schema.test.ts src/memory/backend-config.test.ts
git commit -m "feat: add TTL indexes for embedding cache auto-expiry"
```

---

### Task 2.2: Optional TTL on Files Collection

**Purpose:** Allow users to auto-expire old memory files via `memoryTtlDays` config. Dangerous (deletes data), so disabled by default.

**Files:**

- Same files as Task 2.1 (already added config types)
- Modify: `src/memory/mongodb-schema.ts` (add conditional TTL on files collection)

**Implementation:**

In ensureStandardIndexes, after files indexes:

```typescript
// Optional TTL on files for memory auto-expiry
// WARNING: This deletes memory files from MongoDB after ttlDays
if (ttlOpts?.memoryTtlDays && ttlOpts.memoryTtlDays > 0) {
  const files = filesCollection(db, prefix);
  const seconds = ttlOpts.memoryTtlDays * 24 * 60 * 60;
  await files.createIndex({ updatedAt: 1 }, { name: "idx_files_ttl", expireAfterSeconds: seconds });
  applied++;
  log.warn(
    `created TTL index on files: ${ttlOpts.memoryTtlDays} days — old memory files will be auto-deleted`,
  );
}
```

Note: The files collection currently stores `updatedAt` as a Date field (set in `upsertFileMetadata` at mongodb-sync.ts:57). This is required for TTL to work.

**Test and commit with Task 2.1 above.**

---

### Task 2.3: E2E TTL Test

**Files:**

- Modify: `src/memory/mongodb-e2e.e2e.test.ts` (add TTL index E2E test)

**Step 1: Add E2E test**

```typescript
describe("E2E: TTL Indexes", () => {
  it("creates TTL index on embedding_cache", async () => {
    await ensureStandardIndexes(db, TEST_PREFIX, { embeddingCacheTtlDays: 7 });

    const cache = embeddingCacheCollection(db, TEST_PREFIX);
    const indexes = await cache.indexes();
    const ttlIndex = indexes.find((idx) => idx.name === "idx_cache_ttl");

    expect(ttlIndex).toBeDefined();
    expect(ttlIndex!.expireAfterSeconds).toBe(7 * 24 * 60 * 60);
  });

  it("skips TTL index when ttlDays is 0", async () => {
    // Drop and recreate to test from clean state
    await db.dropCollection(`${TEST_PREFIX}embedding_cache`).catch(() => {});
    await ensureCollections(db, TEST_PREFIX);

    await ensureStandardIndexes(db, TEST_PREFIX, { embeddingCacheTtlDays: 0 });

    const cache = embeddingCacheCollection(db, TEST_PREFIX);
    const indexes = await cache.indexes();
    const ttlIndex = indexes.find((idx) => idx.name === "idx_cache_ttl");
    expect(ttlIndex).toBeUndefined();
  });
});
```

**Step 2: Run E2E**

Run: `MONGODB_TEST_URI=mongodb://localhost:27018/?replicaSet=rs0 npx vitest run src/memory/mongodb-e2e.e2e.test.ts`
Expected: All pass including new TTL tests

**Step 3: Commit**

```bash
git add src/memory/mongodb-e2e.e2e.test.ts
git commit -m "test: add E2E tests for TTL index creation"
```

---

## Phase 3: Aggregation Analytics (Priority: MEDIUM)

> **Exit Criteria:** `getMemoryStats()` function returns per-source breakdown, embedding coverage, stale detection. Unit + E2E tests passing. 225+ tests total.

### Task 3.1: Create Analytics Module

**Files:**

- Create: `src/memory/mongodb-analytics.ts`
- Create: `src/memory/mongodb-analytics.test.ts`

**Step 1: Define the stats type and function**

```typescript
// src/memory/mongodb-analytics.ts
import type { Db, Document } from "mongodb";
import { chunksCollection, filesCollection, embeddingCacheCollection } from "./mongodb-schema.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory:mongodb:analytics");

export type MemorySourceStats = {
  source: string;
  fileCount: number;
  chunkCount: number;
  lastSync: Date | null;
};

export type EmbeddingCoverage = {
  withEmbedding: number;
  withoutEmbedding: number;
  total: number;
  coveragePercent: number;
};

export type MemoryStats = {
  sources: MemorySourceStats[];
  totalFiles: number;
  totalChunks: number;
  embeddingCoverage: EmbeddingCoverage;
  cachedEmbeddings: number;
  staleFiles: string[]; // files in DB but not matched by validPaths
  collectionSizes: {
    files: number;
    chunks: number;
    embeddingCache: number;
  };
};

export async function getMemoryStats(
  db: Db,
  prefix: string,
  validPaths?: Set<string>,
): Promise<MemoryStats> {
  const chunksCol = chunksCollection(db, prefix);
  const filesCol = filesCollection(db, prefix);
  const cacheCol = embeddingCacheCollection(db, prefix);

  // Per-source file breakdown
  const sourceAgg: Document[] = await filesCol
    .aggregate([
      {
        $group: {
          _id: "$source",
          count: { $sum: 1 },
          lastSync: { $max: "$updatedAt" },
        },
      },
    ])
    .toArray();

  const sources: MemorySourceStats[] = sourceAgg.map((doc) => ({
    source: String(doc._id ?? "unknown"),
    fileCount: doc.count as number,
    chunkCount: 0, // filled below
    lastSync: doc.lastSync instanceof Date ? doc.lastSync : null,
  }));

  // Per-source chunk counts
  const chunkSourceAgg: Document[] = await chunksCol
    .aggregate([{ $group: { _id: "$source", count: { $sum: 1 } } }])
    .toArray();

  for (const doc of chunkSourceAgg) {
    const src = sources.find((s) => s.source === String(doc._id));
    if (src) {
      src.chunkCount = doc.count as number;
    }
  }

  // Embedding coverage
  const embeddingAgg: Document[] = await chunksCol
    .aggregate([
      {
        $group: {
          _id: null,
          withEmbedding: {
            $sum: {
              $cond: [{ $gt: [{ $size: { $ifNull: ["$embedding", []] } }, 0] }, 1, 0],
            },
          },
          total: { $sum: 1 },
        },
      },
    ])
    .toArray();

  const embRow = embeddingAgg[0] ?? { withEmbedding: 0, total: 0 };
  const withEmb = embRow.withEmbedding as number;
  const totalChunks = embRow.total as number;
  const embeddingCoverage: EmbeddingCoverage = {
    withEmbedding: withEmb,
    withoutEmbedding: totalChunks - withEmb,
    total: totalChunks,
    coveragePercent: totalChunks > 0 ? Math.round((withEmb / totalChunks) * 100) : 0,
  };

  // Cached embeddings count
  const cachedEmbeddings = await cacheCol.countDocuments();

  // Stale files (in DB but not on disk)
  let staleFiles: string[] = [];
  if (validPaths) {
    const allDbPaths = await filesCol.distinct("_id");
    staleFiles = allDbPaths.map(String).filter((p) => !validPaths.has(p));
  }

  // Collection document counts (as proxy for size)
  const totalFiles = await filesCol.countDocuments();

  log.info(
    `stats: files=${totalFiles} chunks=${totalChunks} cached=${cachedEmbeddings} stale=${staleFiles.length}`,
  );

  return {
    sources,
    totalFiles,
    totalChunks,
    embeddingCoverage,
    cachedEmbeddings,
    staleFiles,
    collectionSizes: {
      files: totalFiles,
      chunks: totalChunks,
      embeddingCache: cachedEmbeddings,
    },
  };
}
```

**Step 2: Write unit tests**

```typescript
// src/memory/mongodb-analytics.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./mongodb-schema.js", () => ({
  chunksCollection: vi.fn(),
  filesCollection: vi.fn(),
  embeddingCacheCollection: vi.fn(),
}));

import { chunksCollection, filesCollection, embeddingCacheCollection } from "./mongodb-schema.js";
import { getMemoryStats } from "./mongodb-analytics.js";

// ... create mock collections with aggregate().toArray(), distinct(), countDocuments()
// Test cases:
// 1. Empty collections return zero stats
// 2. Per-source breakdown with memory + sessions
// 3. Embedding coverage calculation
// 4. Stale file detection with validPaths
// 5. Stats with no validPaths (skip stale detection)
```

Target: 5-8 unit tests.

**Step 3: Run tests**

Run: `npx vitest run src/memory/mongodb-analytics.test.ts`
Expected: All pass

**Step 4: Commit**

```bash
git add src/memory/mongodb-analytics.ts src/memory/mongodb-analytics.test.ts
git commit -m "feat: add aggregation analytics for memory stats"
```

---

### Task 3.2: Wire Analytics into Manager

**Files:**

- Modify: `src/memory/mongodb-manager.ts` (add `stats()` method)

**Implementation:**

Add public method to MongoDBMemoryManager:

```typescript
async stats(): Promise<MemoryStats> {
  const { getMemoryStats } = await import("./mongodb-analytics.js");
  const validPaths = new Set<string>();
  // Gather current disk paths for stale detection
  const { listMemoryFiles } = await import("./internal.js");
  const diskPaths = await listMemoryFiles(this.workspaceDir, this.extraPaths);
  for (const p of diskPaths) {
    const relPath = path.relative(this.workspaceDir, p).replace(/\\/g, "/");
    validPaths.add(relPath);
  }
  return getMemoryStats(this.db, this.prefix, validPaths);
}
```

Note: This method is not part of the MemorySearchManager interface (which would require upstream changes). It's an extension method on MongoDBMemoryManager specifically.

**Step 5: Commit**

```bash
git add src/memory/mongodb-manager.ts
git commit -m "feat: wire memory stats into MongoDBMemoryManager"
```

---

### Task 3.3: E2E Analytics Test

**Files:**

- Modify: `src/memory/mongodb-e2e.e2e.test.ts`

**Add E2E test:**

```typescript
describe("E2E: Aggregation Analytics", () => {
  let statsWorkspace: string;

  beforeAll(async () => {
    await chunksCollection(db, TEST_PREFIX).deleteMany({});
    await filesCollection(db, TEST_PREFIX).deleteMany({});

    statsWorkspace = await setupWorkspace({
      "stats-test.md": "# Stats Test\n\nContent for analytics verification.",
    });

    await syncToMongoDB({
      db,
      prefix: TEST_PREFIX,
      workspaceDir: statsWorkspace,
      embeddingMode: "automated",
      force: true,
    });
  });

  afterAll(async () => {
    if (statsWorkspace) {
      await fs.rm(statsWorkspace, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("returns per-source breakdown", async () => {
    const { getMemoryStats } = await import("./mongodb-analytics.js");
    const stats = await getMemoryStats(db, TEST_PREFIX);

    expect(stats.totalFiles).toBeGreaterThan(0);
    expect(stats.totalChunks).toBeGreaterThan(0);
    expect(stats.sources.length).toBeGreaterThan(0);

    const memorySrc = stats.sources.find((s) => s.source === "memory");
    expect(memorySrc).toBeDefined();
    expect(memorySrc!.fileCount).toBeGreaterThan(0);
  });

  it("detects stale files", async () => {
    const { getMemoryStats } = await import("./mongodb-analytics.js");
    // Pass empty validPaths to make all DB entries "stale"
    const stats = await getMemoryStats(db, TEST_PREFIX, new Set());

    expect(stats.staleFiles.length).toBeGreaterThan(0);
  });
});
```

**Run and commit:**

Run: `MONGODB_TEST_URI=mongodb://localhost:27018/?replicaSet=rs0 npx vitest run src/memory/mongodb-e2e.e2e.test.ts`

```bash
git add src/memory/mongodb-e2e.e2e.test.ts
git commit -m "test: add E2E tests for aggregation analytics"
```

---

## Phase 4: Change Streams for Real-Time Sync (Priority: MEDIUM-HIGH)

> **Exit Criteria:** `MongoDBChangeStreamWatcher` class that watches files + chunks collections, notifies manager on external changes, resumes after disconnect. Opt-in via config. 230+ tests total.

### Task 4.1: Create Change Stream Watcher Module

**Files:**

- Create: `src/memory/mongodb-change-stream.ts`
- Create: `src/memory/mongodb-change-stream.test.ts`

**Design Decisions:**

- Opt-in via `memory.mongodb.enableChangeStreams: boolean` (default: false)
- Watch `files` collection for insert/update/delete from OTHER instances
- Persist resumeToken in `meta` collection for reconnection
- Graceful degradation: standalone (no replica set) logs warning and disables
- Configurable `changeStreamDebounceMs` (default: 1000) to batch rapid changes

**Step 1: Write the module**

```typescript
// src/memory/mongodb-change-stream.ts
import type {
  ChangeStream,
  ChangeStreamDocument,
  Collection,
  Db,
  Document,
  MongoClient,
  ResumeToken,
} from "mongodb";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { filesCollection, metaCollection } from "./mongodb-schema.js";

const log = createSubsystemLogger("memory:mongodb:changestream");

export type ChangeStreamEvent = {
  type: "insert" | "update" | "replace" | "delete";
  path: string;
  source?: string;
};

export type OnChangeCallback = (events: ChangeStreamEvent[]) => void;

export class MongoDBChangeStreamWatcher {
  private stream: ChangeStream | null = null;
  private resumeToken: ResumeToken | null = null;
  private closed = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingEvents: ChangeStreamEvent[] = [];

  constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    private readonly prefix: string,
    private readonly debounceMs: number,
    private readonly onChange: OnChangeCallback,
  ) {}

  async start(): Promise<boolean> {
    if (this.closed) return false;

    // Load persisted resume token
    const meta = metaCollection(this.db, this.prefix);
    try {
      const tokenDoc = await meta.findOne({
        _id: "changestream_resume_token" as unknown as Document["_id"],
      });
      if (tokenDoc?.token) {
        this.resumeToken = tokenDoc.token as ResumeToken;
      }
    } catch {
      // No saved token, start from now
    }

    // Watch the files collection
    const filesCol = filesCollection(this.db, this.prefix);
    try {
      const opts: Document = { fullDocument: "updateLookup" };
      if (this.resumeToken) {
        opts.resumeAfter = this.resumeToken;
      }
      this.stream = filesCol.watch(
        [{ $match: { operationType: { $in: ["insert", "update", "replace", "delete"] } } }],
        opts,
      );

      this.stream.on("change", (event: ChangeStreamDocument) => {
        this.handleEvent(event);
      });

      this.stream.on("error", (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`change stream error: ${msg}`);
        // Attempt restart after delay
        if (!this.closed) {
          setTimeout(() => void this.start(), 5000);
        }
      });

      log.info("change stream started");
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not supported") || msg.includes("replica set")) {
        log.info("change streams not available (standalone topology)");
        return false;
      }
      log.warn(`change stream start failed: ${msg}`);
      return false;
    }
  }

  private handleEvent(event: ChangeStreamDocument): void {
    // Save resume token
    if (event._id) {
      this.resumeToken = event._id;
      void this.persistResumeToken(event._id);
    }

    const csEvent: ChangeStreamEvent = {
      type: event.operationType as ChangeStreamEvent["type"],
      path: String((event as Document).documentKey?._id ?? ""),
      source: (event as Document).fullDocument?.source,
    };

    this.pendingEvents.push(csEvent);

    // Debounce to batch rapid changes
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      const batch = [...this.pendingEvents];
      this.pendingEvents = [];
      this.onChange(batch);
    }, this.debounceMs);
  }

  private async persistResumeToken(token: ResumeToken): Promise<void> {
    try {
      const meta = metaCollection(this.db, this.prefix);
      await meta.updateOne(
        { _id: "changestream_resume_token" as unknown as Document["_id"] },
        { $set: { token, updatedAt: new Date() } },
        { upsert: true },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`failed to persist resume token: ${msg}`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.stream) {
      try {
        await this.stream.close();
      } catch {
        // Ignore close errors
      }
      this.stream = null;
    }
  }
}
```

**Step 2: Write unit tests**

Test with mocked collection.watch():

1. Start returns true when watch succeeds
2. Start returns false on standalone (no replica set error)
3. Events are debounced and batched
4. Resume token is persisted to meta collection
5. Close stops the stream and clears timer
6. Error handler attempts restart
7. Handles delete events (no fullDocument)

Target: 7-10 unit tests.

**Step 3: Run tests**

Run: `npx vitest run src/memory/mongodb-change-stream.test.ts`
Expected: All pass

**Step 4: Commit**

```bash
git add src/memory/mongodb-change-stream.ts src/memory/mongodb-change-stream.test.ts
git commit -m "feat: add Change Stream watcher for real-time cross-instance sync"
```

---

### Task 4.2: Wire Change Streams into Manager

**Files:**

- Modify: `src/config/types.memory.ts` (add `enableChangeStreams`, `changeStreamDebounceMs`)
- Modify: `src/memory/backend-config.ts` (resolve new config options)
- Modify: `src/memory/mongodb-manager.ts` (start change stream watcher, handle events)

**Config additions:**

In `types.memory.ts`:

```typescript
/** Enable Change Streams for real-time cross-instance sync. Default: false. Requires replica set. */
enableChangeStreams?: boolean;
/** Debounce for batching change stream events in ms. Default: 1000 */
changeStreamDebounceMs?: number;
```

In `backend-config.ts` ResolvedMongoDBConfig:

```typescript
enableChangeStreams: boolean;
changeStreamDebounceMs: number;
```

Resolution:

```typescript
enableChangeStreams: mongoCfg?.enableChangeStreams === true,
changeStreamDebounceMs:
  typeof mongoCfg?.changeStreamDebounceMs === "number" &&
  Number.isFinite(mongoCfg.changeStreamDebounceMs) &&
  mongoCfg.changeStreamDebounceMs >= 0
    ? Math.floor(mongoCfg.changeStreamDebounceMs)
    : 1000,
```

**Manager integration:**

In `mongodb-manager.ts`, add:

```typescript
private changeStreamWatcher: MongoDBChangeStreamWatcher | null = null;
```

In `create()`, after ensureWatcher():

```typescript
// Start change stream watcher for cross-instance sync (opt-in)
if (mongoCfg.enableChangeStreams) {
  const { MongoDBChangeStreamWatcher } = await import("./mongodb-change-stream.js");
  manager.changeStreamWatcher = new MongoDBChangeStreamWatcher(
    client,
    db,
    prefix,
    mongoCfg.changeStreamDebounceMs,
    (events) => {
      log.info(`change stream: ${events.length} event(s), triggering sync`);
      manager.dirty = true;
      void manager.sync({ reason: "changestream" }).catch((err) => {
        log.warn(`sync from change stream failed: ${String(err)}`);
      });
    },
  );
  const started = await manager.changeStreamWatcher.start();
  if (!started) {
    log.info("change streams unavailable, falling back to file watcher only");
    manager.changeStreamWatcher = null;
  }
}
```

In `close()`, before closing watcher:

```typescript
if (this.changeStreamWatcher) {
  try {
    await this.changeStreamWatcher.close();
  } catch {
    // Ignore close errors
  }
  this.changeStreamWatcher = null;
}
```

**Test and commit:**

Run: `npx vitest run src/memory/`
Expected: All pass

```bash
git add src/config/types.memory.ts src/memory/backend-config.ts src/memory/mongodb-manager.ts
git commit -m "feat: wire Change Streams into MongoDBMemoryManager (opt-in)"
```

---

### Task 4.3: E2E Change Stream Test

**Files:**

- Modify: `src/memory/mongodb-e2e.e2e.test.ts`

**Add E2E test:**

```typescript
describe("E2E: Change Streams", () => {
  it("watches files collection for changes", async () => {
    const events: ChangeStreamEvent[] = [];
    const { MongoDBChangeStreamWatcher } = await import("./mongodb-change-stream.js");

    const watcher = new MongoDBChangeStreamWatcher(client, db, TEST_PREFIX, 200, (batch) =>
      events.push(...batch),
    );

    const started = await watcher.start();
    expect(started).toBe(true); // We have replica set

    // Insert a document to trigger change event
    const filesCol = filesCollection(db, TEST_PREFIX);
    await filesCol.insertOne({
      _id: "cs-test/file.md" as unknown as import("mongodb").ObjectId,
      source: "memory",
      hash: "abc123",
      updatedAt: new Date(),
    });

    // Wait for debounce
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe("insert");
    expect(events[0].path).toBe("cs-test/file.md");

    await watcher.close();

    // Cleanup
    await filesCol.deleteOne({ _id: "cs-test/file.md" as unknown as import("mongodb").ObjectId });
  });

  it("persists resume token to meta collection", async () => {
    const { MongoDBChangeStreamWatcher } = await import("./mongodb-change-stream.js");

    const watcher = new MongoDBChangeStreamWatcher(client, db, TEST_PREFIX, 200, () => {});

    await watcher.start();

    // Trigger a change to generate a resume token
    const filesCol = filesCollection(db, TEST_PREFIX);
    await filesCol.insertOne({
      _id: "cs-token-test/file.md" as unknown as import("mongodb").ObjectId,
      source: "memory",
      updatedAt: new Date(),
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    // Check resume token was persisted
    const meta = metaCollection(db, TEST_PREFIX);
    const tokenDoc = await meta.findOne({
      _id: "changestream_resume_token" as unknown as import("mongodb").ObjectId,
    });
    expect(tokenDoc).not.toBeNull();
    expect(tokenDoc!.token).toBeDefined();

    await watcher.close();

    // Cleanup
    await filesCol.deleteOne({
      _id: "cs-token-test/file.md" as unknown as import("mongodb").ObjectId,
    });
  });
});
```

**Run and commit:**

```bash
git add src/memory/mongodb-e2e.e2e.test.ts
git commit -m "test: add E2E tests for Change Streams"
```

---

## Phase 5: Discussion #16586 Update (Priority: HIGH — Community Engagement)

> **Exit Criteria:** Discussion updated with transaction implementation news, real E2E test results, and roadmap. No code changes needed.

### Task 5.1: Draft Discussion Update

**Content for Discussion #16586 update comment:**

The update should include:

**1. Transaction Implementation News:**

- withTransaction() wrappers added to ALL sync operations (memory files, session files, stale cleanup)
- Uses MongoDB callback API for automatic TransientTransactionError retry
- Graceful fallback for standalone topology (no replica set)
- Session propagated to every operation inside transaction body
- writeConcern: "majority" for durability
- I/O and embedding generation kept OUTSIDE transaction body (per ops-transaction-runtime-limit)

**2. Real E2E Test Results:**

- 190 unit tests + 25 E2E tests = 215 total, ALL PASSING
- E2E tests run against Docker MongoDB 8.2 Community with replica set
- 4 transaction-specific E2E tests:
  - syncToMongoDB uses transactions when client is provided on replica set
  - Transaction commit is atomic (all-or-nothing per file)
  - Stale file cleanup works transactionally
  - withTransaction retries on transient errors
- Tests verify: collections, indexes, sync workflow, hash-based skip, re-index, stale cleanup, $text search, search dispatcher cascade, chunk deduplication

**3. Roadmap (what's next):**

- Change Streams for real-time cross-instance sync (opt-in, requires replica set)
- TTL indexes for embedding cache auto-expiry
- Aggregation analytics for `openclaw memory stats`
- Staged PRs still planned: Core (PR1) -> DX (PR2) -> Docs (PR3)

**Draft comment:**

```markdown
## Update: Transaction Implementation + Real E2E Results

### Transactions ✓

All sync operations now use `withTransaction()` for ACID atomicity:

- **Memory file sync**: delete old chunks + upsert new + update metadata — atomic per file
- **Session file sync**: same atomic pattern for session transcripts
- **Stale cleanup**: delete orphaned chunks + file entries — atomic batch

Implementation details:

- Uses `session.withTransaction()` callback API (automatic `TransientTransactionError` / `UnknownTransactionCommitResult` retry)
- `writeConcern: { w: "majority" }` for durability
- I/O and embedding generation happen OUTSIDE the transaction body to keep transactions short
- Graceful fallback for standalone topology: detects error code 20, falls back to direct writes

### E2E Test Results (MongoDB 8.2 Community, replica set)

**215 tests total, ALL PASSING:**

- 190 unit tests (mocked) — schema, search, sync, config, watcher
- 25 E2E tests (real MongoDB) — collections, indexes, sync workflow, transactions, search

E2E test highlights against real MongoDB 8.2 Community:

- Collections created correctly
- Standard indexes + $text index applied
- Search index creation fails gracefully on Community without mongot (expected)
- Full sync workflow: hash-based skip, file change detection, force re-index, stale cleanup
- **4 transaction E2E tests**: ACID sync verified, atomic replacement, stale cleanup, retry
- $text search fallback works as last-resort for Community without mongot
- Search dispatcher cascade: $scoreFusion -> $rankFusion -> JS merge -> vector-only -> keyword-only -> $text
- Chunk ID dedup verified (re-sync doesn't create duplicates)

### Architecture Highlights

- **Additive**: Zero modifications to existing builtin/QMD code
- **Opt-in**: MongoDB backend only activates when explicitly configured
- **Profiles**: atlas-default, atlas-m0, community-mongot, community-bare
- **Search cascade**: Automatically selects best available search strategy
- **DX**: Onboarding wizard, configure wizard, doctor health check

### Roadmap

1. **Change Streams** (in progress) — real-time cross-instance sync, opt-in
2. **TTL Indexes** (in progress) — auto-expire stale embeddings
3. **Aggregation Analytics** — `openclaw memory stats` command
4. **Staged PRs** — Core (PR1) -> DX (PR2) -> Docs (PR3)

Happy to discuss implementation details or answer questions. The full branch is at `feat/mongodb-memory-backend`.
```

### Task 5.2: Post the Update

**Command to post:**

```bash
gh api repos/openclaw/openclaw/discussions/16586/comments \
  --method POST \
  -f body="$(cat docs/discussion-update-16586.md)"
```

Note: The exact gh API call depends on the Discussion API availability. Alternative: manually post via browser. The draft content should be saved to `docs/discussion-update-16586.md` for review before posting.

**Step 1: Save draft**

Write draft to `docs/discussion-update-16586.md` for review.

**Step 2: Review and post**

Get user approval before posting to the public discussion.

---

## Risks

| Risk                                              | P (1-5) | I (1-5) | Score | Mitigation                                                                          |
| ------------------------------------------------- | ------- | ------- | ----- | ----------------------------------------------------------------------------------- |
| TTL index conflicts with existing updatedAt index | 3       | 3       | 9     | Skip regular index when TTL is enabled (same field serves both purposes)            |
| Change Stream not available on all deployments    | 2       | 2       | 4     | Opt-in config, graceful fallback, clear log message                                 |
| Change Stream reconnection fails silently         | 3       | 3       | 9     | Resume token persistence in meta collection, exponential backoff retry              |
| Aggregation analytics slow on large collections   | 2       | 2       | 4     | All aggregations use $group which is O(n) but runs rarely (on-demand)               |
| numDimensions change requires index rebuild       | 3       | 2       | 6     | Document that changing numDimensions requires dropping and recreating vector index  |
| TTL deletes data unexpectedly                     | 2       | 4       | 8     | memoryTtlDays disabled by default (0), log.warn when enabled, docs warning          |
| \_id type change breaks existing data             | 1       | 5       | 5     | String \_id is what we already store; the change is type-level only, not data-level |
| Discussion update receives negative feedback      | 2       | 3       | 6     | Focus on evidence (test results), not claims. Link to real code.                    |

---

## Success Criteria

- [ ] All MEDIUM audit findings fixed (numDimensions, \_id casting)
- [ ] TTL indexes configurable and working (E2E verified)
- [ ] Aggregation analytics returns accurate stats (E2E verified)
- [ ] Change Streams watcher starts and receives events (E2E verified)
- [ ] All new features are opt-in with sane defaults
- [ ] 230+ tests passing, 0 regressions
- [ ] TSC clean in src/
- [ ] Discussion #16586 updated with transaction news
- [ ] No modifications to existing builtin/QMD code paths

---

## Test Plan Summary

| Phase                   | New Unit Tests | New E2E Tests | Total New |
| ----------------------- | -------------- | ------------- | --------- |
| Phase 1: Audit Fixes    | 4-6            | 0             | ~5        |
| Phase 2: TTL Indexes    | 3-4            | 2             | ~5        |
| Phase 3: Analytics      | 5-8            | 2             | ~8        |
| Phase 4: Change Streams | 7-10           | 2             | ~10       |
| **Total**               | **19-28**      | **6**         | **~28**   |

Expected final count: 215 + ~28 = **243+ tests**

---

## Validation Commands

After each phase:

```bash
# Unit tests
npx vitest run src/memory/

# E2E tests (requires Docker MongoDB)
MONGODB_TEST_URI=mongodb://localhost:27018/?replicaSet=rs0 npx vitest run src/memory/mongodb-e2e.e2e.test.ts

# TypeScript check
npx tsc --noEmit

# Full test suite (all project tests)
npx vitest run
```

---

## Phase Dependency Graph

```
Phase 1 (Audit Fixes) ──┐
                         ├── Phase 2 (TTL) ──── Phase 3 (Analytics)
                         │
                         └── Phase 4 (Change Streams)
                                                      ↘
                                                       Phase 5 (Discussion Update)
```

Phase 1 must complete first (it modifies ensureStandardIndexes signature which Phase 2 extends).
Phases 2 and 4 can run in parallel after Phase 1.
Phase 3 depends on Phase 2 (analytics should report TTL status).
Phase 5 can run anytime but best after other phases provide more news.
