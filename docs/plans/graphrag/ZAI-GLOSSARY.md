# GraphRAG Glossary

**Purpose:** Define key terms and concepts used throughout the GraphRAG documentation.
**Audience:** Developers, contributors, and users implementing or using GraphRAG features.

---

## Core Concepts

### Entity
A distinct node in the knowledge graph representing a real-world concept, person, organization, tool, or other extractable element.

**Examples:**
- "Auth Service" (concept)
- "Peter" (person)
- "GitHub" (org)
- "JWT" (tool)

**Fields:** `id`, `name`, `type`, `description`, `mentionCount`, `firstSeen`, `lastSeen`, `sourceFiles`

---

### Relationship
A directed edge between two entities representing a semantic connection.

**Examples:**
- Auth Service `depends_on` OAuth Provider
- Login Flow `part_of` Auth Service
- JWT `authored_by` Peter

**Fields:** `id`, `sourceEntityId`, `targetEntityId`, `type`, `description`, `keywords`, `weight`

---

### Knowledge Graph
A structured representation of entities and their relationships, stored in SQLite (default) or Neo4j (optional), enabling graph queries like neighborhood expansion and pathfinding.

---

### GraphRAG (Graph Retrieval-Augmented Generation)
An enhancement to traditional RAG that uses graph structure to improve retrieval. Instead of only vector/BM25 similarity search, GraphRAG expands results by including entities structurally connected to query matches.

---

### Entity Extraction (NER)
Named Entity Recognition: The process of identifying and classifying entities in unstructured text using LLM-driven prompts.

---

### Relationship Extraction
The process of identifying semantic connections between entities within text, capturing how entities relate to each other.

---

## Technical Terms

### Chunk
A segment of text (~400 tokens) from a larger document. Extraction runs on each chunk independently.

---

### Consolidation (Deduplication)
The process of merging duplicate entity mentions across chunks into canonical graph nodes. Uses a 3-tier algorithm: exact match → fuzzy match → LLM confirmation.

---

### Gleaning
A technique where the LLM is re-prompted with "you missed things" to surface additional entities/relationships. Proven to increase recall by 10-20%.

---

### Tier 1 Match
Exact match after normalization: lowercase, trim, collapse whitespace, MD5 hash.

---

### Tier 2 Match
Fuzzy match via embedding similarity. Cosine similarity ≥0.92 indicates likely duplicate.

---

### Tier 3 Match
LLM confirmation for borderline cases (similarity 0.88-0.92). Optional, opt-in.

---

### N-Hop Neighborhood
All entities reachable within N relationship traversals from a starting entity.

**Example:** 1-hop neighborhood of "Auth Service" includes OAuth Provider, User Model, Login Flow, Session Store (all directly connected).

---

### Shortest Path
The minimum number of relationship traversals required to connect two entities.

---

### Hub (High-Degree Node)
An entity with many connections (high degree). Often represents central concepts or frequently discussed topics.

---

### Centrality
A measure of node importance in a graph. Types include:
- **Degree centrality:** Number of connections
- **Betweenness centrality:** How often a node lies on shortest paths
- **PageRank:** Importance based on incoming link quality

---

### Community Detection
Algorithm that groups densely connected nodes into clusters. Useful for discovering topic groupings.

---

## Extraction Pipeline Terms

