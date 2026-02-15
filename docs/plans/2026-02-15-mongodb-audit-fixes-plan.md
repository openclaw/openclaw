# MongoDB Audit Fixes Implementation Plan (23 Findings)

> **For Claude:** REQUIRED: Follow this plan task-by-task using TDD.
> **SKILL_HINTS for ALL BUILD workflows:** mongodb-agent-skills:mongodb-schema-design, mongodb-agent-skills:mongodb-query-and-index-optimize, mongodb-agent-skills:mongodb-ai, mongodb-agent-skills:mongodb-transactions-consistency
> **Design:** Self-contained — all context inline.

**Goal:** Fix 23 audit findings across the ClawMongo-v2 MongoDB memory backend, prioritized by severity (CRITICAL > MEDIUM > LOW), grouped by related changes to minimize PR churn.

**Architecture:** All changes are modifications to existing files in `src/memory/`, `src/config/`, and `src/agents/tools/`. No new files needed. Each phase produces a committable unit with its own tests.

**Tech Stack:** TypeScript, MongoDB driver, vitest

**Prerequisites:**

- Branch `feat/mongodb-memory-backend` checked out
- 292 memory tests currently passing
- TSC clean

---

## MongoDB Skills Integration

When building ANY phase in this plan, invoke ALL FOUR MongoDB skills. Each finding maps to specific skill expertise:

| Skill                              | When to Use                                                                     | Relevant Findings              |
| ---------------------------------- | ------------------------------------------------------------------------------- | ------------------------------ |
| `mongodb-schema-design`            | Schema validation fixes, bsonType corrections, field declarations               | F9, F2, F14, F15, F16          |
| `mongodb-query-and-index-optimize` | Index fixes, numCandidates cap, TTL conflict, low-cardinality index             | F1, F7, F17, F18, F19          |
| `mongodb-ai`                       | Vector search fixes, numCandidates 10K cap, hybrid search, embedding dimensions | F1, F5, F8, F12, F13, F22, F23 |
| `mongodb-transactions-consistency` | Transactional safety for KB removal, dedup fixes                                | F10, F11                       |

**Rule:** Every BUILD phase MUST load all 4 skills in SKILL_HINTS. The builder should reference specific rules:

- F1 cap: `query-numcandidates-tuning` (mongodb-ai) - 10,000 hard max
- F9 type fix: `validation-json-schema` (mongodb-schema-design)
- F11 transaction: `fundamental-use-transactions-when-required`, `pattern-withtransaction-vs-core-api` (mongodb-transactions-consistency)
- F17 index: `index-remove-unused` (mongodb-query-and-index-optimize)

---

## Relevant Codebase Files

### Files Modified in This Plan

- `src/memory/mongodb-search.ts` — F1, F5, F7
- `src/memory/mongodb-kb-search.ts` — F1, F5, F7, F12
- `src/memory/mongodb-structured-memory.ts` — F1, F5, F7, F13
- `src/memory/mongodb-schema.ts` — F2, F9, F14, F15, F16, F17, F18, F19
- `src/memory/mongodb-kb.ts` — F9, F10, F11, F16
- `src/memory/backend-config.ts` — F3, F8, F22
- `src/memory/embeddings-voyage.ts` — F4
- `src/memory/embedding-model-limits.ts` — F4
- `src/memory/mongodb-manager.ts` — F6, F22
- `src/memory/mongodb-change-stream.ts` — F21
- `src/config/types.memory.ts` — F3

### Test Files

- `src/memory/mongodb-schema.test.ts`
- `src/memory/mongodb-search.test.ts`
- `src/memory/mongodb-kb.test.ts` (may need creation or in existing test)
- `src/memory/mongodb-kb-search.test.ts`
- `src/memory/mongodb-structured-memory.test.ts`
- `src/memory/backend-config.test.ts`
- `src/memory/mongodb-watcher.test.ts`
- `src/memory/mongodb-change-stream.test.ts`

### Patterns to Follow

- `src/memory/mongodb-sync.ts` (transaction pattern with withTransaction + standalone fallback)
- `src/memory/backend-config.ts:318-366` (numeric config validation: `typeof + isFinite + >= 0 + Math.floor`)
- `src/memory/mongodb-search.ts:38-69` (buildVectorSearchStage helper — the reuse target for F5)

---

## Phase 1: CRITICAL Fixes (F1 + F9)

> **Exit Criteria:** numCandidates capped at 10,000 across all 3 search modules. docId type consistent (string) between schema and runtime. All existing tests pass + new tests for both fixes.

### Task 1.1: Cap numCandidates at 10,000 (F1)

**Finding:** `numCandidates: opts.numCandidates ?? Math.max(opts.maxResults * 20, 100)` has no upper bound. MongoDB hard max is 10,000. Server throws error if exceeded.

**Files:**

- Modify: `src/memory/mongodb-search.ts:98` (buildVectorSearchStage call in vectorSearch)
- Modify: `src/memory/mongodb-search.ts:212` (buildVectorSearchStage call in hybridSearchScoreFusion)
- Modify: `src/memory/mongodb-search.ts:306` (buildVectorSearchStage call in hybridSearchRankFusion)
- Modify: `src/memory/mongodb-kb-search.ts:53` (inline vsStage in searchKB)
- Modify: `src/memory/mongodb-structured-memory.ts:150` (inline vsStage in searchStructuredMemory)
- Test: `src/memory/mongodb-search.test.ts`

