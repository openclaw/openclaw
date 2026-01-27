# GraphRAG Implementation Plan (Consolidated)

**Status:** Planning Phase
**Last Updated:** 2026-01-26
**Based On:** Original 10-component GraphRAG proposal + ZAI-EVALUATION.md

---

## Overview

This is a **consolidated implementation roadmap** that incorporates fixes from the evaluation phase. The plan maintains the original architecture while addressing critical gaps identified.

**Core Goal:** Add entity extraction, knowledge graph persistence, and GraphRAG retrieval to Clawdbrain using SQLite-first approach with optional Neo4j backend.

**Development Effort:** 6-8 weeks (solo), 3-4 weeks (parallel)

---

## Phase 0: Schema Validation & Ground Truth (NEW)

**Duration:** 2-3 days
**Complexity:** Low
**Goal:** Validate extraction quality before building infrastructure

### Tasks

1. **Create Test Corpus**
   - 10 sample documents: PDF, DOCX, MD, code files, HTML
   - Include: auth docs, API specs, design docs, meeting notes

2. **Manual Entity Extraction**
   - Create ground truth file: expected entities and relationships
   - Cover edge cases: aliases, typos, nested relationships

3. **Quality Metrics**
   - Define precision/recall targets
   - Establish false merge thresholds

### Deliverables

- `docs/plans/graphrag/test-corpus/`
- `src/knowledge/extraction/gold-standard.json`

---

## Phase 1: Graph Storage + Entity Extraction Core

**Duration:** 2 weeks
**Complexity:** Medium
**Goal:** Schema, extraction engine, consolidation, basic graph queries

### Files to Create

| File | Purpose | LOC Estimate |
|------|---------|--------------|
| `src/knowledge/graph/schema.ts` | SQLite graph tables + extensible types | ~200 |
| `src/knowledge/graph/types.ts` | Shared types | ~150 |
| `src/knowledge/graph/query.ts` | GraphQueryEngine (graphology + SQLite) | ~400 |
| `src/knowledge/extraction/extractor.ts` | LLM extraction pipeline | ~300 |
| `src/knowledge/extraction/parser.ts` | Delimiter + JSON output parsing | ~150 |
| `src/knowledge/extraction/prompts.ts` | Extraction prompt templates | ~100 |
| `src/knowledge/extraction/consolidation.ts` | 3-tier merge algorithm | ~300 |

### Files to Modify

| File | Change |
|------|--------|
| `src/memory/memory-schema.ts` | Add graph tables to `ensureMemoryIndexSchema()` |
| `src/memory/manager.ts` | Hook extraction into `syncFiles()` post-embedding |
| `src/agents/memory-search.ts` | Add knowledge config resolution |
| `src/config/types.agent-defaults.ts` | Add extensible `KnowledgeConfig` type |
| `src/config/zod-schema.agent-defaults.ts` | Add Zod validation |

### Dependencies to Add

```bash
pnpm add graphology        # Graph algorithms (BFS, DFS, PageRank)
pnpm add fast-levenshtein  # Edit distance for Tier 1.5 dedup
pnpm add robotstxt         # Robots.txt parser for crawler
```

### Schema Changes (Extensible Types)

**NEW tables** (addressing schema evolution gap):

```sql
-- User-definable entity types
CREATE TABLE IF NOT EXISTS kg_entity_types (
  name TEXT PRIMARY KEY,
  icon TEXT,
  color TEXT,
  parent_type TEXT REFERENCES kg_entity_types(name),
  created_at INTEGER NOT NULL
);

-- User-definable relationship types
CREATE TABLE IF NOT EXISTS kg_relationship_types (
  name TEXT PRIMARY KEY,
  direction TEXT,  -- "directed" | "undirected"
  weight_range TEXT,  -- "1-10" | "boolean"
  created_at INTEGER NOT NULL
);

-- Historical tracking for temporal queries
CREATE TABLE IF NOT EXISTS kg_entity_history (
  history_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  event TEXT NOT NULL,  -- "created" | "merged" | "deleted" | "updated"
  data TEXT,  -- JSON snapshot
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kg_relationship_history (
  history_id TEXT PRIMARY KEY,
  rel_id TEXT NOT NULL,
  event TEXT NOT NULL,
  data TEXT,
  timestamp INTEGER NOT NULL
);

-- Extraction progress for backfill
CREATE TABLE IF NOT EXISTS kg_extraction_progress (
  chunk_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,  -- "pending" | "processing" | "done" | "error"
  attempts INTEGER DEFAULT 0,
  last_attempt INTEGER,
  error_msg TEXT
);
```