### Source
The origin of content being ingested. Types:
- `memory`: Existing memory files (MEMORY.md, memory/*.md)
- `manual`: User-uploaded documents (PDF, DOCX, etc.)
- `crawl`: Web-crawled content

---

### Ingestion
The process of bringing external content into the knowledge graph via file upload, text paste, or web crawling.

---

### Delta Sync
Only processing changed chunks since last sync, rather than re-processing everything.

---

### Backfill (Reindex)
Re-processing all existing content to extract entities, typically when enabling knowledge graph for the first time.

---

## Storage Terms

### kg_entities
SQLite table storing entity nodes. Fields: `entity_id`, `name`, `type`, `description`, `mention_count`, `first_seen`, `last_seen`, `source_files`, `metadata`

---

### kg_relationships
SQLite table storing relationship edges. Fields: `rel_id`, `source_entity_id`, `target_entity_id`, `type`, `description`, `keywords`, `weight`, `source_files`, `metadata`

---

### kg_entity_embeddings
SQLite table storing entity name embeddings for fuzzy matching and consolidation.

---

### kg_entity_history
Table tracking all entity events (created, merged, deleted, updated) for temporal queries.

---

### kg_relationship_history
Table tracking all relationship events for temporal queries and audit trails.

---

### kg_sources
Table tracking ingestion sources (files, URLs) with metadata and extraction results.

---

### Recursive CTE (Common Table Expression)
A SQL query pattern that references itself, enabling graph traversal (neighborhood expansion, pathfinding) in SQLite.

---

## Retrieval Terms

### Hybrid Search
Combined vector search (semantic similarity) + BM25 (keyword search) with configurable weights.

---

### Graph Expansion
Adding graph-sourced context to search results by expanding around entities mentioned in the query.

---

### Query Entity Recognition
Fast detection of entity mentions in a user query, using n-gram lookup (no LLM call) with embedding fallback.

---

### Graph Context Block
Structured, compact representation of graph entities and relationships added to LLM context. Format: entity names, types, relationships, weights, descriptions.

---

### Graph Proximity Score
Relevance score for graph-sourced chunks based on:
- Relationship weight (1-10)
- Hop distance (1-hop = 1.0x, 2-hop = 0.5x, 3-hop = 0.25x)
- Entity mention count

---

### Confidence Threshold
Minimum score required for graph-sourced results to be included in final output. Prevents low-quality noise.

---

## Crawler Terms

### Sitemap Mode
Crawl strategy that fetches `/sitemap.xml`, extracts all URLs, and processes each page.

---

### Recursive Mode
Crawl strategy that uses BFS (breadth-first search) from a seed URL, following links up to `maxDepth`.

---

### Robots.txt
Standard file that specifies crawler rules (allowed/disallowed paths, crawl-delay). Respect via `robotstxt` library.

---

### JS Rendering
Using a headless browser (Playwright) to execute JavaScript and render the final page content, necessary for SPA/React sites.

---

### Rate Limiting
Throttling crawl requests to avoid overwhelming target servers. Configurable via `requestsPerSecond`.

---

## Visualization Terms

### Force-Directed Layout
Graph visualization algorithm where nodes repel each other (charge) and edges pull connected nodes together (link distance), creating an organic layout.

---

### Virtualization
Rendering only visible nodes + 1-hop neighborhood, improving performance for large graphs.

---

### Web Worker
Background thread for running force simulation, preventing UI blocking during graph layout.

---

### D3-Force
D3.js force simulation library. Low-level API, requires custom code for graph-specific features.

---

### Sigma.js
WebGL-based graph rendering library. Handles 10K-100K nodes at 60 FPS, less flexible than D3.

---

## Overseer Integration Terms

### Goal Entity
A node in the knowledge graph representing an Overseer goal. Type: `goal`.

---

### Task Entity
A node in the knowledge graph representing an Overseer task or subtask. Type: `task`.

---

### Goal-Entity Linking
Automatic extraction of entity mentions from goal/problem statements, creating relationships between goals/tasks and entities.

---

### Dependency-Aware Planning
Overseer planner capability that queries the knowledge graph to discover implicit dependencies and existing goals before generating a plan.

---

## Configuration Terms

### KnowledgeConfig
Per-agent configuration block for knowledge graph features. Includes extraction, storage, retrieval, ingestion, and crawl settings.

---

### Entity Type
Classification of entities (person, org, repo, concept, tool, location, event, goal, task, file, custom). Extensible via `kg_entity_types` table.

---

### Relationship Type
Classification of relationships (uses, depends_on, authored_by, discussed_in, blocks, related_to, implements, references, part_of, scheduled_for). Extensible via `kg_relationship_types` table.

---

### Alias Merge Threshold
Cosine similarity threshold (default 0.92) above which two entity names are considered potential aliases.

---

### Max Hops
Maximum relationship traversal depth for graph expansion (default 1, max 3).

---

### Graph Weight
Contribution of graph-sourced results to final search score (default 0.3, range 0-1).

---

## Performance Terms

### Extraction Throughput
Chunks processed per second. Target: >5 chunks/second.

---

### Query Latency
Time to complete a graph query. Targets:
- 1-hop (1K entities): <5ms
- 2-hop (10K entities): <50ms
- 3-hop (50K entities): <300ms

---

### Rendering FPS
Frames per second for graph visualization. Targets:
- 1K nodes: 60 FPS
- 10K nodes: 30 FPS (with virtualization)

---

## Acronyms

| Acronym | Full Term |
|---------|-----------|
| ADR | Architecture Decision Record |
| APOC | Awesome Procedures on Cypher (Neo4j library) |
| BFS | Breadth-First Search |
| CTE | Common Table Expression (SQL) |
| DFS | Depth-First Search |
| E2E | End-to-End (testing) |
| FTS | Full-Text Search |
| GDS | Graph Data Science (Neo4j library) |
| JS | JavaScript |
| LLM | Large Language Model |
| LOC | Lines of Code |
| MD | Markdown |
| NER | Named Entity Recognition |
| PDF | Portable Document Format |
| RAG | Retrieval-Augmented Generation |
| SPA | Single-Page Application |
| SQL | Structured Query Language |
| TS | TypeScript |
| UI | User Interface |
| URL | Uniform Resource Locator |

---

## Related Documents

- [ZAI-EVALUATION.md](./ZAI-EVALUATION.md) - Comprehensive plan evaluation
- [ZAI-PLAN.md](./ZAI-PLAN.md) - Consolidated implementation plan
- [ZAI-DECISIONS.md](./ZAI-DECISIONS.md) - Architectural decision records
- [ZAI-ALTERNATIVES.md](./ZAI-ALTERNATIVES.md) - Alternatives analysis