**Step 1: Write failing tests**

Add tests that verify numCandidates is capped:

```typescript
test("numCandidates is capped at 10000", async () => {
  // Test with maxResults that would compute > 10000 (e.g., 600 * 20 = 12000)
  const results = await vectorSearch(collection, [0.1, 0.2], {
    maxResults: 600,
    minScore: 0,
    indexName: "test_vector",
  });
  // Verify the aggregate pipeline was called with numCandidates <= 10000
  expect(aggregateSpy).toHaveBeenCalledWith(
    expect.arrayContaining([
      expect.objectContaining({
        $vectorSearch: expect.objectContaining({
          numCandidates: 10000,
        }),
      }),
    ]),
  );
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/memory/mongodb-search.test.ts`
Expected: FAIL — numCandidates will be 12000, not 10000

**Step 3: Fix — Add Math.min(…, 10000) cap**

In `src/memory/mongodb-search.ts`, modify the `buildVectorSearchStage` function to add a constant and cap:

```typescript
const MONGODB_MAX_NUM_CANDIDATES = 10_000;
```

All callers already pass through `buildVectorSearchStage`, so the cap goes inside that function at line 49:

```typescript
numCandidates: Math.min(input.numCandidates, MONGODB_MAX_NUM_CANDIDATES),
```

For `mongodb-kb-search.ts:53` and `mongodb-structured-memory.ts:150` which build vsStage inline (see F5 for full refactor), apply the same cap:

```typescript
numCandidates: Math.min(
  opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
  10_000,
),
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/memory/mongodb-search.test.ts`
Expected: PASS

**Step 5: Also add tests for kb-search and structured-memory caps**

Run: `npx vitest run src/memory/mongodb-kb-search.test.ts src/memory/mongodb-structured-memory.test.ts`

### Task 1.2: Fix docId type mismatch (F9)

**Finding:** Schema declares `docId: { bsonType: "objectId" }` but code generates `crypto.randomUUID()` (string). The `_id: docId as unknown as ObjectId` cast is type noise. $lookup joins on docId would fail.

**Files:**

- Modify: `src/memory/mongodb-schema.ts:106` — change `bsonType: "objectId"` to `bsonType: "string"`
- Modify: `src/memory/mongodb-kb.ts:109` — remove `crypto.randomUUID()`, use a string-based ID
- Modify: `src/memory/mongodb-kb.ts:123` — remove `as unknown as ObjectId` cast
- Test: `src/memory/mongodb-schema.test.ts`

**Step 1: Write failing test**

```typescript
test("kb_chunks schema uses string docId, not objectId", () => {
  // Verify the schema constant has bsonType "string" for docId
  expect(KB_CHUNKS_SCHEMA.$jsonSchema.properties.docId.bsonType).toBe("string");
});
```

**Step 2: Run test, verify fails**

Run: `npx vitest run src/memory/mongodb-schema.test.ts`
Expected: FAIL — currently "objectId"

**Step 3: Implement fix**

In `src/memory/mongodb-schema.ts:106`:

```typescript
// Before:
docId: { bsonType: "objectId", description: "Reference to knowledge_base _id" },
// After:
docId: { bsonType: "string", description: "Reference to knowledge_base _id" },
```

In `src/memory/mongodb-kb.ts:123`:

```typescript
// Before:
_id: docId as unknown as import("mongodb").ObjectId,
// After:
_id: docId as unknown as any,
```

Note: The `as unknown as any` is needed because Collection<Document> expects ObjectId for `_id` by default. This is acceptable for string \_ids (see patterns.md: "MongoDB accepts any type for \_id including strings").

**Step 4: Run test, verify passes**

Run: `npx vitest run src/memory/mongodb-schema.test.ts src/memory/mongodb-kb.test.ts`
Expected: PASS

**Step 5: Commit Phase 1**

```bash
git add src/memory/mongodb-search.ts src/memory/mongodb-kb-search.ts src/memory/mongodb-structured-memory.ts src/memory/mongodb-schema.ts src/memory/mongodb-kb.ts
git commit -m "fix(mongodb): cap numCandidates at 10000 + fix docId type mismatch (F1, F9)"
```

---

## Phase 2: Search Quality + Reuse Fixes (F5, F7, F8, F12, F13, F23)

> **Exit Criteria:** buildVectorSearchStage reused in all 3 search modules. $limit added after $vectorSearch. Default fusionMethod changed to "rankFusion". KB has hybrid search path. Structured memory embeds context in search text. All tests pass.

### Task 2.1: Extract and reuse buildVectorSearchStage (F5)

**Finding:** `mongodb-search.ts:38-69` has a reusable `buildVectorSearchStage()` helper but `mongodb-kb-search.ts` and `mongodb-structured-memory.ts` build $vectorSearch stages inline. Bug fixes (like F1 cap) won't propagate.

**Files:**

