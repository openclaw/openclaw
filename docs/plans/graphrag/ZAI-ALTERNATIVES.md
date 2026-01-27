# GraphRAG Alternatives Analysis

**Purpose:** Document alternatives considered for major architectural choices and why they were/weren't selected.
**Use Case:** Reference when revisiting decisions or explaining "why didn't we use X?"

---

## Table of Contents

1. [Graph Storage Backends](#1-graph-storage-backends)
2. [Entity Extraction Approaches](#2-entity-extraction-approaches)
3. [Graph Query Engines](#3-graph-query-engines)
4. [Document Parsing Libraries](#4-document-parsing-libraries)
5. [Graph Visualization Libraries](#5-graph-visualization-libraries)
6. [Entity Deduplication Strategies](#6-entity-deduplication-strategies)
7. [Crawler Architectures](#7-crawler-architectures)
8. [Testing Strategies](#8-testing-strategies)

---

## 1. Graph Storage Backends

### Selected: **SQLite (default) + Neo4j (optional extension)**

| Alternative | Pros | Cons | Verdict |
|-------------|------|------|---------|
| **SQLite** | Zero infra, single file, per-agent DB, built-in | Limited to ~50K entities, no advanced algos | ✅ **Selected (default)** |
| **Neo4j** | Scales to millions, GDS library, Cypher queries | Requires separate server, operational overhead | ✅ **Selected (extension)** |
| **PostgreSQL + AGE** | SQL + graph in one DB, good for existing PG users | Additional infra, AGE less mature than Neo4j | ❌ Rejected |
| **RedisGraph** | Fast, in-memory, Redis already used | Project deprecated, limited persistence | ❌ Rejected |
| **ArangoDB** | Multi-model (doc + graph), built-in | Additional infra, less community support | ❌ Rejected |
| **TigerGraph** | Enterprise-scale, great performance | Heavy, costly, overkill for CLI tool | ❌ Rejected |
| **In-memory only** | Fastest, simplest | No persistence, lost on restart | ❌ Rejected |

### Decision Rationale

**SQLite chosen as default** because:
- Clawdbrain is already SQLite-based (memory index)
- Zero new infrastructure for CLI tool users
- Recursive CTEs handle 1-3 hops performantly up to ~50K entities
- Easy backup/migration (single file)

**Neo4j as optional extension** because:
- Users with 10K+ entities may need advanced algorithms
- GDS library provides community detection, PageRank, centrality
- Can be opt-in without affecting default experience

---

## 2. Entity Extraction Approaches

### Selected: **LLM with Delimiter-Based Prompts + Gleaning**

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| **LLM + delimiter prompts** | Model-agnostic, token-efficient, reliable | Custom parser, no schema validation | ✅ **Selected** |
| **LLM + JSON mode** | Structured, schema validation | Flaky across models, more tokens | ❌ Rejected |
| **LLM function calling** | Clean, structured | Not universally supported | ❌ Rejected |
| **Rule-based NER only** | Fast, cheap | Lower recall, no relationships | ❌ Rejected |
| **Hybrid (rule-based + LLM)** | Fast pass, LLM fallback | Added complexity | ⚠️ Phase 2+ |
| **spaCy NER** | Fast, trained models | Not code-aware, Python dep | ❌ Rejected |
| **Transformers NER** | Good accuracy, local models | Heavy dependency, slower | ❌ Rejected |

### Decision Rationale

**Delimiter-based LLM extraction** chosen because:
- Works reliably across OpenAI, Gemini, Anthropic, local models
- More token-efficient than JSON (important for cost)
- LightRAG validation (proven in production)

**Gleaning loop** added because:
- Consistently surfaces 10-20% additional entities
- Low marginal cost (one extra prompt per chunk)
- Proven technique from LightRAG

---

## 3. Graph Query Engines

### Selected: **graphology**

| Library | Pros | Cons | Verdict |
|---------|------|------|---------|
| **graphology** | Comprehensive, TS support, tested | Additional dependency | ✅ **Selected** |
| **ngraph.graph** | Fast, pagerank built-in | Fewer algorithms | ❌ Rejected |
| **Custom CTEs only** | Zero new deps | Reinventing wheel, ~500 LOC | ❌ Rejected |
| **NetworkX (Python)** | Comprehensive, proven | Python dep, not Node | ❌ Rejected |
| **igraph (WASM)** | Fast, comprehensive | WASM complexity | ❌ Rejected |

### Decision Rationale

**Graphology** chosen because:
- Production-proven (used by Sigma.js for large graphs)
- Excellent TypeScript support
- BFS, DFS, shortest path, PageRank, community detection
- Works with any storage backend (SQLite, Neo4j, in-memory)
- Reduces custom code by ~500 LOC

---

## 4. Document Parsing Libraries

### Selected: **pdfjs-dist + mammoth + @mozilla/readability**

| Format | Selected | Alternative | Why Not |
|--------|----------|-------------|---------|
| **PDF** | `pdfjs-dist` | `pdf-parse` | pdfjs already in deps, more robust |
| **DOCX** | `mammoth` | `docx`, `jszip` | mammoth simpler, MD output |
| **HTML** | `@mozilla/readability` + `linkedom` | `cheerio`, `jsdom` | Readability best for article extraction |
| **MD** | Native | N/A | No parsing needed |
| **TXT** | Native | N/A | No parsing needed |
| **JSON** | Custom flattener | `json2md` | Custom better for searchability |

### Decision Rationale

**pdfjs-dist** chosen over `pdf-parse` because:
- Already in `package.json` (line 194)
- More robust PDF handling (forms, annotations, embedded content)
- Mozilla-maintained (long-term viability)

**mammoth** chosen for DOCX because:
- Direct markdown output (no intermediate conversion)
- Preserves basic formatting (headings, lists, tables)
- Pure JS, no Word dependencies

**@mozilla/readability** chosen for HTML because:
- Best-in-class article extraction (strips nav/footer/ads)
- Already in dependencies (line 166)
- Works with linkedom (lightweight DOM, no JSDOM bloat)

---

## 5. Graph Visualization Libraries

### Selected: **D3-Force (primary) + Sigma.js (large graph fallback)**

| Library | Size | Best For | Verdict |
|---------|------|----------|---------|
| **D3-force** | ~30KB | <10K nodes, custom interactions | ✅ **Selected (primary)** |
| **Cytoscape.js** | ~100KB | Advanced layouts, rich graph features | ⚠️ Alternative |
| **Sigma.js** | ~50KB | 10K-100K nodes, WebGL rendering | ✅ **Selected (fallback)** |
| **Vis.js** | ~80KB | Simpler use cases | ❌ Less maintained |
| **G6 (AntV)** | ~200KB | React-heavy codebases | ❌ React-focused |
| **react-graph-vis** | ~150KB | React apps | ❌ React dependency |

### Decision Rationale

**D3-force** chosen as primary because:
- Industry standard, well-documented
- Works with Lit lifecycle (no React)
- Flexible for custom interactions (drag, zoom, click)
- ~30KB gzipped (reasonable for CLI tool)

**Sigma.js** added as fallback for:
- Graphs >10K nodes (D3 performance degrades)
- WebGL rendering (handles 100K+ nodes)
- Can swap at runtime based on graph size

**Not Cytoscape.js** because:
- 100KB is 3x larger than D3
- More opinionated (less flexibility)
- D3 sufficient for <10K graphs

---

## 6. Entity Deduplication Strategies

### Selected: **3-Tier Algorithm (Exact → Fuzzy → LLM)**

| Strategy | Precision | Recall | Cost | Verdict |
|----------|-----------|--------|------|---------|
| **Exact match only** | Very High | Low | $ | ❌ Too many duplicates |
| **Edit distance only** | High | Medium | $ | ❌ Misses semantic aliases |
| **Embedding similarity only** | Medium | High | $$ | ⚠️ Expensive |
| **LLM for all** | High | High | $$$ | ❌ Too expensive |
| **3-tier (exact → fuzzy → LLM)** | High | High | $$ | ✅ **Selected** |
| **Community detection** | Medium | High | $$$ | ❌ Overkill |

### Decision Rationale

**3-tier algorithm** balances cost and quality:

1. **Tier 1: Exact match** (MD5 hash)
   - Catches: "Auth Service" vs "auth service"
   - Cost: Negligible
   - Catches: ~60% of duplicates

2. **Tier 2: Embedding similarity** (cosine ≥0.92)
   - Catches: "Auth Service" vs "Authentication Service"
   - Cost: One embedding per entity
   - Catches: ~35% of remaining duplicates

3. **Tier 3: LLM confirmation** (0.88-0.92 band)
   - Resolves borderline cases
   - Cost: One LLM call per borderline pair
   - Catches: ~5% of remaining duplicates (opt-in)

**Alternative: Edit distance tier (1.5)** added per ZAI-EVALUATION:
- Catches typos: "Auth Service" vs "Authservce"
- Cost: Minimal
- Runs before embedding (cheaper filter)

---

## 7. Crawler Architectures

### Selected: **Multi-Mode (Single / Sitemap / Recursive) + Auth Support**

| Architecture | Best For | Complexity | Verdict |
|--------------|----------|------------|---------|
| **Single page fetch** | One-off docs | Low | ✅ **Selected** |
| **Sitemap-based** | Documentation sites | Medium | ✅ **Selected** |
| **Recursive BFS** | Deep site exploration | High | ✅ **Selected** |
| **Headless browser only** | JS-rendered sites | High | ⚠️ Opt-in |
| **Distributed crawler** | Large-scale crawling | Very High | ❌ Overkill |
| **API-based** | GitHub, Confluence, Notion | Medium | ⚠️ Future |

### Decision Rationale

**Multi-mode crawler** chosen because:
- Different use cases require different strategies
- Single mode: Quick one-off ingestion
- Sitemap mode: Complete doc site coverage
- Recursive mode: Deep exploration with depth limit

**HTTP fetch default, Playwright opt-in** because:
- Most docs are static (no JS rendering needed)
- Playwright adds 100ms+ overhead per page
- Already have Playwright as dev dependency

**Auth support added** because:
- Many valuable sources require authentication
- GitHub private repos, Confluence, Notion
- Bearer token, basic auth, custom headers

---

## 8. Testing Strategies

### Selected: **Unit + Integration + E2E + Benchmarking**

| Strategy | Coverage | Cost | Verdict |
|----------|----------|------|---------|
| **Unit tests only** | Isolated functions | Low | ❌ Misses integration bugs |
| **Integration tests only** | Component interactions | Medium | ❌ Misses edge cases |
| **E2E tests only** | Full pipeline | High | ❌ Slow, brittle |
| **Unit + Integration** | Good coverage | Medium | ⚠️ Acceptable |
| **Unit + Integration + E2E** | Excellent coverage | High | ✅ **Selected** |
| **+ Benchmarking** | Performance regression | Medium | ✅ **Selected** |

### Decision Rationale

**Comprehensive testing** strategy chosen because:

1. **Unit tests** (vitest)
   - Fast feedback during development
   - Cover extraction parsing, consolidation logic
   - ~70% coverage target

2. **Integration tests** (NEW per ZAI-EVALUATION)
   - Test graph consistency across pipeline
   - Verify consolidation re-points relationships
   - Check orphaned relationship cleanup
   - ~10% of total tests

3. **E2E tests** (vitest-e2e)
   - Full pipeline: chunk → extract → consolidate → query
   - Crawler end-to-end (fetch → parse → extract)
   - UI interaction tests (via Playwright)

4. **Benchmarking** (NEW per ZAI-EVALUATION)
   - Extraction throughput (chunks/second)
   - Graph query latency (1-hop, 2-hop, 3-hop)
   - D3 rendering FPS (1K, 10K nodes)
   - Regression tests in CI

**Why this matters:**
- Graph systems are complex (many moving parts)
- Consolidation bugs can corrupt graph integrity
- Performance degrades gradually (need benchmarks)
- Users expect reliable graph queries

---

## Summary: Key Trade-offs

| Dimension | Chosen Path | Trade-off |
|-----------|-------------|-----------|
| **Storage** | SQLite-first (pluggable) | Scale limited to ~50K entities before PostgreSQL migration |
| **Extraction** | Schema-based + delimiter fallback | Hybrid approach adds complexity |
| **Queries** | Graphology + CTEs | Memory-bound for large graphs |
| **Visualization** | React Flow | Optimized for <1000 visible nodes |
| **Deduplication** | 3-tier algorithm | Configurable thresholds require tuning |
| **Crawler** | HTTP-first, Playwright opt-in | JS rendering is slower |
| **Models** | Pluggable (OpenAI/Ollama/Gemini) | Abstraction layer adds minimal overhead |

---

## Revisiting Decisions

If any of these constraints change, revisit:

| Trigger | Reconsider |
|---------|------------|
| Graph >50K entities common | Neo4j as default |
| LLM costs prohibitive | Rule-based NER pre-pass |
| Need sub-second 3-hop queries | Neo4j or caching layer |
| UI framework changes to React | G6 or Cytoscape.js |
| Frequent typos in entities | Edit distance threshold tuning |
