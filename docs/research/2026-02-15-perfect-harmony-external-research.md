# Perfect Harmony — External Research Findings

**Date:** 2026-02-15
**Purpose:** External research on OpenClaw memory system pain points, upstream bugs, community demand, and improvement opportunities for MongoDB backend

---

## Critical Upstream Bugs Affecting All Users

### Issue #16021: Hybrid Scoring Drops Hit Rate from 95% to 40%

**Status:** OPEN, UNFIXED (hybrid.ts last modified Jan 31, 2026)

Three compounding bugs in `src/memory/hybrid.ts`:

1. **AND-joined FTS queries** — `buildFtsQuery()` joins all tokens with AND. Query `"how should I evaluate if a claim is actually true"` produces `"how" AND "should" AND "I" AND "evaluate" AND "if" AND "a" AND "claim" AND "is" AND "actually" AND "true"` — requires ALL 10 words in a single ~1600-char chunk. Natural language queries almost never match.

2. **Weighted average penalty** — When BM25 returns nothing (which it does for most NL queries), the fusion formula `0.7 * vectorScore + 0.3 * 0` applies a 30% penalty to vector results. A perfect cosine match of 0.95 becomes 0.665 — still above minScore. But a good match of 0.50 becomes 0.35 — exactly at the threshold.

3. **BM25 score clamping** — `bm25RankToScore()` clamps all BM25 scores to a single value due to incorrect handling of negative FTS5 ranks.

**Impact:** 57-query benchmark showed 94.7% hit rate with vector-only vs 40.4% with hybrid (default).

**Our MongoDB backend:** AVOIDS this entirely for $rankFusion/$scoreFusion paths (Levels 1-2). BUT our JS-merge fallback (Level 3) imports `mergeHybridResults()` from the same broken `hybrid.ts`. Community users without mongot on the JS-merge path inherit the upstream bug.

### Issue #9888: CRITICAL Total Persistence Failure

**Status:** OPEN

Both SQLite AND markdown writing stop completely after OpenClaw updates. 90+ minutes of conversation permanently lost. Not recoverable with gateway restart OR container restart. Root cause: memory-core plugin stops all persistence after updates.

MongoDB backend is inherently immune (data in database, not local file).

### Issue #3479: Compaction Always Fails (8 reactions, 38 comments)

**Status:** OPEN

Every compaction entry has fallback text "Summary unavailable due to context limits." Zero actual summaries generated. Agents lose ALL context after compaction. Root causes: reactive-only compaction triggers after overflow, chunk sizing too aggressive, fallback cascade fails.

### Issue #2254: Session Files Grow to 2-3MB from 35 Messages

**Status:** CLOSED (but pattern persists)

Gateway tool returns entire config schema (396KB) per call, stored in session JSONL. Causes context overflow (208K tokens > 200K limit), auto-compaction fails, bot unresponsive.

### Issue #11308: QMD Has 20+ Systemic Issues

**Status:** OPEN

Subprocess spawning, permanent fallback after timeout, 5% failure rate, empty search results, 7+ unmerged fix PRs. Root cause: architectural (CLI → shell → QMD → SQLite → GGUF chain).

### Issue #4868: Memory Index Dirty After Updates

**Status:** OPEN

After updates, memory_search returns empty results despite files existing. Index shows dirty flag. Workaround: manual refresh.

### Issue #11480: Bind-Mount SQLite Failures

**Status:** OPEN

"database is not open" after reindexing on bind-mounted volumes. Index reports success but search fails.

### Issue #14716: DatabaseSync Failures

**Status:** OPEN

MemorySearch indexing fails with `DatabaseSync: "database is not open"`. Index DB remains empty (meta/files/chunks at 0). Persists across fresh store paths, provider changes, Node version changes.

---

## Community Demand for Database Backends

| Issue  | Backend                  | Reactions | Comments | Status                        |
| ------ | ------------------------ | --------- | -------- | ----------------------------- |
| #15093 | PostgreSQL + pgvector    | 4         | 0        | Open, detailed RFC + POC      |
| #8795  | Redis long-term memory   | 4         | 4        | Open                          |
| #14049 | Qdrant persistent memory | 4         | 0        | Open                          |
| #7021  | PowerMem integration     | 4         | 4        | Open                          |
| #13562 | Ollama memory provider   | 4         | 2        | Open                          |
| #17018 | MongoDB (ours)           | 1         | 0        | Open, complete implementation |

**Key insight:** Our MongoDB PR is the ONLY one with a complete, tested implementation (17K lines, 292 tests). The PostgreSQL RFC (#15093) cites 30+ QMD issues as motivation — same pain points we address. Proves strong community demand for database backends.

---

## Forward-Looking Proposals

### Issue #13991: Associative Hierarchical Memory (9 comments)

Proposes three innovations inspired by cognitive science:

1. **Hierarchical Granularity** — store memories at multiple abstraction levels (detail → topic → global). Based on RAPTOR (Stanford, ICLR 2024).
2. **Associative Graph** — spreading activation across memory nodes via temporal, causal, and similarity links. Based on ACT-R theory.
3. **Temporal Awareness** — recency-weighted decay curves, periodic consolidation.

**Relevance:** MongoDB's aggregation framework is ideal for implementing consolidation pipelines. The `structured_mem` collection could serve as the foundation for typed memory nodes.

### Issue #17129: Compaction-Aware Conversation Memory (6600 LOC extension)

New extension with:

- WarmStore (segment storage with BM25 + vector hybrid search)
- ColdStore (JSONL persistence)
- KnowledgeStore (IDF-weighted CJK bigram search)
- Smart-Trim (context-event handler with BM25 relevance scoring)
- 90 tests, production-validated on Feishu

**Relevance:** This pattern could be enhanced with MongoDB as the warm/cold store backend.

---

## Upstream Code Analysis

### hybrid.ts (Upstream — STILL BROKEN as of Feb 15, 2026)

```typescript
// AND-join kills recall for natural language queries
return quoted.join(" AND "); // Line 23

// Weighted average penalizes vector results when BM25=0
const score = params.vectorWeight * entry.vectorScore + params.textWeight * entry.textScore;

// bm25RankToScore clamps everything
const normalized = Number.isFinite(rank) ? Math.max(0, rank) : 999;
return 1 / (1 + normalized);
```

### No Recent Upstream Memory Fixes

Searched merged PRs in last 2 months — zero PRs touch memory search, hybrid scoring, or embedding pipeline. The bugs in #16021 are confirmed unfixed.

---

## Key Findings for Perfect Harmony Plan

1. **Our $rankFusion/$scoreFusion paths already fix the #16021 hit rate problem** — but the JS-merge fallback inherits it
2. **MongoDB backend is immune to #9888, #11480, #14716** — persistence failures that affect SQLite
3. **Five competing backend proposals prove demand** — our complete implementation is the strongest candidate
4. **Score normalization across search methods is the #1 quality gap** — mixing cosine [0,1] with BM25 [0,inf) produces wrong rankings
5. **Embedding failures are silent** — no retry, no visibility, no doctor reporting
6. **KB ingestion lacks transaction safety** — crash between delete and insert = data loss
7. **Agent needs better memory strategy guidance** — tool descriptions are good, but decision tree is missing