- Modify: `src/memory/mongodb-search.ts` — export `buildVectorSearchStage` and the cap constant
- Modify: `src/memory/mongodb-kb-search.ts` — import and use `buildVectorSearchStage`
- Modify: `src/memory/mongodb-structured-memory.ts` — import and use `buildVectorSearchStage`
- Test: existing tests should still pass after refactor

**Step 1: Export the helper from mongodb-search.ts**

```typescript
export const MONGODB_MAX_NUM_CANDIDATES = 10_000;

export function buildVectorSearchStage(input: { ... }): Document | null {
  // (already exists, just add export keyword)
}
```

**Step 2: Refactor mongodb-kb-search.ts to use shared helper**

Replace lines 51-63 with:

```typescript
import { buildVectorSearchStage, MONGODB_MAX_NUM_CANDIDATES } from "./mongodb-search.js";

// Inside searchKB:
const vsStage = buildVectorSearchStage({
  queryVector,
  queryText: query,
  embeddingMode: opts.embeddingMode,
  indexName: opts.vectorIndexName,
  numCandidates: opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
  limit: opts.maxResults,
});
if (!vsStage) return [];
```

**Step 3: Refactor mongodb-structured-memory.ts similarly**

Note: structured memory uses `path: "value"` for automated mode (not "text"). The `buildVectorSearchStage` helper needs a `textFieldPath` parameter OR the structured memory module overrides the `path` after calling the builder. Recommend adding an optional `textFieldPath` parameter to buildVectorSearchStage:

```typescript
export function buildVectorSearchStage(input: {
  // ... existing params ...
  textFieldPath?: string; // Override for automated mode path (default: "text")
}): Document | null {
  // In automated mode:
  base.path = input.textFieldPath ?? "text";
}
```

**Step 4: Run all search tests**

Run: `npx vitest run src/memory/mongodb-search.test.ts src/memory/mongodb-kb-search.test.ts src/memory/mongodb-structured-memory.test.ts`
Expected: PASS (pure refactor, no behavior change)

### Task 2.2: Add $limit after $vectorSearch (F7)

**Finding:** After `$vectorSearch`, there's no explicit `$limit` stage. While `$vectorSearch` has a `limit` parameter, adding `$limit` as a pipeline stage is recommended by MongoDB best practices for clarity and pipeline optimization.

**Files:**

- Modify: `src/memory/mongodb-search.ts` — add `{ $limit: opts.maxResults }` after `$vectorSearch` in `vectorSearch()`
- Modify: `src/memory/mongodb-kb-search.ts` — add `$limit` after `$vectorSearch`
- Modify: `src/memory/mongodb-structured-memory.ts` — add `$limit` after `$vectorSearch`

**Implementation:**

In each vector search pipeline, after the `{ $vectorSearch: vsStage }` stage, add:

```typescript
{ $limit: opts.maxResults },
```

This is a LOW risk change. The `$vectorSearch` `limit` already constrains results, but the explicit `$limit` stage is a safety net and MongoDB best practice.

**Test:** Verify aggregate pipelines include $limit. Run existing tests.

### Task 2.3: Change default fusionMethod to "rankFusion" (F8)

**Finding:** Default `fusionMethod: "scoreFusion"` requires MongoDB 8.2+. Users on 8.0-8.1 pay the cost of a failed `$scoreFusion` attempt on every search before falling back. Default should be "rankFusion" (available on 8.0+).

**Files:**

- Modify: `src/memory/backend-config.ts:316` — change default from `"scoreFusion"` to `"rankFusion"`
- Modify: `src/config/types.memory.ts:27` — update JSDoc comment
- Test: `src/memory/backend-config.test.ts`

**Step 1: Write failing test**

```typescript
test("default fusionMethod is rankFusion", () => {
  const resolved = resolveMemoryBackendConfig({ cfg: minimalMongoConfig, agentId: "test" });
  expect(resolved.mongodb!.fusionMethod).toBe("rankFusion");
});
```

**Step 2: Run test, verify fails** (currently returns "scoreFusion")

**Step 3: Implement**

In `src/memory/backend-config.ts:316`:

```typescript
// Before:
fusionMethod: mongoCfg?.fusionMethod ?? "scoreFusion",
// After:
fusionMethod: mongoCfg?.fusionMethod ?? "rankFusion",
```

In `src/config/types.memory.ts:27`:

```typescript
// Before:
/** Hybrid search fusion method. Default: "scoreFusion" */
// After:
/** Hybrid search fusion method. Default: "rankFusion" */
```

**Step 4: Run test, verify passes**

### Task 2.4: Add hybrid search to KB search (F12 — LOW, opportunistic)

**Finding:** KB search only does vector -> keyword -> $text cascade. No hybrid search path like the main chunks search has.

**Files:**

- Modify: `src/memory/mongodb-kb-search.ts`

**Implementation:** Since we already refactored to use `buildVectorSearchStage` (Task 2.1), add a hybrid search path before the vector-only fallback. Pattern: try $rankFusion first (if both textSearch + vectorSearch are available), then fall back to vector-only, then keyword-only, then $text.

This is a LOW priority enhancement. [CHECKPOINT] User decides if this should be included in this phase or deferred to a separate PR. Recommend including since the infrastructure (buildVectorSearchStage reuse) is already in place.

