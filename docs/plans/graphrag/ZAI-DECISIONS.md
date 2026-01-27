# GraphRAG Architectural Decisions

**Purpose:** Track key architectural decisions made during GraphRAG planning and implementation.
**Status:** Living document - update as decisions are made or revisited.

---

## Decision Format

Each decision follows the **ADR (Architecture Decision Record)** format:

```
# AD-{number}: {Decision Title}

**Status:** Accepted | Proposed | Deprecated | Superseded
**Date:** YYYY-MM-DD
**Context:** {What problem are we solving?}
**Decision:** {What did we decide?}
**Consequences:** {What does this mean for the project?}
**Alternatives Considered:** {What else did we look at?}
```

---

## AD-01: SQLite as Default Graph Storage

**Status:** Accepted
**Date:** 2026-01-26
**Context:**
- Need graph storage without adding infrastructure dependency
- Existing memory system is SQLite-based
- Want to keep Clawdbrain as a "single binary" CLI tool

**Decision:**
Use SQLite with recursive CTEs for graph queries up to ~50K entities. Neo4j available as optional extension for larger deployments.

**Consequences:**
- ✅ Zero new infrastructure for default users
- ✅ Consistent with existing memory system
- ✅ Easy backup/migration (single SQLite file)
- ✅ Per-agent databases (same pattern as memory)
- ⚠️ Limited to 3-hop queries at scale (performance degrades after)
- ⚠️ No built-in graph algorithms (community detection, PageRank)

**Alternatives Considered:**
- **Neo4j as default:** Rejected due to operational overhead
- **PostgreSQL + Apache AGE:** Rejected due to additional infrastructure
- **In-memory only:** Rejected (persistence required)
- **RedisGraph:** Rejected (deprecated project)

---

## AD-02: Graphology for In-Memory Graph Operations

**Status:** Accepted
**Date:** 2026-01-26
**Context:**
- Need tested graph algorithms (BFS, DFS, shortest path, PageRank)
- Don't want to implement recursive CTEs for everything
- Want an abstraction layer that can work with any storage backend