### Exit Criteria

- Entities/relationships extracted from memory file chunks
- Entities deduplicated via exact + fuzzy + embedding match
- Graph query engine returns correct neighborhood, path, hub results
- All graph tables created alongside existing memory tables
- **NEW:** Schema supports user-defined types
- **NEW:** Temporal history tables created

---

## Phase 2: Manual Ingestion + Web Crawler (SWAPPED ORDER)

**Duration:** 2 weeks
**Complexity:** High
**Goal:** File upload, document parsing, URL crawling, CLI commands

**Why swapped with Phase 3:** Need real data to test retrieval quality

### Files to Create

| File | Purpose | LOC Estimate |
|------|---------|--------------|
| `src/knowledge/ingest.ts` | Ingestion pipeline orchestrator | ~250 |
| `src/knowledge/crawler.ts` | Web crawl orchestrator | ~300 |
| `src/knowledge/crawler-discovery.ts` | URL discovery (sitemap, BFS) | ~200 |
| `src/knowledge/crawler-fetcher.ts` | HTTP fetching with rate limiting | ~150 |
| `src/knowledge/parsers/pdf.ts` | PDF extraction (use pdfjs-dist) | ~100 |
| `src/knowledge/parsers/docx.ts` | DOCX to markdown | ~80 |
| `src/knowledge/parsers/html.ts` | HTML readability extraction | ~100 |
| `src/commands/knowledge.ts` | CLI commands | ~200 |

### Crawler: Auth Support (NEW)

**Add credential hooks:**

```typescript
type CrawlAuth = {
  type: "bearer" | "basic" | "custom";
  token?: string;
  username?: string;
  password?: string;
  headers?: Record<string, string>;
};

type CrawlTarget = {
  url: string;
  mode: "single" | "sitemap" | "recursive";
  auth?: CrawlAuth;  // NEW
  jsRender?: boolean;  // NEW: opt-in Playwright rendering
  // ... existing fields
};
```

### Dependencies to Add

```bash
# Use existing pdfjs-dist instead of pdf-parse
# pdfjs-dist already in package.json

pnpm add mammoth              # DOCX to markdown
# @mozilla/readability already exists
# linkedom already exists
pnpm add robotstxt            # NEW: robots.txt parsing
```

### CLI Commands

```
clawdbot knowledge ingest <path-or-url> [--tags tag1,tag2] [--agent <agentId>]
clawdbot knowledge ingest --text "inline content" [--tags tag1]
clawdbot knowledge crawl <url> [--mode single|sitemap|recursive] [--max-pages 100]
  [--auth bearer:TOKEN] [--js-render]  # NEW flags
clawdbot knowledge reindex --full  # NEW: backfill existing data
clawdbot knowledge list [--source memory|manual|crawl]
clawdbot knowledge remove <sourceId>
```

### Exit Criteria

- `clawdbot knowledge ingest` works with PDF, DOCX, MD, TXT files
- `clawdbot knowledge crawl` crawls single pages, sitemaps, recursive sites
- **NEW:** Crawler supports authenticated requests
- **NEW:** Crawler respects robots.txt (via robotstxt)
- Crawled/ingested content appears in knowledge graph
- CLI shows progress for long-running operations
- **NEW:** `knowledge reindex` command backfills existing data

---

## Phase 3: Hybrid GraphRAG Retrieval + Agent Tools

**Duration:** 1.5 weeks
**Complexity:** Medium
**Goal:** Graph-augmented search, new agent tools, enhanced `memory_search`