### Task 2.5: Embed context in structured memory search text (F13 — LOW, opportunistic)

**Finding:** Only `value` field is embedded in structured memory, not `context`. When context contains important semantic information (e.g., "User prefers dark mode" has value "dark mode" but context "VS Code settings discussion"), the context is lost during vector search.

**Files:**

- Modify: `src/memory/mongodb-structured-memory.ts:55`

**Implementation:**

In `writeStructuredMemory`, when generating embedding:

```typescript
// Before:
const [vec] = await params.embeddingProvider.embedBatch([entry.value]);
// After:
const textToEmbed = entry.context ? `${entry.value} [context: ${entry.context}]` : entry.value;
const [vec] = await params.embeddingProvider.embedBatch([textToEmbed]);
```

**Test:** Add test verifying embedBatch is called with context-enriched text.

### Task 2.6: Commit Phase 2

```bash
git add src/memory/mongodb-search.ts src/memory/mongodb-kb-search.ts src/memory/mongodb-structured-memory.ts src/memory/backend-config.ts src/config/types.memory.ts
git commit -m "fix(mongodb): reuse buildVectorSearchStage, add $limit, default rankFusion (F5,F7,F8,F12,F13)"
```

---

## Phase 3: Schema + Validation Fixes (F2, F3, F14, F15, F16)

> **Exit Criteria:** automatedEmbedding dead code removed. community+automated guard in place. kb_chunks has source field in schema. chunks collection has schema validation. source.type enum aligned between TS and schema. All tests pass.

### Task 3.1: Remove automatedEmbedding dead code (F2)

**Finding:** `mongodb-schema.ts:19` defines `automatedEmbedding` in `DetectedCapabilities`, line 700 always sets it to `false`. Never consumed anywhere. Dead code.

**Files:**

- Modify: `src/memory/mongodb-schema.ts:19` — remove field from DetectedCapabilities type
- Modify: `src/memory/mongodb-schema.ts:630` — remove from result object initialization
- Modify: `src/memory/mongodb-schema.ts:701` — remove the assignment
- Test: `src/memory/mongodb-schema.test.ts`

**Implementation:**

Remove `automatedEmbedding: boolean` from `DetectedCapabilities` type. Remove all references. Grep for any consumers:

```bash
grep -r "automatedEmbedding" src/
```

If there are consumers beyond the schema file, update them. Based on current patterns.md: "automatedEmbedding in DetectedCapabilities is now dead metadata (always false) -- config drives embedding mode."

**Test:** Update any tests that assert `automatedEmbedding` in capabilities. Verify TSC clean.

### Task 3.2: Guard against embeddingMode "automated" on community profiles (F3)

**Finding:** User can override `embeddingMode: "automated"` on `community-bare`. Index creation fails silently, zero search results, no diagnostic.

**Files:**

- Modify: `src/memory/backend-config.ts` — add validation warning
- Modify: `src/memory/mongodb-manager.ts` — log warning on startup when automated + community

**Implementation:**

In `backend-config.ts`, after resolving embeddingMode, add:

```typescript
const resolvedEmbeddingMode = mongoCfg?.embeddingMode ?? defaultEmbeddingMode;
if (resolvedEmbeddingMode === "automated" && isCommunity) {
  // Warning: automated embedding requires Atlas or Community with mongot autoEmbed support.
  // Community profiles may not support this. Allow override but log it.
  // (Logger not available in config layer — handle in manager)
}
```

In `mongodb-manager.ts`, in the `create()` factory after resolving config:

```typescript
if (mongoCfg.embeddingMode === "automated" && isCommunity(mongoCfg.deploymentProfile)) {
  log.warn(
    `embeddingMode "automated" is not supported on ${mongoCfg.deploymentProfile}. ` +
      `Automated embedding (Voyage AI autoEmbed) requires Atlas. ` +
      `Falling back to text-only search. Set embeddingMode: "managed" for vector search with your own provider.`,
  );
}
```

Where `isCommunity` is:

```typescript
function isCommunity(profile: MemoryMongoDBDeploymentProfile): boolean {
  return profile === "community-mongot" || profile === "community-bare";
}
```

**Test:** Add test in backend-config.test.ts for the override scenario. Add test in mongodb-manager test (or schema test) for the warning log.

### Task 3.3: Add source field to kb_chunks schema (F14)

**Finding:** `mongodb-kb.ts:143` stores `source: "kb"` in chunks but schema doesn't declare it.

**Files:**

- Modify: `src/memory/mongodb-schema.ts` — add `source` to KB_CHUNKS_SCHEMA

**Implementation:**

In KB_CHUNKS_SCHEMA.properties, add:

```typescript
source: { bsonType: "string", description: "Source identifier (e.g., 'kb')" },
```

### Task 3.4: Add schema validation for chunks collection (F15)

**Finding:** The main `chunks` collection has no schema validation. Only KB, kb_chunks, and structured_mem have validators.

**Files:**

- Modify: `src/memory/mongodb-schema.ts` — add CHUNKS_SCHEMA and wire into VALIDATED_COLLECTIONS

**Implementation:**

