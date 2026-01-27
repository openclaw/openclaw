# GraphRAG Implementation Phases

**Last Updated:** 2026-01-26
**Status:** Planning Complete

This directory contains implementation prompts for each phase of the GraphRAG feature.

---

## Overview

The GraphRAG implementation is organized into 7 phases:

| Phase | Name | Duration | Complexity | Status |
|-------|------|----------|------------|--------|
| 0 | Schema Validation & Ground Truth | 2-3 days | Low | ✅ Ready |
| 1 | Foundation (Graph Storage + Extraction) | 2 weeks | Medium | ✅ Ready |
| 2 | Ingestion + Web Crawler | 2 weeks | High | ✅ Ready |
| 3 | Hybrid Retrieval + Agent Tools | 1.5 weeks | Medium | ✅ Ready |
| 4 | Overseer Bridge | 1 week | Medium | ✅ Ready |
| 5 | Visualization + Gateway API | 2 weeks | High | ✅ Ready |
| 6 | Neo4j Extension (Optional) | 1 week | Low | ⏳ TODO |
| 7 | Testing + Benchmarking | 1 week | Medium | ⏳ TODO |

---

## Phase Summaries

### Phase 0: Schema Validation & Ground Truth

**Goal:** Validate extraction quality before building infrastructure.

**Tasks:**
1. [Test Corpus Creation](00-schema-validation/01-test-corpus-creation.md) - Create 10 diverse sample documents
2. [Manual Entity Extraction](00-schema-validation/02-manual-entity-extraction.md) - Create ground truth extraction
3. [Quality Metrics Definition](00-schema-validation/03-quality-metrics-definition.md) - Define precision/recall targets

**Exit Criteria:** Ground truth established, quality metrics defined, baseline measurable.

---

### Phase 1: Foundation (Graph Storage + Entity Extraction Core)

**Goal:** Schema, extraction engine, consolidation, basic graph queries.

**Tasks:**
1. [Datastore Interface](01-foundation/01-datastore-interface.md) - Pluggable SQLite/PostgreSQL abstraction
2. [Graph Schema Migrations](01-foundation/02-sqlite-migrations.md) - Extensible entity/relationship types
3. [Graph Query Engine](01-foundation/03-graph-query-engine.md) - graphology + recursive CTEs
4. [Model Abstraction](01-foundation/04-model-abstraction.md) - Pluggable LLM providers
5. [Hybrid Extractor](01-foundation/05-hybrid-extractor.md) - LLM extraction with delimiter fallback
6. [Entity Consolidation](01-foundation/06-entity-consolidation.md) - 3-tier deduplication

**Exit Criteria:** Entities/relationships extracted, consolidated, queried.

---

### Phase 2: Ingestion + Web Crawler (6 tasks)

**Goal:** File upload, document parsing, URL crawling, CLI commands.

**Tasks:**
1. [Ingestion Pipeline](02-ingestion-crawler/01-ingestion-pipeline.md) - File/text ingestion orchestrator
2. [Web Crawler](02-ingestion-crawler/02-web-crawler.md) - Multi-mode crawler orchestrator
3. [URL Discovery](02-ingestion-crawler/03-url-discovery.md) - Sitemap + BFS URL discovery
4. [HTTP Fetcher](02-ingestion-crawler/04-http-fetcher.md) - Rate limiting + retry logic
5. [Document Parsers](02-ingestion-crawler/05-document-parsers.md) - PDF, DOCX, HTML, Markdown parsers
6. [CLI Commands](02-ingestion-crawler/06-cli-commands.md) - ingest, crawl, reindex, list, remove

**Exit Criteria:** `clawdbot knowledge ingest` and `crawl` commands work.

---

### Phase 3: Retrieval + Agent Tools (4 tasks)

**Goal:** Graph-augmented search, new agent tools.

**Tasks:**
1. [Hybrid GraphRAG Retrieval](03-retrieval-tools/01-hybrid-graph-rag-retrieval.md) - Vector + graph expansion with confidence filtering
2. [Query Entity Recognizer](03-retrieval-tools/02-query-entity-recognizer.md) - Fast entity mention detection
3. [Context Formatter](03-retrieval-tools/03-context-formatter.md) - Structured context formatting for LLMs
4. [Knowledge Agent Tools](03-retrieval-tools/04-knowledge-agent-tools.md) - graph_search, graph_inspect, knowledge_ingest, knowledge_crawl

**Exit Criteria:** `memory_search` uses graph expansion, agent tools available.

---

### Phase 4: Overseer Bridge (4 tasks)

**Goal:** Goal-to-entity linking, dependency-aware planning.

