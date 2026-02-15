# Perfect Harmony: 6-Phase MongoDB Memory Backend Improvements

> **For Claude:** Follow phases in order. Each phase is independently shippable. All changes ADDITIVE only.
> **Research:** `docs/research/2026-02-15-perfect-harmony-external-research.md`
> **Brainstorm:** `docs/plans/2026-02-15-mongodb-native-memory-architecture-brainstorm.md`

**Goal:** Fix search quality, add resilience, improve agent intelligence, and optimize performance across the MongoDB memory backend.

**Architecture:** Layered improvements to existing mongodb-\* modules. No new collections. No upstream file modifications beyond the 4 already-modified files (system-prompt.ts, memory-tool.ts, memory-search.ts, tool-policy.ts).

**Prerequisites:** All 23 audit findings fixed (Task 70), 299/299 tests passing, TSC clean.

---

## Phase Overview

| Phase | Priority | Name                     | Key Deliverable                                  | Risk   |
| ----- | -------- | ------------------------ | ------------------------------------------------ | ------ |
| 1     | P0       | Fix Search Quality       | mongodb-hybrid.ts with RRF, score normalization  | Medium |
| 2     | P0       | Embedding Resilience     | Retry + embeddingStatus + doctor coverage        | Low    |
| 3     | P1       | KB Transaction Safety    | withTransaction for dedup, result dedup at merge | Medium |
| 4     | P1       | Agent Intelligence       | Decision tree system prompt, feedback loop       | Low    |
| 5     | P2       | Performance Optimization | Parallel search, projection, pool tuning         | Low    |
| 6     | P2       | Upstream Pain Showcase   | Documentation of upstream issues we solve        | None   |

---

## Phase 1: Fix Search Quality (P0)