```typescript
const CHUNKS_SCHEMA: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["path", "text", "hash", "updatedAt"],
    properties: {
      path: { bsonType: "string" },
      text: { bsonType: "string" },
      hash: { bsonType: "string" },
      source: { bsonType: "string" },
      startLine: { bsonType: "number" },
      endLine: { bsonType: "number" },
      embedding: { bsonType: "array" },
      model: { bsonType: "string" },
      updatedAt: { bsonType: "date" },
    },
  },
};

// Add to VALIDATED_COLLECTIONS:
const VALIDATED_COLLECTIONS: Record<string, Document> = {
  chunks: CHUNKS_SCHEMA,
  knowledge_base: KB_SCHEMA,
  kb_chunks: KB_CHUNKS_SCHEMA,
  structured_mem: STRUCTURED_MEM_SCHEMA,
};
```

**Test:** Test that ensureCollections creates chunks with validator. Test that ensureSchemaValidation applies validator to chunks.

### Task 3.5: Fix source.type enum mismatch (F16)

**Finding:** Schema allows `["file", "url", "text", "api"]`, TypeScript allows `"file" | "url" | "manual" | "api"`. Mismatch on "manual" vs "text".

**Files:**

- Modify: `src/memory/mongodb-schema.ts:86` — update enum to match TypeScript
- Modify: `src/memory/mongodb-kb.ts:21` — OR update TypeScript type

**Implementation:** Align both to the same set. Since the TypeScript type is the source of truth (code writes these values), update the schema:

```typescript
// In KB_SCHEMA, source.type:
// Before:
enum: ["file", "url", "text", "api"],
// After:
enum: ["file", "url", "manual", "api"],
```

**Test:** Verify schema enum matches TypeScript type.

### Task 3.6: Commit Phase 3

```bash
git commit -m "fix(mongodb): remove dead code, add schema guards, fix enum mismatch (F2,F3,F14,F15,F16)"
```

---

## Phase 4: Index + Config Fixes (F4, F17, F18, F22)

> **Exit Criteria:** voyage-4-large in token limit maps. Low-cardinality index removed. TTL index conflict handled. numDimensions auto-detection on provider switch. All tests pass.

### Task 4.1: Add voyage-4-large to token limit maps (F4)

**Finding:** `embeddings-voyage.ts:12-16` and `embedding-model-limits.ts:5-13` don't include `voyage-4-large`. Falls back to 8192 (OpenAI default) instead of the correct 32,000.

**Files:**

- Modify: `src/memory/embeddings-voyage.ts:12-16` — add voyage-4-large and voyage-4-lite and voyage-4
- Modify: `src/memory/embedding-model-limits.ts:5-13` — add voyage-4-large, voyage-4-lite, voyage-4
- Test: existing embedding tests

**Implementation:**

In `embeddings-voyage.ts`:

```typescript
const VOYAGE_MAX_INPUT_TOKENS: Record<string, number> = {
  "voyage-3": 32000,
  "voyage-3-lite": 16000,
  "voyage-code-3": 32000,
  "voyage-4": 32000,
  "voyage-4-lite": 16000,
  "voyage-4-large": 32000,
};
```

In `embedding-model-limits.ts`:

```typescript
const KNOWN_EMBEDDING_MAX_INPUT_TOKENS: Record<string, number> = {
  "openai:text-embedding-3-small": 8192,
  "openai:text-embedding-3-large": 8192,
  "openai:text-embedding-ada-002": 8191,
  "gemini:text-embedding-004": 2048,
  "voyage:voyage-3": 32000,
  "voyage:voyage-3-lite": 16000,
  "voyage:voyage-code-3": 32000,
  "voyage:voyage-4": 32000,
  "voyage:voyage-4-lite": 16000,
  "voyage:voyage-4-large": 32000,
};
```

**Test:** Add test that `resolveEmbeddingMaxInputTokens` returns 32000 for voyage-4-large provider.

### Task 4.2: Remove low-cardinality idx_chunks_source index (F17)

**Finding:** Standalone index on `source` field with only 2 values ("memory", "sessions"). Near-zero selectivity. Wastes RAM. The field is already covered by filter fields in search indexes.

**Files:**

- Modify: `src/memory/mongodb-schema.ts:221` — remove `idx_chunks_source` creation
- Test: `src/memory/mongodb-schema.test.ts`

**Implementation:**

Remove these lines from `ensureStandardIndexes`:

```typescript
// REMOVE:
await chunks.createIndex({ source: 1 }, { name: "idx_chunks_source" });
applied++;
```

Update the `applied` count assertion in tests. Decrement expected index count by 1.

**Risk:** LOW. This index has near-zero selectivity. Vector search uses filter fields in the search index definition for source filtering. $text search uses `$match` which benefits from compound indexes, not this standalone low-cardinality index.

### Task 4.3: Handle TTL index conflict on config change (F18)

**Finding:** Switching TTL on/off creates conflicting indexes on same field. Requires manual management. Pattern from patterns.md: "TTL index on same field as regular index: Cannot have two indexes on same field with different options."

**Files:**

- Modify: `src/memory/mongodb-schema.ts` — in ensureStandardIndexes, drop opposite-named index before creating

**Implementation:**

