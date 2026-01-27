# GraphRAG Plan Evaluation

**Date:** 2026-01-26
**Evaluator:** Claude (Anthropic)
**Reviewed:** `docs/plans/graphrag/` (10 component documents)

---

## Executive Summary

The GraphRAG proposal is **well-structured and generally sound**, but I've identified several **critical gaps**, **technical risks**, and **opportunities to leverage existing ecosystem tools** rather than building from scratch.

**Overall Assessment:** 7.5/10 - Solid foundation, needs refinement in 8 key areas.

---

## Part 1: Holes & Risks in the Plan

### 1. Entity Extraction: No Schema Evolution Mechanism ⚠️ HIGH SEVERITY

**Problem:** The plan assumes a fixed entity type schema (`person | org | repo | concept | tool | location | event | goal | task | file | custom`).

**Why it matters:**
- Users will want custom entity types (e.g., `APIEndpoint`, `Database`, `Service`, `Product`)
- Relationship types will proliferate beyond the hardcoded list
- Type hierarchies emerge (e.g., `Service` → `Microservice` → `Auth Service`)

**Recommendation:** Use an extensible schema with user-definable types stored in `kg_entity_types` and `kg_relationship_types` tables.

**Fix Complexity:** Medium

---

### 2. Web Crawler: Missing Authentication Support ⚠️ MEDIUM SEVERITY

**Problem:** The web crawler plan assumes public URLs. Many valuable docs require authentication.

**Missing capabilities:**
- Authentication (GitHub private repos, Confluence, Notion)
- JavaScript rendering (noted but underweighted as just a "fallback")
- Rate limiting nuances (GitHub has stricter limits)

**Recommendation:**
- Add credential hooks for GitHub/GitLab personal access tokens
- Support for `-H "Authorization: Bearer ..."` crawl headers
- Since Playwright is already a dev dependency, make JS rendering an opt-in `--js-render` flag

**Fix Complexity:** Low

---

### 3. Graph Storage: No Temporal Query Capability ⚠️ MEDIUM SEVERITY

**Problem:** The plan stores `first_seen`/`last_seen` timestamps but provides no query capability for temporal graph evolution.

**Missing queries:**
- "Show me how the Auth Service's connections changed over the past month"
- "What entities were related to PaymentIntent before we switched to Stripe?"
- "Snapshot the graph as of date X"

**Recommendation:** Add `kg_entity_history` and `kg_relationship_history` tables for change tracking. Implement `getHistoricalNeighborhood(entityId, asOfDate)`.

**Fix Complexity:** High

---

### 4. Neo4j Extension: Missed Graph Algorithm Library Opportunity ℹ️ LOW SEVERITY

**Problem:** The plan proposes a custom Neo4j extension implementing the same `GraphQueryEngine` interface.

**Opportunity:** Use the **Graph Data Science (GDS) library** for community detection, PageRank, centrality, and **APOC procedures** for more efficient graph operations.

**Recommendation:** Document GDS/APOC as opt-in capabilities when Neo4j backend is used.

**Fix Complexity:** Low

---

### 5. Hybrid Retrieval: No Negative Sampling or Fallback ⚠️ MEDIUM SEVERITY

**Problem:** The graph expansion could introduce noise. If a query mentions "Auth" and the graph returns 20 weakly-connected entities, this degrades retrieval quality.

**Missing:**
- Confidence scoring for graph-sourced results
- Re-ranking after graph expansion (e.g., using Cross-Encoders)
- Fallback to pure vector mode when graph expansion produces low-confidence matches

**Recommendation:** Add `minGraphScore` threshold. If graph-sourced chunks don't exceed it, skip graph expansion for that query.

**Fix Complexity:** Medium

---

### 6. Testing Strategy: No E2E Tests for Graph Integrity ⚠️ HIGH SEVERITY

**Problem:** The implementation plan mentions unit tests (`*.test.ts`) but no integration/e2e tests that verify graph consistency.

**Missing test coverage:**
- Graph consistency after extraction → consolidation → merge pipeline
- No orphaned relationships after entity deletion
- Correct re-pointing after Tier 2/3 consolidation merges