### Files to Create

| File | Purpose | LOC Estimate |
|------|---------|--------------|
| `src/knowledge/retrieval/graph-rag.ts` | Graph expansion retriever | ~250 |
| `src/knowledge/retrieval/query-entity-recognizer.ts` | Fast entity mention detection | ~150 |
| `src/knowledge/retrieval/context-formatter.ts` | Structured context formatting | ~100 |
| `src/agents/tools/knowledge-tools.ts` | graph_search, graph_inspect tools | ~200 |

### Graph Expansion: Noise Mitigation (NEW)

**Add confidence filtering:**

```typescript
type GraphExpansionConfig = {
  enabled: boolean;
  maxHops: number;
  weight: number;
  maxChunks: number;
  minGraphScore: number;  // NEW: threshold below which graph results ignored
  minConfidence: number;  // NEW: skip expansion if confidence too low
};
```

### Agent Tools

```typescript
// graph_search - entity-aware search
{
  name: "graph_search",
  description: "Search knowledge graph for entities and relationships",
  parameters: {
    query: Type.String(),
    entityType: Type.Optional(Type.String()),
    maxHops: Type.Optional(Type.Number({ minimum: 1, maximum: 3 })),
    maxResults: Type.Optional(Type.Number()),
  }
}

// graph_inspect - detailed entity info
{
  name: "graph_inspect",
  description: "Get detailed entity info with relationships and sources",
  parameters: {
    entityName: Type.String(),
    includeNeighborhood: Type.Optional(Type.Boolean()),
  }
}

// knowledge_ingest - self-ingest documents
{
  name: "knowledge_ingest",
  description: "Ingest a local file or raw text into knowledge graph",
  parameters: {
    path: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
    tags: Type.Optional(Type.Array(Type.String())),
  }
}

// knowledge_crawl - crawl documentation
{
  name: "knowledge_crawl",
  description: "Crawl a URL or documentation site",
  parameters: {
    url: Type.String(),
    mode: Type.Optional(Type.String()),
    maxPages: Type.Optional(Type.Number()),
    tags: Type.Optional(Type.Array(Type.String())),
  }
}
```

### Enhanced memory_search

```typescript
{
  name: "memory_search",
  parameters: {
    query: Type.String(),
    maxResults: Type.Optional(Type.Number()),
    minScore: Type.Optional(Type.Number()),
    useGraph: Type.Optional(Type.Boolean()),  // NEW: default true when graph enabled
    minGraphScore: Type.Optional(Type.Number()),  // NEW: confidence threshold
  }
}
```

### Exit Criteria

- `memory_search` transparently includes graph expansion results
- **NEW:** Low-confidence graph results filtered out
- `graph_search` and `graph_inspect` tools work end-to-end
- Graph context formatted as structured block in search results
- Agent tools registered conditionally based on config

---

## Phase 4: Overseer Bridge

**Duration:** 1 week
**Complexity:** Medium
**Goal:** Goal-to-entity linking, dependency-aware planning

### Files to Create

| File | Purpose | LOC Estimate |
|------|---------|--------------|
| `src/knowledge/overseer-bridge.ts` | Goal/task graph node sync | ~200 |

### Files to Modify

| File | Change |
|------|--------|
| `src/infra/overseer/planner.ts` | Inject graph context into planning prompt |
| `src/infra/overseer/store.types.ts` | Optional `entityIds` field on records |
| `src/infra/overseer/runner.ts` | Call bridge on lifecycle events |

### Exit Criteria

- Goals and tasks appear as nodes in knowledge graph
- Planner receives graph context about related entities and active goals
- Users can query "what goals reference entity X?"

---

## Phase 5: Web Visualization + Gateway API

**Duration:** 2 weeks
**Complexity:** High
**Goal:** Graph explorer UI, gateway endpoints, ingestion management

### Files to Create (UI)