**Problem:** Upstream hybrid.ts has AND-join FTS bug (#16021) that drops hit rate from 95% to 40%. Our $rankFusion/$scoreFusion paths avoid it, but JS-merge fallback (Level 3) imports the broken `mergeHybridResults()`. Score normalization across search methods is also broken (mixing cosine [0,1] with BM25 [0,inf)).

**Files:**

- Create: `src/memory/mongodb-hybrid.ts` (our own hybrid merge with OR-join + RRF)
- Create: `src/memory/mongodb-hybrid.test.ts`
- Modify: `src/memory/mongodb-manager.ts` (merge logic: tag results with method, normalize before cross-source merge)
- Modify: `src/memory/mongodb-search.ts` (import mongodb-hybrid instead of upstream hybrid for Level 3)
- Modify: `src/memory/backend-config.ts` (lower default minScore from 0.35 to 0.25)

**Steps:**

1. Create `mongodb-hybrid.ts` with:
   - OR-join FTS query builder (replace AND-join)
   - Reciprocal Rank Fusion (RRF) scoring: `1/(k+rank)` with k=60
   - Score normalization utils: `normalizeVectorScore()`, `normalizeBM25Score()`, `normalizeRRFScore()`
   - `mergeHybridResultsMongoDB()` export (drop-in replacement for upstream `mergeHybridResults`)
2. Update `mongodb-search.ts` Level 3 fallback to import from `mongodb-hybrid.ts` instead of `hybrid.ts`
3. Update `mongodb-manager.ts` merge logic:
   - Tag each result with `searchMethod: "vector" | "text" | "hybrid" | "structured" | "kb"`
   - Normalize scores to [0,1] range before cross-source merge
   - Sort by normalized score
4. Lower `minScore` default to 0.25 in `backend-config.ts`
5. Tests: OR-join FTS, RRF scoring math, normalization utils, cross-source merge ranking

**[CHECKPOINT] minScore default:** Lowering from 0.35 to 0.25 increases recall but may return lower-quality results. Recommend 0.25 because MongoDB's server-side fusion already filters well.

**Exit Criteria:** `npx vitest run src/memory/mongodb-hybrid.test.ts src/memory/mongodb-search.test.ts src/memory/mongodb-manager.test.ts` passes. Score normalization verified with test cases showing correct cross-source ranking.

**Validation:** Level 2 (unit tests)

---

## Phase 2: Embedding Resilience & Observability (P0)

**Problem:** Embedding failures are silent. No retry, no visibility, no doctor reporting. Failed chunks are invisible.

**Files:**

- Modify: `src/memory/mongodb-sync.ts` (retry with exponential backoff)
- Modify: `src/memory/mongodb-kb.ts` (retry + embeddingStatus on failed chunks)
- Modify: `src/memory/mongodb-structured-memory.ts` (retry + embeddingStatus)
- Modify: `src/memory/mongodb-manager.ts` (surface embeddingStatus in stats)
- Modify: `src/memory/mongodb-analytics.ts` (add coverage metrics to getMemoryStats)
- Modify: `src/commands/doctor-memory-search.ts` (surface embedding coverage)

**Steps:**

1. Create shared `retryEmbedding()` util (3 attempts, exponential backoff: 1s, 2s, 4s)
2. Add `embeddingStatus: "success" | "failed" | "pending"` field to chunks on write
3. In sync: on embedding failure after retries, store chunk with `embeddingStatus: "failed"`, log warning
4. On next sync: re-attempt embedding for `embeddingStatus: "failed"` chunks
5. Add to `getMemoryStats()`: `embeddingCoverage: { total, success, failed, pending }`
6. Add to doctor: `noteEmbeddingCoverage()` that warns if failed > 0
7. Tests: retry logic (mock provider failures), embeddingStatus field, re-embed on next sync, stats coverage

**Exit Criteria:** `npx vitest run src/memory/` passes. Doctor shows embedding coverage. Failed chunks get re-embedded on next sync.

**Validation:** Level 2 (unit tests)

---

## Phase 3: KB Transaction Safety & Dedup (P1)

**Problem:** KB dedup and ingestion lack transaction safety. Crash between delete-old and insert-new = data loss. Search results from multiple sources can contain duplicates.

**Files:**

- Modify: `src/memory/mongodb-kb.ts` (wrap dedup in withTransaction, standalone fallback)
- Modify: `src/memory/mongodb-manager.ts` (result dedup at merge by content hash)
- Modify: `src/memory/mongodb-schema.ts` (KB startup integrity check)

**Steps:**

1. Wrap KB re-ingestion (delete old chunks + insert new) in `withTransaction()` with standalone fallback (same pattern as mongodb-sync.ts)
2. Add result dedup at merge in mongodb-manager.ts:
   - Hash result content
   - On duplicate, keep highest-scoring result
   - Log dedup count at debug level
3. Add KB startup integrity check in schema setup:
   - Find orphaned kb_chunks (docId references non-existent knowledge_base doc)
   - Log warning with count, do NOT auto-delete (user decides)
4. Tests: transaction wrapping, standalone fallback, content-hash dedup, orphan detection

**[CHECKPOINT] Orphan handling: Log warning only (recommend) vs auto-delete on startup. Recommend log-only for safety.**

**Exit Criteria:** `npx vitest run src/memory/mongodb-kb.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-schema.test.ts` passes. KB re-ingestion is atomic.

**Validation:** Level 2 (unit tests)

---

## Phase 4: Agent Intelligence -- Smarter Memory Routing (P1)

**Problem:** Agent doesn't know when to use memory_write vs MEMORY.md, or kb_search vs memory_search. System prompt has basic tool descriptions but no decision tree.

**Files:**

- Modify: `src/agents/system-prompt.ts` (add decision tree)
- Modify: `src/agents/tools/memory-tool.ts` (enhanced tool descriptions with examples)

**Steps:**

1. Add decision tree to MongoDB-aware system prompt section:

   ```
   When storing information:
   - Structured data (decisions, preferences, facts) -> memory_write
   - Informal notes, observations, plans -> MEMORY.md

   When searching:
   - Business/reference docs -> kb_search
   - Personal memory + sessions -> memory_search
   - Broad "what do I know about X?" -> memory_search (searches all sources)
   ```

2. Add usage examples to tool descriptions (1-2 lines each)
3. Add memory feedback loop: when memory_search returns < 2 results with score < 0.3, append note to result: "Low confidence results. Consider rephrasing query or checking kb_search."
4. Tests: system prompt includes decision tree when MongoDB backend, feedback loop triggers correctly

**[CHECKPOINT] Feedback loop threshold: score < 0.3 AND results < 2 (recommend). Could be more/less aggressive.**

**Exit Criteria:** `npx vitest run src/agents/` passes. System prompt conditional rendering verified for all 5 callers.

**Validation:** Level 2 (unit tests)

---

## Phase 5: Performance Optimization (P2)

**Problem:** Search across collections is sequential. Embedding vectors returned in results waste bandwidth. No index usage auditing.

**Files:**

- Modify: `src/memory/mongodb-manager.ts` (parallel search, projection)
- Modify: `src/memory/mongodb-search.ts` (add projection to exclude embedding)
- Modify: `src/memory/mongodb-kb-search.ts` (add projection to exclude embedding)
- Modify: `src/memory/mongodb-structured-memory.ts` (add projection to exclude embedding)
- Modify: `src/memory/mongodb-analytics.ts` (add $indexStats to getMemoryStats)

**Steps:**

1. Change mongodb-manager.ts `search()` to run all sources in parallel with `Promise.all()` (each wrapped in `.catch(() => [])` per existing pattern)
2. Add `{ projection: { embedding: 0 } }` to all search result pipelines (embedding vectors are large and never displayed)
3. Add connection pool config: `maxPoolSize` (default 10), `minPoolSize` (default 2) to backend-config.ts
4. Add `$indexStats` aggregation to `getMemoryStats()` — show which indexes are used and which are unused
5. Tests: parallel execution timing, projection excludes embedding, pool config wiring, indexStats in stats output

**[CHECKPOINT] maxPoolSize default: 10 (recommend for typical workloads). Atlas M0 may want lower.**

**Exit Criteria:** `npx vitest run src/memory/` passes. Search results do not contain embedding field. Stats include index usage.

**Validation:** Level 2 (unit tests)

---

## Phase 6: Upstream Pain Showcase (P2)

**Problem:** Discussion #16586 and PR #17018 need stronger evidence of upstream pain points that MongoDB solves.

**Files:**

- Create: `docs/upstream-pain-showcase.md`
- Modify: existing Discussion #16586 text (manual GitHub update)

**Steps:**

1. Document how MongoDB backend solves each upstream issue:
   - #16021: Hybrid scoring 95%->40% -- our $rankFusion/$scoreFusion + mongodb-hybrid.ts RRF
   - #9888: Total persistence failure -- MongoDB immune (data in DB, not local files)
   - #3479: Compaction context loss -- structured_mem survives compaction
   - #2254: Session bloat -- hash-based dedup + TTL indexes
   - #11308: QMD 20+ bugs -- no subprocess chain (direct MongoDB queries)
   - #11480: Bind-mount SQLite -- MongoDB immune
   - #14716: DatabaseSync failures -- MongoDB immune
   - #10324: No transactions -- withTransaction() pattern throughout
   - #13440: Multi-instance -- shared MongoDB + Change Streams
2. Add `maxSessionChunks` config (cap chunks per session file, default 50) in backend-config.ts
3. Update Discussion #16586 with new evidence after Phases 1-5 land

**Exit Criteria:** Document complete. maxSessionChunks wired and tested.

**Validation:** Level 1 (lint + TSC)

---

## Risks

| Risk                                                               | P   | I   | Score | Mitigation                                                                                                                     |
| ------------------------------------------------------------------ | --- | --- | ----- | ------------------------------------------------------------------------------------------------------------------------------ |
| JS-merge fallback changes break Community users without mongot     | 3   | 4   | 12    | Comprehensive test suite for Level 3 path; keep upstream mergeHybridResults as fallback import                                 |
| Score normalization changes affect result ranking                  | 3   | 3   | 9     | Benchmark with 57-query test set from #16021; compare before/after hit rates                                                   |
| Embedding retry slows sync if provider consistently failing        | 2   | 3   | 6     | Cap at 3 retries; track embeddingStatus for visibility; skip on consecutive failures                                           |
| KB transaction wrapping increases latency                          | 2   | 2   | 4     | Already proven pattern from mongodb-sync.ts; standalone fallback exists                                                        |
| System prompt changes need testing across all 5 callers            | 3   | 3   | 9     | Grep-verify all 5 callers: attempt.ts, compact.ts, helpers.ts, commands-context-report.ts, pi-embedded-runner/system-prompt.ts |
| maxPoolSize config ignored if not wired to MongoClient constructor | 2   | 3   | 6     | Verify in MongoClient options pass-through; test with mock                                                                     |

---

## Relevant Codebase Files

### Key Source Files

- `src/memory/hybrid.ts` -- upstream broken hybrid (AND-join FTS, weighted average)
- `src/memory/mongodb-search.ts` -- search dispatcher with Level 1/2/3 cascade
- `src/memory/mongodb-manager.ts` -- central manager, merge logic, search orchestration
- `src/memory/mongodb-sync.ts` -- file sync pipeline, embedding generation
- `src/memory/mongodb-kb.ts` -- KB ingestion, dedup
- `src/memory/mongodb-kb-search.ts` -- KB-specific search
- `src/memory/mongodb-structured-memory.ts` -- structured memory CRUD
- `src/memory/mongodb-analytics.ts` -- getMemoryStats()
- `src/memory/mongodb-schema.ts` -- collection setup, indexes, validation
- `src/memory/backend-config.ts` -- config resolution, defaults
- `src/agents/system-prompt.ts` -- agent system prompt (5 callers)
- `src/agents/tools/memory-tool.ts` -- tool creation (memory_search, kb_search, memory_write)
- `src/commands/doctor-memory-search.ts` -- doctor health checks

### Patterns to Follow

- `src/memory/mongodb-sync.ts` (withTransaction + standalone fallback pattern)
- `src/memory/mongodb-search.ts:buildVectorSearchStage()` (canonical vector search builder)
- `src/memory/backend-config.ts` (numeric validation: typeof + isFinite + >= 0 + Math.floor)

### Test Commands

- Unit: `npx vitest run src/memory/`
- Full: `npx vitest run src/memory/ src/agents/tools/memory-tool-mongodb.test.ts src/wizard/onboarding-memory.test.ts`
- TSC: `npx tsc --noEmit`
- E2E: `MONGODB_TEST_URI=mongodb://localhost:27018/?replicaSet=rs0 npx vitest run --config vitest.e2e.config.ts`

---

## BUILDER SKILL_HINTS

```yaml
skills:
  - mongodb-agent-skills:mongodb-schema-design
  - mongodb-agent-skills:mongodb-query-and-index-optimize
  - mongodb-agent-skills:mongodb-ai
  - mongodb-agent-skills:mongodb-transactions-consistency
```

---

## Confidence Score: 85/100

- Context references with file paths: +15
- All edge cases documented (5 risks, 3 checkpoints): +20
- Test commands specific per phase: +20
- Risk mitigations defined: +20
- File paths verified against actual codebase: +10
- Deductions: No benchmark test set yet for score normalization (-10), upstream hybrid.ts may change (-5)