Before creating the TTL or non-TTL index on embedding_cache.updatedAt:

```typescript
// Drop the opposite-named index to prevent conflicts
// (TTL index and regular index cannot coexist on same field)
if (ttlOpts?.embeddingCacheTtlDays && ttlOpts.embeddingCacheTtlDays > 0) {
  try {
    await cache.dropIndex("idx_cache_updated");
  } catch {
    /* may not exist */
  }
  const seconds = ttlOpts.embeddingCacheTtlDays * 24 * 60 * 60;
  await cache.createIndex({ updatedAt: 1 }, { name: "idx_cache_ttl", expireAfterSeconds: seconds });
} else {
  try {
    await cache.dropIndex("idx_cache_ttl");
  } catch {
    /* may not exist */
  }
  await cache.createIndex({ updatedAt: 1 }, { name: "idx_cache_updated" });
}
```

Same pattern for files TTL if applicable.

**Test:** Add test that verifies old index is dropped when switching modes.

### Task 4.4: Add numDimensions validation on provider switch (F22)

**Finding:** If user switches from Voyage (1024 dims) to OpenAI (1536 dims) but doesn't update numDimensions, vector index has wrong dimensions. Silent search failure.

**Files:**

- Modify: `src/memory/mongodb-manager.ts` — add startup warning when numDimensions might mismatch
- Modify: `src/memory/backend-config.ts` — add provider-aware dimension defaults

**Implementation:**

In `mongodb-manager.ts` factory, after creating the embedding provider, check dimensions:

```typescript
if (embeddingProvider && mongoCfg.embeddingMode === "managed") {
  // Known provider dimension defaults
  const KNOWN_DIMENSIONS: Record<string, number> = {
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536,
    "voyage-4-large": 1024,
    "voyage-4": 1024,
    "voyage-4-lite": 512,
    "voyage-3": 1024,
    "voyage-3-lite": 512,
    "voyage-code-3": 1024,
    "text-embedding-004": 768, // Gemini
  };
  const expectedDims = KNOWN_DIMENSIONS[embeddingProvider.model];
  if (expectedDims && expectedDims !== mongoCfg.numDimensions) {
    log.warn(
      `numDimensions mismatch: config has ${mongoCfg.numDimensions} but ` +
        `${embeddingProvider.model} produces ${expectedDims}-dimensional vectors. ` +
        `Vector search may return no results. Set memory.mongodb.numDimensions: ${expectedDims}`,
    );
  }
}
```

**Test:** Add test verifying warning is logged when dimensions mismatch.

### Task 4.5: Commit Phase 4

```bash
git commit -m "fix(mongodb): voyage-4 token limits, remove low-cardinality index, TTL conflict, dimension warning (F4,F17,F18,F22)"
```

---

## Phase 5: KB Data Integrity Fixes (F10, F11)

> **Exit Criteria:** KB re-ingestion deduplicates by source path (not just hash). removeKBDocument uses transaction. All tests pass.

### Task 5.1: Fix KB re-ingestion duplicate documents (F10)

**Finding:** When content changes, a new doc is created alongside the old (different hash). No dedup by source path. Multiple versions accumulate.

**Files:**

- Modify: `src/memory/mongodb-kb.ts` — add dedup by source path
- Modify: `src/memory/mongodb-schema.ts` — add unique index on source.path (if appropriate)
- Test: `src/memory/mongodb-kb.test.ts` (or create)

**Implementation:**

In `ingestToKB`, before the hash-based dedup check, add a source-path-based dedup:

```typescript
// Dedup by source path: if a document from the same path exists with a different hash,
// remove the old version and its chunks before inserting the new one
if (doc.source.path) {
  const existingByPath = await kb.findOne({ "source.path": doc.source.path });
  if (existingByPath && existingByPath.hash !== doc.hash) {
    // Content changed — remove old version
    const oldId = String(existingByPath._id);
    await kbChunks.deleteMany({ docId: oldId });
    await kb.deleteOne({ _id: existingByPath._id });
    log.info(`replaced stale KB document for path: ${doc.source.path}`);
  } else if (existingByPath && existingByPath.hash === doc.hash && !force) {
    // Same content — skip
    result.skipped++;
    continue;
  }
}
```

Also add an index for efficient path lookup (in ensureStandardIndexes):

```typescript
await kb.createIndex({ "source.path": 1 }, { name: "idx_kb_source_path", sparse: true });
```

**Test:** Test that re-ingesting a file with changed content replaces the old document, not creates a duplicate.

### Task 5.2: Add transactional safety to removeKBDocument (F11)

**Finding:** Two independent writes (deleteMany chunks, deleteOne doc) without transaction. Crash between = orphaned data.

**Files:**

- Modify: `src/memory/mongodb-kb.ts:328-336`

**Implementation:**

Use the same transaction pattern from mongodb-sync.ts:

```typescript
export async function removeKBDocument(db: Db, prefix: string, docId: string): Promise<boolean> {
  const kb = kbCollection(db, prefix);
  const kbChunks = kbChunksCollection(db, prefix);

  // Use transaction for atomic removal (chunks + document)
  // Falls back to non-transactional on standalone deployments
  let useTransaction = true;
  let deleted = false;

  try {
    const { MongoClient } = await import("mongodb");
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        await kbChunks.deleteMany({ docId }, { session });
        const result = await kb.deleteOne({ _id: docId } as Record<string, unknown>, { session });
        deleted = result.deletedCount > 0;
      });
    } finally {
      await session.endSession();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Check if transactions not supported (standalone)
    if (msg.includes("replica set") || msg.includes("Transaction numbers")) {
      useTransaction = false;
    } else {
      throw err;
    }
  }

  if (!useTransaction) {
    // Fallback: non-transactional (same as before)
    await kbChunks.deleteMany({ docId });
    const result = await kb.deleteOne({ _id: docId } as Record<string, unknown>);
    deleted = result.deletedCount > 0;
  }

  return deleted;
}
```

**Test:** Test that session.withTransaction is called. Test standalone fallback.

### Task 5.3: Commit Phase 5

```bash
git commit -m "fix(mongodb): KB dedup by source path + transactional removeKBDocument (F10, F11)"
```

---

## Phase 6: LOW Priority Fixes (F6, F7-done, F15-done, F19, F21, F23)

> **Exit Criteria:** Model metadata accurate. Index count reduced. Change stream has resume token. Score normalization documented/deferred. All tests pass.

### Task 6.1: Fix model metadata in automated mode (F6)

**Finding:** Status display shows hardcoded "voyage-4-large (automated)" even though the model is configured server-side and could theoretically be different.

**Files:**

- Modify: `src/memory/mongodb-manager.ts:423-424`

**Implementation:**

```typescript
model:
  mongoCfg.embeddingMode === "automated"
    ? "automated (server-managed)"
    : this.embeddingProvider?.model,
```

**Risk:** Trivial cosmetic fix.

### Task 6.2: Reduce index count on chunks collection (F19)

**Finding:** 7+ indexes on chunks collection. Each index costs RAM and write amplification.

**Analysis:**

- `idx_chunks_path` — KEEP (critical for sync lookups)
- `idx_chunks_source` — REMOVED in Phase 4 (F17)
- `idx_chunks_path_hash` — KEEP (dedup during sync)
- `idx_chunks_updated` — KEEP (TTL fallback, sort)
- `idx_chunks_text` — KEEP ($text search fallback)

After removing F17's low-cardinality index, count drops to 6 standard + search indexes. This is acceptable.

[CHECKPOINT] If user wants further reduction, `idx_chunks_updated` could be converted to a TTL index (like embedding_cache). But that would auto-delete memory chunks, which is probably not desired. Recommend keeping as-is after F17 removal.

### Task 6.3: Add resume token to change stream (F21)

**Finding:** Change stream has no resume token persistence. After reconnection, events are missed.

**Files:**

- Modify: `src/memory/mongodb-change-stream.ts`
- Modify: `src/memory/mongodb-manager.ts` (pass meta collection)

**Implementation:**

In `MongoDBChangeStreamWatcher`:

```typescript
private resumeToken: unknown = undefined;

async start(): Promise<boolean> {
  // Load resume token from meta collection
  if (this.metaCollection) {
    try {
      const meta = await this.metaCollection.findOne({ _id: "cs_resume_token" as any });
      if (meta?.token) {
        this.resumeToken = meta.token;
      }
    } catch { /* first time */ }
  }

  this.stream = this.collection.watch([...], {
    fullDocument: "updateLookup",
    ...(this.resumeToken ? { resumeAfter: this.resumeToken } : {}),
  });

  this.stream.on("change", (change) => {
    // Save resume token on each event
    if (change._id) {
      this.resumeToken = change._id;
    }
    this.handleChange(change);
  });
}

private async persistResumeToken(): Promise<void> {
  if (!this.metaCollection || !this.resumeToken) return;
  try {
    await this.metaCollection.updateOne(
      { _id: "cs_resume_token" as any },
      { $set: { token: this.resumeToken, updatedAt: new Date() } },
      { upsert: true },
    );
  } catch { /* non-critical */ }
}
```

Persist on flush (not on every event — too expensive):

```typescript
private flush(): void {
  // ... existing flush logic ...
  void this.persistResumeToken();
}
```

**Test:** Test that resume token is loaded on start and persisted on flush. Test that watch options include resumeAfter when token exists.

### Task 6.4: Document score normalization gap (F23)

**Finding:** Scores not normalized across sources (legacy chunks, KB, structured memory). Each search module returns different score ranges.

**Implementation:** This is a design decision, not a bug. Document it in the code and defer to a future enhancement.

Add comment in `mongodb-manager.ts:337`:

```typescript
// NOTE: Scores are not normalized across sources (legacy, KB, structured).
// Vector search scores are cosine similarity [0,1], $text scores are TF-IDF [unbounded],
// $search scores vary by relevance. Cross-source sorting by score is approximate.
// Future enhancement: normalize to [0,1] per source before merging.
```

### Task 6.5: Commit Phase 6

```bash
git commit -m "fix(mongodb): model metadata, resume token, index cleanup, score docs (F6,F19,F21,F23)"
```

---

## Risks