**Recommendation:** Add `src/knowledge/graph/integration.test.ts`:
```typescript
test("consolidation re-points relationships correctly");
test("self-loops removed after merge");
test("orphaned relationships cleaned after source deletion");
```

**Fix Complexity:** Low

---

### 7. Web Visualization: Performance at Scale Not Addressed ⚠️ MEDIUM SEVERITY

**Problem:** The original plan recommended D3-force for <10K nodes. This has been updated to React Flow which provides better developer experience and native React integration for knowledge graphs with <1000 visible nodes.

**Missing:**
- What happens at 50K+ nodes? (SQLite query performance mentioned, but not rendering)
- Lazy loading strategy for large graphs
- Server-side rendering option for initial layout

**Recommendation:**
- Implement **virtualization** (only render visible + 1-hop neighborhood)
- Use **Web Workers** for force simulation
- Add a "large graph mode" that pre-aggregates clusters server-side

**Fix Complexity:** Medium

---

### 8. No Migration Strategy for Existing Memory ⚠️ HIGH SEVERITY

**Problem:** Existing users have `chunks_vec` and `chunks_fts` tables. The plan adds extraction post-chunking, but doesn't address:

- What about their historical chunks? Re-extract all? Delta-only?
- How long does initial extraction take for 100K existing chunks?

**Recommendation:** Add `clawdbot knowledge reindex --full` command. Store extraction progress in `kg_extraction_progress` table to support resumable backfill.

**Fix Complexity:** Medium

---

## Part 2: Complexity & Impact Analysis by Phase

| Phase | Component | Complexity | Impact | Risk |
|-------|-----------|------------|--------|------|
| **1** | Graph Storage + Entity Extraction Core | **Medium** | **High** | Low |
| | - Schema design | Low | High | Low |
| | - Recursive CTE queries | Medium | High | Low |
| | - LLM extraction pipeline | High | High | Medium (cost/quality) |
| | - Consolidation algorithm | Medium | High | Medium (false merges) |
| **2** | Hybrid GraphRAG + Agent Tools | **Medium** | **Very High** | Medium |
| | - Query entity recognition | Low | High | Low |
| | - Graph expansion | Medium | Very High | Medium (noise) |
| | - Context formatting | Low | Medium | Low |
| | - Agent tools registration | Low | High | Low |
| **3** | Manual Ingestion + Web Crawler | **High** | **Medium** | Medium |
| | - Document parsers (PDF/DOCX) | Medium | Medium | Low |
| | - Crawler orchestration | High | Medium | High (rate limits, JS rendering) |
| | - CLI commands | Low | Medium | Low |
| **4** | Overseer Bridge | **Medium** | **High** | Low |
| | - Goal/task entity sync | Low | High | Low |
| | - Planner graph context injection | Medium | High | Medium (prompt budget) |
| **5** | Web Visualization | **High** | **Medium** | High |
| | - React Flow integration | Low | Low | Low (well-documented, native React) |
| | - Gateway API endpoints | Low | Medium | Low |
| | - Ingestion management UI | Medium | Medium | Low |
| **6** | Neo4j Extension | **Low** | **Low** | Low |

**Total Development Effort Estimate:** 6-8 weeks for a solo developer, 3-4 weeks with parallel work.

---

## Part 3: Tech Stack Recommendations

### A. Use Existing Graph Libraries Instead of Building Custom

**The plan's approach:** Build `GraphQueryEngine` from scratch with recursive CTEs.