**Tasks:**
1. [Overseer Bridge](04-overseer-bridge/01-overseer-bridge.md) - Main bridge orchestrator
2. [Entity Sync](04-overseer-bridge/02-entity-sync.md) - Goal/task entity synchronization
3. [Planner Injection](04-overseer-bridge/03-planner-injection.md) - Graph context for planning prompts
4. [Runner Integration](04-overseer-bridge/04-runner-integration.md) - Task runner integration with sync

**Exit Criteria:** Goals and tasks in graph, planner receives graph context.

---

### Phase 5: Visualization + Gateway API (3 tasks)

**Goal:** Graph explorer UI, gateway endpoints.

**Tasks:**
1. [React Flow Visualization](05-visualization-gateway/01-react-flow-visualization.md) - Interactive graph UI with force layout
2. [Gateway API](05-visualization-gateway/02-gateway-api.md) - REST endpoints for graph operations
3. [Ingestion Management UI](05-visualization-gateway/03-ingestion-management-ui.md) - File upload, crawl panel, source list

**Exit Criteria:** Graph explorer works, gateway API returns data, ingestion UI functional.

---

### Phase 6: Neo4j Extension (Optional)

**Goal:** Plugin for Neo4j backend for large deployments.

**Tasks:**
1. [Neo4j Extension](06-neo4j-extension/01-neo4j-extension.md) - Neo4j GraphQueryEngine impl

**Exit Criteria:** Neo4j backend works with all existing tests.

---

### Phase 7: Testing + Benchmarking

**Goal:** E2E tests, performance benchmarks, quality validation.

**Tasks:**
1. [E2E Graph Tests](07-testing-benchmarking/01-e2e-tests.md) - Graph integrity tests
2. [Benchmarks](07-testing-benchmarking/02-benchmarks.md) - Performance targets
3. [Quality Validation](07-testing-benchmarking/03-quality-validation.md) - Extraction metrics

**Exit Criteria:** All tests pass, benchmarks meet targets.

---

## How to Use These Documents

Each document is **self-contained** and includes:
- Complete task description
- Architecture decisions
- Implementation code
- Testing strategy
- Success criteria
- References to related documents

When implementing a task:
1. Read the full task document
2. Follow the implementation steps
3. Run the tests
4. Verify success criteria
5. Mark task complete

---

## Quick Reference

### Key Design Documents

- [ZAI-FINAL-DECISIONS.md](../plans/graphrag/ZAI-FINAL-DECISIONS.md) - Consolidated decisions
- [ZAI-DECISIONS.md](../plans/graphrag/ZAI-DECISIONS.md) - ADR records
- [ZAI-UPDATED-DESIGN.md](../plans/graphrag/ZAI-UPDATED-DESIGN.md) - Detailed architecture
- [ZAI-PLAN.md](../plans/graphrag/ZAI-PLAN.md) - Implementation roadmap

### Key Interfaces

```typescript
// Datastore
interface RelationalDatastore {
  query<T>(sql: string, params?: any[]): Promise<T[]>;
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  migrate(migrations: Migration[]): Promise<void>;
}

// Model
interface LanguageModel {
  chat(messages: ChatMessage[], options?: ModelConfig): Promise<string>;
  structuredChat<T>(messages: ChatMessage[], schema: z.Schema<T>): Promise<StructuredOutput<T>>;
  embed(text: string | string[]): Promise<number[][]>;
}

// Graph
interface GraphQueryEngine {
  getNeighborhood(entityId: string, options?: NeighborhoodQueryOptions): Promise<EntityNeighborhood>;
  findPath(fromId: string, toId: string): Promise<GraphPath | null>;
  getHubs(options?: HubQueryOptions): Promise<Entity[]>;
}
```

---

## Progress Tracking

**Total Implementation Tasks: 30**

| Phase | Tasks | Duration |
|-------|-------|----------|
| Phase 0 | 3 tasks | 2-3 days |
| Phase 1 | 6 tasks | 2 weeks |
| Phase 2 | 6 tasks | 2 weeks |
| Phase 3 | 4 tasks | 1.5 weeks |
| Phase 4 | 4 tasks | 1 week |
| Phase 5 | 3 tasks | 2 weeks |
| Phase 6 | 1 task (optional) | 1 week |
| Phase 7 | 3 tasks | 1 week |

**Total Duration:** 6-8 weeks (solo), 3-4 weeks (parallel)

---

## Contributing

When implementing tasks:
1. Follow existing code patterns (CLAUDE.md)
2. Run tests before committing
3. Update this README with status changes
4. Reference decision records (AD-XX) in commit messages

---

**Next:** Start with [Phase 0, Task 01](00-schema-validation/01-test-corpus-creation.md)