| Risk                                                   | P (1-5) | I (1-5) | Score | Mitigation                                                                                                  |
| ------------------------------------------------------ | ------- | ------- | ----- | ----------------------------------------------------------------------------------------------------------- |
| F1 cap breaks existing configs with high numCandidates | 2       | 3       | 6     | Cap is server-enforced anyway; we just prevent the error                                                    |
| F9 schema change triggers warnings on existing data    | 2       | 2       | 4     | validationAction: "warn" means inserts succeed                                                              |
| F5 refactor introduces import cycle                    | 2       | 4       | 8     | kb-search and structured-memory import from mongodb-search (one direction only)                             |
| F8 fusionMethod default change surprises 8.2+ users    | 3       | 2       | 6     | rankFusion is strictly lower quality only when scoreFusion normalization matters; explicit config overrides |
| F10 dedup by path breaks multi-version KB use case     | 2       | 3       | 6     | Only dedup when same path has different hash; force flag still works                                        |
| F11 transaction on standalone throws                   | 1       | 4       | 4     | Graceful fallback pattern (same as mongodb-sync.ts)                                                         |
| F17 removing index breaks query that depended on it    | 1       | 3       | 3     | Source field has only 2 values; search indexes handle filtering                                             |
| F18 dropIndex on non-existent index throws             | 1       | 2       | 2     | Wrapped in try/catch                                                                                        |

---

## Test Strategy Summary

| Phase                           | Risk Level  | Test Approach                          | Validation Command           |
| ------------------------------- | ----------- | -------------------------------------- | ---------------------------- |
| Phase 1 (F1, F9)                | HIGH        | Unit tests for cap + schema type       | `npx vitest run src/memory/` |
| Phase 2 (F5, F7, F8, F12, F13)  | MEDIUM      | Unit tests + integration refactor test | `npx vitest run src/memory/` |
| Phase 3 (F2, F3, F14, F15, F16) | LOW-MEDIUM  | Unit tests for schema + config         | `npx vitest run src/memory/` |
| Phase 4 (F4, F17, F18, F22)     | MEDIUM      | Unit tests for limits + index          | `npx vitest run src/memory/` |
| Phase 5 (F10, F11)              | MEDIUM-HIGH | Unit tests + transaction mock          | `npx vitest run src/memory/` |
| Phase 6 (F6, F19, F21, F23)     | LOW         | Unit tests where applicable            | `npx vitest run src/memory/` |

**Full validation after each phase:**

```bash
npx vitest run src/memory/ && npx tsc --noEmit
```

---

## Success Criteria

- [ ] All 23 findings addressed (fixed or documented with rationale for deferral)
- [ ] All existing 292 tests still pass
- [ ] New tests added for each fix (target 15-25 new tests)
- [ ] TSC clean (0 errors in src/)
- [ ] No regressions in search quality or performance
- [ ] Each phase is a clean, reviewable commit

---

## Findings Cross-Reference

| ID  | Severity | Phase | Task | Status                                   |
| --- | -------- | ----- | ---- | ---------------------------------------- |
| F1  | CRITICAL | 1     | 1.1  | Planned                                  |
| F9  | CRITICAL | 1     | 1.2  | Planned                                  |
| F2  | MEDIUM   | 3     | 3.1  | Planned                                  |
| F3  | MEDIUM   | 3     | 3.2  | Planned                                  |
| F4  | MEDIUM   | 4     | 4.1  | Planned                                  |
| F5  | MEDIUM   | 2     | 2.1  | Planned                                  |
| F6  | LOW      | 6     | 6.1  | Planned                                  |
| F7  | LOW      | 2     | 2.2  | Planned                                  |
| F8  | MEDIUM   | 2     | 2.3  | Planned                                  |
| F9  | CRITICAL | 1     | 1.2  | Planned                                  |
| F10 | MEDIUM   | 5     | 5.1  | Planned                                  |
| F11 | MEDIUM   | 5     | 5.2  | Planned                                  |
| F12 | LOW      | 2     | 2.4  | Planned                                  |
| F13 | LOW      | 2     | 2.5  | Planned                                  |
| F14 | MEDIUM   | 3     | 3.3  | Planned                                  |
| F15 | LOW      | 3     | 3.4  | Planned                                  |
| F16 | MEDIUM   | 3     | 3.5  | Planned                                  |
| F17 | MEDIUM   | 4     | 4.2  | Planned                                  |
| F18 | MEDIUM   | 4     | 4.3  | Planned                                  |
| F19 | LOW      | 6     | 6.2  | Planned (analysis only — removed in F17) |
| F21 | LOW      | 6     | 6.3  | Planned                                  |
| F22 | MEDIUM   | 4     | 4.4  | Planned                                  |
| F23 | LOW      | 6     | 6.4  | Planned (documented, deferred)           |

---

## Checkpoints (Decisions Requiring User Input)

- [CHECKPOINT] F12 (KB hybrid search): Include in Phase 2 or defer to separate PR? **Recommend: include** (infrastructure already in place from F5 refactor)
- [CHECKPOINT] F19 (index count): Further reduce beyond F17 removal? **Recommend: no further reduction** (remaining indexes are all necessary)
- [CHECKPOINT] F23 (score normalization): Implement normalization or document gap? **Recommend: document** (normalization is a separate design decision)