**Better alternative:** Use **[`graphology`](https://graphology.github.io/)** as the in-memory graph abstraction layer.

| Library | Why Consider | Status |
|---------|--------------|--------|
| [`graphology`](https://graphology.github.io/) | Comprehensive graph library, BFS/DFS/PageRank/community detection, excellent TypeScript, production-proven (used by Sigma.js) | **RECOMMENDED** |
| [`ngraph.graph`](https://github.com/anvaka/ngraph.graph) | Efficient graph data structure, pagerank | Alternative |
| [`js-graph-algorithms`](https://github.com/dgrcodee/js-graph-algorithms) | BFS, DFS, shortest path, centrality | Alternative |

**Modified Architecture:**
```typescript
import { Graph } from 'graphology';

// SQLiteGraphQueryEngine uses graphology for in-memory operations
// and SQLite for persistence. For queries that fit in memory,
// use graphology algorithms. For disk-bound queries, use CTEs.
```

**Impact:** Reduces custom code, provides tested algorithms, enables future Neo4j migration.

---

### B. Entity Extraction: Fast Pass with Rule-Based NER

**Consideration:** Before LLM extraction, run a fast rule-based NER to reduce LLM calls.

| Library | Why | Cons |
|---------|------|------|
| [`compromise`](https://github.com/spencermountain/compromise) | Fast, no deps, Person/Place/Org | Not code-aware |
| [`ner`](https://github.com/wrigmrazer/ner) | Fast, rule-based | Limited types |

**Recommendation:** For Phase 1, skip rule-based NER (adds complexity for modest savings). Revisit if extraction cost becomes prohibitive.

---

### C. Document Parsers: One Substitution Recommended

| Choice | Verdict | Action |
|--------|---------|--------|
| `pdf-parse` (plan) | OK, but... | **Use `pdfjs-dist` instead** (already a dep) |
| `mammoth` | ✅ Good | Keep |
| `@mozilla/readability` + `linkedom` | ✅ Good | Keep |

**Note:** `pdfjs-dist` is already in `package.json` (line 194). Use it for consistency and better PDF handling.

---

### D. Crawler: Add Robots.txt Parser

| Library | Why |
|---------|-----|
| [`robotstxt`](https://www.npmjs.com/package/robotstxt) | Google's robots.txt parser, well-maintained |
| [`robots-txt-parser`](https://www.npmjs.com/package/robots-txt-parser) | Alternative |

**Recommendation:** Use `robotstxt` (Google's implementation).

---

### E. Graph Visualization: React Flow is Correct Choice

**Decision:** React Flow for knowledge graph visualization

| Library | When to Use |
|---------|-------------|
| **React Flow** | Knowledge graphs <1000 visible nodes, interactive editing |
| (Not recommended) | Alternative frameworks considered but not selected |

**Recommendation:** Use React Flow for all knowledge graph visualization needs. It provides native React integration, built-in force-directed layout, interactive controls (drag, zoom, mini-map), and excellent TypeScript support.

**When to reconsider:** If graphs grow to >2000 visible nodes or 3D visualization becomes a requirement, evaluate alternative frameworks.

---

### F. Fuzzy Matching: Add Edit Distance Check

**The plan's approach:** Embedding similarity for all fuzzy entity matching.

**Better approach:** Add `fast-levenshtein` for Tier 1.5 (edit distance check before embedding).

| Library | Why |
|---------|-----|
| [`fast-levenshtein`](https://www.npmjs.com/package/fast-levenshtein) | Edit distance for near-duplicate detection |
| [`fuse.js`](https://www.fusejs.ie/) | Fast fuzzy string matching for initial pass |

**Recommendation:** Add `fast-levenshtein` to catch `Auth Service` vs `Authservce` typos without embedding cost.

---

### G. Testing: Use Existing Vitest Setup

The plan correctly uses the existing Vitest setup. Add:

| Package | Why |
|---------|-----|
| [`@vitest/browser`](https://www.npmjs.com/package/@vitest/browser) | Already in ui/package.json, test React Flow visualization in browser |
| [`msw`](https://www.npmjs.com/package/msw) | Mock HTTP for crawler tests |

---

### H. TypeScript Types: Leverage Existing `@sinclair/typebox`

The codebase already uses `@sinclair/typebox` (line 167). Use it for tool schema validation:

```typescript
import { Type } from '@sinclair/typebox';

export const GraphSearchToolSchema = Type.Object({
  query: Type.String(),
  entityType: Type.Optional(Type.String()),
  maxHops: Type.Optional(Type.Number({ minimum: 1, maximum: 3 })),
});
```

---

### I. Markdown Parsing: Reuse Existing `markdown-it`

The codebase already has `markdown-it` (line 191). Reuse it for:
- Parsing markdown chunks during extraction
- Rendering formatted content in web UI

---

## Part 4: Current Tech Stack Considerations

### What Works Well ✅

1. **SQLite-first approach** - No new infrastructure, consistent with existing memory system
2. **Recursive CTE support** - SQLite has excellent CTE performance for sub-50K graphs
3. **Embedding infrastructure** - Existing `EmbeddingProvider` abstraction works for entity name embeddings
4. **Batch processing** - Existing `batch-openai.ts` and `batch-gemini.ts` can be reused for extraction
5. **Lit + Tailwind UI** - Consistent with existing control UI
6. **Hono for gateway API** - Existing HTTP framework for `/api/knowledge/*` endpoints
7. **Playwright as dev dep** - Already present for JS-rendered page crawling
8. **`pdfjs-dist` available** - Already a dependency for PDF handling

### Potential Friction Points ⚠️

1. **`sqlite-vec` alpha version** - `0.1.7-alpha.2` (line 199). Monitor for stability updates before release
2. **Node 22.12+ requirement** - Ensures modern features, but verify all graph libs support it
3. **pnpm workspace management** - Extension package must follow existing patterns for `workspace:*` avoidance
4. **Test parallel execution** - Graph tests may need serial execution for database consistency

### Migration Path 🔄

Since `memorySearch` already exists, the migration should be:

1. **Opt-in by default** (`knowledge.enabled: false`)
2. **Lazy schema migration** - Add graph tables on first `knowledge.enabled: true`
3. **Separate database file option** - Allow `knowledge.db` for users who want to keep memory/knowledge separate

---

## Part 5: Recommended Implementation Order Changes

The plan's 6-phase order is generally good, but I recommend:

### 1. Swap Phase 2 and Phase 3

**Change:** Build crawler/ingestion **before** hybrid retrieval

**Why:**
- You need real data to test retrieval quality
- Current Phase 2 relies on synthetic test data
- Crawler provides diverse content for extraction testing

### 2. Add Phase 0: Schema Validation

**Before any code:**
1. Validate the schema with 10 sample documents (PDF, DOCX, MD, code)
2. Create manual entity extraction ground truth
3. Measure extraction quality (precision/recall)

### 3. Add Phase 7: Performance Benchmarking

**After Phase 5:**
1. Benchmark extraction throughput (chunks/second)
2. Benchmark graph query latency vs entity count
3. Benchmark React Flow rendering FPS vs node count

---

## Part 6: Summary of Critical Issues

| Issue | Severity | Fix Complexity |
|-------|----------|----------------|
| No schema evolution mechanism | High | Medium |
| Crawler lacks auth support | Medium | Low |
| No temporal graph queries | Medium | High |
| Graph expansion noise risk | Medium | Medium |
| No E2E graph integrity tests | High | Low |
| React Flow performance at scale | Low | Low | Optimized for <1000 nodes; reconsider if >2000 nodes |
| No backfill strategy for existing data | High | Medium |

---

## Part 7: Quick Wins (Low Complexity, High Impact)

1. **Add `fast-levenshtein`** - Catches obvious typos before embedding
2. **Use `pdfjs-dist`** - Already a dependency, more robust
3. **Add `robotstxt`** - Proper robots.txt parsing
4. **Add `clawdbot knowledge reindex`** - Backfill for existing users
5. **Use `graphology`** - Better algorithms, less custom code

---

## Part 8: Library Substitution Summary

| Plan's Choice | Recommended Substitution | Why |
|---------------|--------------------------|-----|
| Custom `GraphQueryEngine` with CTEs | **`graphology`** + SQLite storage | Better algorithms, tested |
| `pdf-parse` | **`pdfjs-dist`** (already a dep) | Consistency, better PDF handling |
| Custom robots.txt parser | **`robotstxt`** (Google's) | Proper implementation |
| Embedding-only fuzzy match | **`fast-levenshtein`** + embedding | Catch typos faster |
| No negative sampling | **Re-ranking with cross-encoder** (optional) | Improves quality |
| D3-force (from original plan) | **React Flow for knowledge graph visualization** | Better DX, native React integration |

---

## Conclusion

The GraphRAG plan is well-thought-out and architecturally sound. The main areas for improvement are:

1. **Schema extensibility** - Don't hardcode entity/relationship types
2. **Testing coverage** - Add E2E tests for graph integrity
3. **Leverage existing libraries** - Use `graphology`, `pdfjs-dist`, `robotstxt`
4. **Handle edge cases** - Authenticated crawling, temporal queries, backfill

With these addressed, the plan moves from "solid" to "production-ready."