| File | Purpose | LOC Estimate |
|------|---------|--------------|
| `ui/src/ui/pages/knowledge-graph.ts` | Graph explorer page | ~400 |
| `ui/src/ui/pages/knowledge-sources.ts` | Ingestion management | ~300 |
| `ui/src/ui/components/graph-renderer.ts` | D3-force rendering | ~350 |
| `ui/src/ui/components/entity-detail-panel.ts` | Entity detail sidebar | ~200 |
| `ui/src/ui/components/source-upload.ts` | File upload component | ~150 |
| `ui/src/ui/components/crawl-panel.ts` | Crawl launcher + progress | ~150 |

### Files to Create (Gateway)

| File | Purpose | LOC Estimate |
|------|---------|--------------|
| Gateway route handlers | `/api/knowledge/*` endpoints | ~200 |

### Dependencies to Add (ui/)

```bash
cd ui
pnpm add d3-force d3-selection d3-zoom d3-drag
# Optional for large graphs:
pnpm add sigma  # Only if >10K nodes expected
```

### Visualization: Performance at Scale (NEW)

**Implement:**

1. **Virtualization** - Only render visible + 1-hop neighborhood
2. **Web Workers** - Force simulation runs in background thread
3. **Large graph mode** - Server-side clustering for >10K nodes

```typescript
type GraphRenderMode = "interactive" | "large" | "clustered";

type GraphRenderConfig = {
  mode: GraphRenderMode;
  virtualization: boolean;
  webWorker: boolean;
  maxNodes: number;  // Switch modes above this threshold
};
```

### Gateway API Routes

```
GET  /api/knowledge/graph/stats
GET  /api/knowledge/graph/entities?type=&search=&limit=
GET  /api/knowledge/graph/entity/:entityId
GET  /api/knowledge/graph/entity/:entityId/neighborhood?hops=
GET  /api/knowledge/graph/relationships?sourceId=&targetId=
GET  /api/knowledge/graph/subgraph?entityIds=id1,id2,id3
GET  /api/knowledge/graph/sources
POST /api/knowledge/ingest
POST /api/knowledge/crawl
GET  /api/knowledge/crawl/:crawlId
```

### Exit Criteria

- Graph explorer renders with force layout
- Click, double-click, zoom, pan, drag work
- Filtering by entity type, relationship type, source, time range
- **NEW:** Virtualization enabled for >5K nodes
- **NEW:** Web Worker for force simulation
- Goal overlay toggle shows Overseer goals
- Ingestion management page supports file upload and crawl
- All gateway API endpoints return correct data

---

## Phase 6: Neo4j Extension (Optional)

**Duration:** 1 week
**Complexity:** Low
**Goal:** Plugin for Neo4j backend for large-scale deployments

### Files to Create

| File | Purpose | LOC Estimate |
|------|---------|--------------|
| `extensions/knowledge-neo4j/package.json` | Extension package | ~30 |
| `extensions/knowledge-neo4j/src/index.ts` | Neo4j GraphQueryEngine impl | ~200 |
| `extensions/knowledge-neo4j/src/cypher.ts` | Cypher query builders | ~150 |

### Optional: GDS/APOC Integration

**Document opt-in capabilities:**

```typescript
type Neo4jConfig = {
  uri: string;
  username: string;
  password: string;
  database?: string;
  gdsEnabled?: boolean;  // NEW: Use Graph Data Science library
  apocEnabled?: boolean;  // NEW: Use APOC procedures
};
```

### Exit Criteria

- Neo4j extension implements full `GraphQueryEngine` interface
- Configurable via `knowledge.graph.backend: "neo4j"`
- All existing tests pass with Neo4j backend
- **NEW:** GDS/APOC capabilities documented and opt-in

---

## Phase 7: Testing & Benchmarking (NEW)

**Duration:** 1 week
**Complexity:** Medium
**Goal:** E2E tests, performance benchmarks, quality validation

### Files to Create

| File | Purpose | LOC Estimate |
|------|---------|--------------|
| `src/knowledge/graph/integration.test.ts` | E2E graph integrity tests | ~200 |
| `src/knowledge/benchmark.ts` | Performance benchmarks | ~150 |
| `src/knowledge/quality-metrics.ts` | Extraction quality validation | ~100 |