**Decision:**
Use [`graphology`](https://graphology.github.io/) as the in-memory graph abstraction layer. It provides tested algorithms and can work with SQLite, Neo4j, or pure in-memory storage.

**Consequences:**
- ✅ Reduces custom code by ~500 LOC
- ✅ Production-proven library (used by Sigma.js)
- ✅ Excellent TypeScript support
- ✅ Easy to swap storage backends
- ⚠️ Additional dependency to maintain
- ⚠️ In-memory operations limited by RAM

**Alternatives Considered:**
- **Custom CTE-only implementation:** Rejected (reinventing wheel)
- **`ngraph.graph`:** Good alternative, but graphology has more features
- **`igraph` (WebAssembly):** Rejected (adds WASM complexity)

---

## AD-03: Delimiter-Based LLM Extraction Prompts

**Status:** Accepted
**Date:** 2026-01-26
**Context:**
- Need LLM to extract entities and relationships from text chunks
- JSON mode can be flaky across different models
- Want prompt to work with cheap models (GPT-4.1-mini, Gemini 2.0 Flash)

**Decision:**
Use delimiter-based format (inspired by LightRAG) with JSON fallback:
```
("entity" | "name" | "type" | "description")
("relationship" | "source" | "target" | "type" | "desc" | "keywords" | strength)
```

**Consequences:**
- ✅ More token-efficient than JSON
- ✅ Works reliably across models
- ✅ Graceful degradation (parse what we can, skip malformed lines)
- ⚠️ Custom parser required
- ⚠️ No schema validation at parse time (unlike JSON Schema)

**Alternatives Considered:**
- **JSON-only mode:** Rejected (less reliable across models)
- **XML tags:** Rejected (more verbose)
- **Function calling:** Rejected (not universally supported)

---

## AD-04: 3-Tier Entity Consolidation Algorithm

**Status:** Accepted
**Date:** 2026-01-26
**Context:**
- Same entity appears under different names ("Auth Service", "AuthService", "auth service")
- Need to prevent graph bloat from near-duplicates
- Want to balance precision vs recall

**Decision:**
Three-tier merge algorithm:
1. **Tier 1: Exact Match** - MD5 hash of normalized name
2. **Tier 2: Fuzzy Match** - Embedding similarity (cosine ≥0.92)
3. **Tier 3: LLM Confirmation** - For borderline cases (0.88-0.92), opt-in

**Consequences:**
- ✅ Catches trivial variations (casing, whitespace)
- ✅ Catches semantic aliases via embeddings
- ✅ Configurable precision via threshold tuning
- ⚠️ Embedding computation required for all entities
- ⚠️ Potential false merges at high thresholds

**Alternatives Considered:**
- **Exact match only:** Rejected (too many duplicates)
- **LLM for all:** Rejected (too expensive)
- **Edit distance only:** Rejected (misses semantic aliases)

---

## AD-05: Extensible Schema for User-Defined Types

**Status:** Accepted (New per ZAI-EVALUATION)
**Date:** 2026-01-26
**Context:**
- Original plan hardcoded entity types (person, org, repo, concept, tool, etc.)
- Users will want domain-specific types (APIEndpoint, Database, Service)
- Schema needs to evolve without migrations

**Decision:**
Add `kg_entity_types` and `kg_relationship_types` tables for user-defined types. Built-in types seeded by default, users can extend via config or CLI.

**Consequences:**
- ✅ Schema evolves without code changes
- ✅ Domain-specific customization
- ⚠️ Potential schema bloat (mitigate with 100-type limit)
- ⚠️ UI needs to handle dynamic types

**Alternatives Considered:**
- **Hardcoded types only:** Rejected (too inflexible)
- **Free-form types:** Rejected (no validation, UI chaos)

---

## AD-06: React Flow for Graph Visualization

**Status:** Accepted
**Date:** 2026-01-26 (Updated 2026-01-26)
**Context:**
- Need interactive graph visualization for knowledge graph exploration
- Graphs expected to be <1000 visible nodes for most use cases
- Want custom interactions (drag, zoom, click, mini-map navigation)
- Clawdbot's UI is React-based

**Decision:**
Use React Flow for all knowledge graph visualization. React Flow provides native React integration with built-in force-directed layout, interactive controls, and excellent TypeScript support.

**Consequences:**
- ✅ Native React integration (no wrapper layer needed)
- ✅ Excellent TypeScript support and documentation
- ✅ Built-in interactive features (drag, zoom, mini-map, controls)
- ✅ Active community (23K GitHub stars, 500K weekly NPM downloads)
- ✅ Optimized for <1000 visible nodes (typical knowledge graph size)
- ⚠️ Performance degrades above ~2000 visible nodes
- ⚠️ Requires React peer dependency (should be compatible with existing UI)

**Alternatives Considered:**
- **D3-force:** Rejected (lower-level API, more custom code needed)
- **Cytoscape.js:** Rejected (heavier, more complex for simple use cases)
- **AntV G6:** Rejected (better for very large graphs, but overkill for our needs)

**Migration Notes:**
- Current UI uses Lit web components
- React Flow can be integrated via web components bridge or partial React migration
- Reconsider if graph grows to >2000 visible nodes or 3D visualization needed

---

## AD-07: Playwright for JavaScript-Rendered Crawling (Opt-In)

**Status:** Accepted
**Date:** 2026-01-26
**Context:**
- Many modern docs sites use JavaScript rendering (React/SPA)
- Plain HTTP fetch returns empty shells
- Playwright already a dev dependency

**Decision:**
Default to HTTP fetch. Add `--js-render` flag to opt into Playwright rendering.

**Consequences:**
- ✅ No overhead for static sites
- ✅ Handles JS-rendered sites when needed
- ⚠️ Slower and heavier when JS rendering enabled
- ⚠️ Already have Playwright as dev dep (no new cost)

**Alternatives Considered:**
- **Always use Playwright:** Rejected (too slow for static sites)
- **Puppeteer:** Rejected (Playwright already in codebase)
- **No JS rendering:** Rejected (misses important docs)

---

## AD-08: Hybrid Retrieval with Confidence Thresholding

**Status:** Accepted (Modified per ZAI-EVALUATION)
**Date:** 2026-01-26
**Context:**
- Graph expansion can introduce noise (weakly connected entities)
- Need to balance structural context with retrieval quality
- Original plan had no filtering mechanism

**Decision:**
Add `minGraphScore` and `minConfidence` thresholds. Graph expansion skipped if results don't meet thresholds.

**Consequences:**
- ✅ Prevents low-quality graph results from polluting retrieval
- ✅ Configurable per-agent
- ⚠️ Requires tuning to find optimal thresholds
- ⚠️ May skip useful connections if threshold too high

**Alternatives Considered:**
- **No thresholding:** Rejected (noise risk)
- **Cross-encoder re-ranking:** Deferred to Phase 7 (adds complexity)

---

## AD-09: Temporal History Tables for Graph Evolution

**Status:** Accepted (New per ZAI-EVALUATION)
**Date:** 2026-01-26
**Context:**
- Original plan stored `first_seen`/`last_seen` but no history
- Users will want to query "how did this entity's connections change?"
- Need audit trail for consolidation merges

**Decision:**
Add `kg_entity_history` and `kg_relationship_history` tables tracking all events (created, merged, deleted, updated).

**Consequences:**
- ✅ Enables temporal queries
- ✅ Audit trail for debugging
- ⚠️ Additional storage overhead (~20%)
- ⚠️ Requires background cleanup job

**Alternatives Considered:**
- **No history:** Rejected (loss of valuable data)
- **Separate time-series DB:** Rejected (overkill)

---

## AD-10: Lazy Schema Migration on First Enable

**Status:** Accepted
**Date:** 2026-01-26
**Context:**
- Don't want to force graph tables on all users
- Knowledge feature is opt-in
- Want to keep database schema clean for users who don't use it

**Decision:**
Graph tables created only when `knowledge.enabled: true` first set. Existing users unaffected until opt-in.

**Consequences:**
- ✅ No schema pollution for non-users
- ✅ Backwards compatible
- ⚠️ Migration logic complexity

**Alternatives Considered:**
- **Add tables to all migrations:** Rejected (unnecessary bloat)
- **Separate database file:** Optional (available but not default)

---

## Pending Decisions

### PD-01: Cross-Encoder Re-Ranking

**Context:** Graph expansion results could be re-ranked with a cross-encoder for better relevance.

**Options:**
- Add in Phase 3 (with retrieval)
- Defer to Phase 7 (benchmarking phase)
- Skip entirely (thresholding sufficient)

**Status:** Deferred to Phase 7

---

### PD-02: Real-Time Graph Updates vs Batch

**Context:** Should graph updates happen immediately (per chunk) or batched (end of sync)?

**Options:**
- Immediate (more responsive, more DB writes)
- Batched (fewer DB writes, slight delay)

**Status:** Leaning toward batched for performance

---

## Deprecated Decisions

None yet.

---

## Decision Evolution

| AD | Original | Modified | Reason |
|----|----------|----------|--------|
| AD-05 | Hardcoded types | Extensible schema | ZAI-EVALUATION gap identified |
| AD-08 | No thresholding | Added thresholds | ZAI-EVALUATION noise risk |
| AD-09 | No history | Temporal tables | ZAI-EVALUATION gap identified |