### E2E Test Coverage (NEW)

```typescript
// Graph integrity tests
test("consolidation re-points relationships correctly");
test("self-loops removed after merge");
test("orphaned relationships cleaned after source deletion");
test("historical tracking preserves entity evolution");
test("schema survives entity type addition");
```

### Benchmark Targets

| Metric | Target |
|--------|--------|
| Extraction throughput | >5 chunks/second |
| 1-hop query (1K entities) | <5ms |
| 2-hop query (10K entities) | <50ms |
| 3-hop query (50K entities) | <300ms |
| D3 render (1K nodes) | 60 FPS |
| D3 render (10K nodes) | 30 FPS with virtualization |

### Exit Criteria

- All E2E tests pass
- Benchmarks meet targets
- Extraction precision/recall measured
- Performance regression tests in place

---

## Dependencies Summary

### Core Dependencies (root package.json)

```json
{
  "dependencies": {
    "graphology": "^0.25.4",
    "fast-levenshtein": "^3.0.0",
    "robotstxt": "^1.0.0",
    "mammoth": "^1.6.0"
  }
}
```

**Note:** `pdfjs-dist`, `@mozilla/readability`, `linkedom` already exist.

### UI Dependencies (ui/package.json)

```json
{
  "dependencies": {
    "d3-force": "^3.0.0",
    "d3-selection": "^3.0.0",
    "d3-zoom": "^3.0.0",
    "d3-drag": "^3.0.0",
    "sigma": "^3.0.0"  // Optional for large graphs
  }
}
```

---

## Configuration Schema (Updated)

```typescript
export type KnowledgeConfig = {
  enabled: boolean;

  entityExtraction: {
    enabled: boolean;
    entityTypes: EntityType[];
    relationshipTypes: string[];
    model?: string;
    gleaning: {
      enabled: boolean;
      passes: number;
    };
    consolidation: {
      aliasMergeThreshold: number;
      maxDescriptionFragments: number;
      editDistanceThreshold: number;  // NEW: for fast-levenshtein
    };
    batchSize: number;
    concurrency: number;
  };

  graph: {
    backend: "sqlite" | "neo4j";
    neo4j?: {
      uri: string;
      username: string;
      password: string;
      database?: string;
      gdsEnabled?: boolean;  // NEW
      apocEnabled?: boolean;  // NEW
    };
  };

  retrieval: {
    graphExpansion: {
      enabled: boolean;
      maxHops: number;
      weight: number;
      maxChunks: number;
      minGraphScore: number;  // NEW
      minConfidence: number;  // NEW
    };
  };

  ingestion: {
    allowedMimeTypes: string[];
    maxFileSizeMb: number;
  };

  crawl: {
    maxPagesPerCrawl: number;
    requestsPerSecond: number;
    respectRobotsTxt: boolean;
    userAgent: string;
    auth?: CrawlAuth;  // NEW
  };
};
```

---

## Migration Path

1. **Opt-in by default** (`knowledge.enabled: false`)
2. **Lazy schema migration** - Tables created on first enable
3. **Backfill command** - `clawdbot knowledge reindex --full`
4. **Separate database option** - Optional `knowledge.db`

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Schema bloat from user-defined types | Limit to 100 custom types, add validation |
| Crawler rate limits | Respect robots.txt + configurable delays |
| Graph expansion noise | `minGraphScore` threshold + re-ranking |
| D3 performance at scale | Virtualization + Web Workers + Sigma fallback |
| Extraction cost | Delta sync only + cheaper model option |
| Orphaned relationships | E2E tests + cleanup job |

---

## Success Criteria

Phase 1: Graph extraction working with extensible schema
Phase 2: Authenticated crawling + backfill capability
Phase 3: Graph retrieval with confidence filtering
Phase 4: Goal-entity linking operational
Phase 5: Interactive graph explorer with virtualization
Phase 6: Neo4j backend functional (optional)
Phase 7: All tests pass + benchmarks met
