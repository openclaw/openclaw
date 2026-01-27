# Knowledge Graph, Crawler, Memory & Embedding Systems Design

**Date:** 2026-01-26
**Purpose:** Complete system design for knowledge graph building, crawling, memory management, and embeddings
**Status:** Design Document

---

## Part 1: Architecture Overview

### System Boundaries

```
┌────────────────────────────────────────────────────────────────────────────┐
│                            CLAWDBOT                                     │
│                                                                             │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐           │
│  │  Ingestion Layer  │  │  Storage Layer   │  │  Retrieval Layer  │           │
│  │                  │  │                  │  │                  │           │
│  │ ┌──────────────┐ │  │ ┌──────────────┐ │ │ ┌──────────────┐ │           │
│  │ │Memory Files  │ │  │ │  SQLite      │ │  │ │ Vector Search│ │           │
│  │ │Manual Upload │ │  │ │  - Tables   │ │  │ │ FTS5 Search  │ │           │
│  │ │Web Crawler   │ │  │ │  - Vector   │ │  │ │ Hybrid Merge  │ │           │
│  │ │              │ │  │ │  - FTS5     │ │  │ │              │ │           │
│  │ └──────────────┘ │  │ │              │ │  │ └──────────────┘ │           │
│  └──────────────────┘  │  └──────────────┘  │ └──────────────────┘           │
│          │              │                  │              │              │
│          ▼              ▼                  ▼              ▼              │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │              Knowledge Graph Layer (New)                          │ │
│  │  ┌────────────────┐  ┌──────────────┐  ┌────────────────┐           │ │
│  │  │ Entity         │  │  Relationships │  │  Graph Query   │           │ │
│  │  │ Extraction    │  │              │  │  Engine        │           │ │
│  │  │               │  │  ┌──────────────┐ │  │               │           │ │
│  │  │ Consolidation  │  │  │ Entity Name  │ │  │ (SQLite CTEs   │           │ │
│  │  │               │  │  │ Embeddings   │ │  │               │           │ │
│  │  └────────────────┘  │  └──────────────┘ │  └────────────────┘           │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Design Principles

1. **Build on existing strengths** - Hybrid search, SQLite, provider abstraction
2. **Incremental adoption** - Knowledge graph is additive, not replacing
3. **Performance first** - No blocking operations, maintain sub-100ms search latency
4. **SQLite-native** - Use recursive CTEs before adding graph databases
5. **Optional Python** - For advanced AI/ML where Python ecosystem wins
6. **Fail-safe** - Graph degradation doesn't break core memory search

---

## Part 2: Knowledge Graph Building System

### 2.1 Entity Extraction Pipeline

**Location:** `src/knowledge/extraction/`

#### Architecture

```typescript
// extraction-pipeline.ts
export class ExtractionPipeline {
  async extractFromChunks(
    chunks: MemoryChunk[],
    options: ExtractionOptions
  ): Promise<ExtractionResult> {
    // Phase 1: Initial LLM extraction (delimiter-based)
    const initial = await this.llmExtract(chunks, options);

    // Phase 2: Gleaning loop (optional, 1-2 passes)
    const gleaned = options.gleaning.enabled
      ? await this.glean(chunks, initial)
      : initial;

    // Phase 3: Parse and structure
    const entities = this.parseExtraction(gleaned);

    // Phase 4: Consolidation (3-tier deduplication)
    const consolidated = await this.consolidate(entities);

    return consolidated;
  }

  private async llmExtract(chunks: MemoryChunk[], options: ExtractionOptions) {
    // Use existing provider abstraction
    const provider = this.resolveProvider(options.model);

    // Process in batches for efficiency
    const batches = this.chunkIntoBatches(chunks, options.batchSize);
    const results = [];

    for (const batch of batches) {
      const prompt = this.buildExtractionPrompt(batch, options);
      const response = await provider.complete(prompt);
      results.push(...this.parseDelimitedOutput(response));
    }

    return results.flat();
  }

  private buildExtractionPrompt(chunks: MemoryChunk[], options: ExtractionOptions): string {
    const entityTypes = options.entityTypes.join(', ');
    const relTypes = options.relationshipTypes.join(', ');

    let prompt = `Extract entities and relationships from the following text.

Entity types: ${entityTypes}
Relationship types: ${relTypes}

Output format (one per line):
  ("entity" | "<name>" | "<type>" | "<description>")
  ("relationship" | "<source>" | "<target>" | "<type>" | "<description>" | "<keywords>" | <strength 1-10>)

---`;

    for (const chunk of chunks) {
      prompt += `\n${chunk.text}\n---\n`;
    }

    prompt += `\nExtract ALL entities and relationships. Think carefully about implicit connections.`;

    return prompt;
  }

  private parseDelimitedOutput(raw: string): ParsedResult {
    const lines = raw.split('\n');
    const entities: ExtractedEntity[] = [];
    const relationships: ExtractedRelationship[] = [];

    for (const line of lines) {
      const entityMatch = line.match(/\("entity"\s*\|\s*"([^"]+)"\s*\|\s*"([^"]+)"\s*\|\s*"([^"]+)"/);
      if (entityMatch) {
        entities.push({
          name: entityMatch[1],
          type: entityMatch[2] as EntityType,
          description: entityMatch[3],
          sourceChunkIds: [],
        });
      }

      const relMatch = line.match(/\("relationship"\s*\|\s*"([^"]+)"\s*\|\s*"([^"]+)"\s*\|\s*"([^"]+)"\s*\|\s*"([^"]+)"\s*\|\s*"([^"]+)"\s*\|\|\s*(\d+)\)/);
      if (relMatch) {
        relationships.push({
          sourceName: relMatch[1],
          targetName: relMatch[2],
          type: relMatch[3],
          description: relMatch[4],
          keywords: relMatch[5].split(',').map(k => k.trim()),
          strength: parseInt(relMatch[6], 10),
        });
      }
    }

    return { entities, relationships };
  }
}
```

#### Extraction Configuration

```typescript
// config/types.agent-defaults.ts
export type KnowledgeConfig = {
  enabled: boolean;

  extraction: {
    enabled: boolean;
    entityTypes: EntityType[];
    relationshipTypes: string[];

    // Model selection (uses existing provider system)
    provider?: 'openai' | 'gemini' | 'local';
    model?: string;  // Override default model

    // Extraction quality
    gleaning: {
      enabled: boolean;
      passes: 0 | 1 | 2;  // 0 = none, 1 = one re-prompt, 2 = two
    };

    // Consolidation thresholds
    consolidation: {
      exactMatch: boolean;      // Always true
      fuzzyThreshold: number;  // 0.92 for embedding similarity
      editDistanceThreshold: number;  // 3 for fast-levenshtein
      llmConfirm: boolean;     // Borderline cases (0.88-0.92 band)
    };

    // Performance
    batchSize: number;        // Chunks per LLM call (default 5)
    concurrency: number;      // Parallel extraction calls (default 3)
    cacheExtracted: boolean;  // Cache extraction per chunk hash
  };
};
```

### 2.2 Entity Consolidation System

**Location:** `src/knowledge/consolidation/`

#### 3-Tier Consolidation

```typescript
// consolidator.ts
export class EntityConsolidator {
  async consolidate(
    entities: ExtractedEntity[],
    existingEntities: Map<string, ExtractedEntity>
  ): Promise<Map<string, ExtractedEntity>> {
    const result = new Map(existingEntities);

    // Sort by mention count (most mentioned first)
    const sortedEntities = entities.sort((a, b) => b.mentionCount - a.mentionCount);

    for (const entity of sortedEntities) {
      const normalized = this.normalizeName(entity.name);
      const hash = this.md5Hash(normalized);

      // Tier 1: Exact match
      const existing = result.get(hash);
      if (existing) {
        await this.mergeEntities(existing, entity);
        continue;
      }

      // Tier 1.5: Edit distance check (fast, no embedding)
      const editMatch = this.findEditDistanceMatch(entity.name, result);
      if (editMatch && options.consolidation.editDistanceThreshold <= 3) {
        await this.mergeEntities(editMatch, entity);
        continue;
      }

      // Tier 2: Embedding similarity
      const embedding = await this.embedEntityName(entity.name);
      const similar = this.findSimilarEmbedding(embedding, result);

      if (similar && similar.score >= options.consolidation.fuzzyThreshold) {
        // High confidence match
        await this.mergeEntities(similar.entity, entity);
        continue;
      }

      // Tier 3: LLM confirmation (optional)
      if (similar && similar.score >= 0.88 && options.consolidation.llmConfirm) {
        const confirmed = await this.llmConfirmSimilar(similar.entity, entity);
        if (confirmed) {
          await this.mergeEntities(similar.entity, entity);
          continue;
        }
      }

      // No match - add as new entity
      result.set(hash, entity);
    }

    return result;
  }

  private async mergeEntities(
    target: ExtractedEntity,
    source: ExtractedEntity
  ): Promise<void> {
    // Keep the longer/more descriptive name
    if (source.name.length > target.name) {
      target.name = source.name;
    }

    // Most frequent type wins
    const typeCounts = { [target.type]: 1, [source.type]: 1 };
    for (const mention of target.mentions) {
      typeCounts[mention.type] = (typeCounts[mention.type] || 0) + 1;
    }
    target.type = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0][0];

    // Merge descriptions (concatenate, then summarize if too long)
    const combined = `${target.description}\n\n${source.description}`;
    if (combined.length > 1000) {
      target.description = await this.summarizeDescription(combined);
    } else {
      target.description = combined;
    }

    // Merge metadata
    target.sourceChunkIds = [...new Set([...target.sourceChunkIds, ...source.sourceChunkIds])];
    target.sourceFiles = [...new Set([...target.sourceFiles, ...source.sourceFiles])];
    target.mentionCount += source.mentionCount;
    target.firstSeen = Math.min(target.firstSeen, source.firstSeen);
    target.lastSeen = Math.max(target.lastSeen, source.lastSeen);
  }

  private async llmConfirmSimilar(
    entityA: ExtractedEntity,
    entityB: ExtractedEntity
  ): Promise<boolean> {
    const prompt = `Are these the same entity?

A: "${entityA.name}" (${entityA.type})
B: "${entityB.name}" (${entityB.type})

Answer yes or no with a brief reason.`;

    const provider = this.resolveProvider();
    const response = await provider.complete(prompt);

    const normalized = response.toLowerCase().trim();
    return normalized.startsWith('yes') || normalized.includes('same');
  }
}
```

---

## Part 3: Web Crawler System

### 3.1 Crawler Architecture

**Location:** `src/knowledge/crawler/`

#### Design Decisions

1. **Node.js for crawling** - Playwright already in deps, better performance
2. **SQLite-backed job queue** - Simple, persistent, no Redis dependency
3. **Rate limiting per domain** - Respect robots.txt and configurable delays
4. **Progress tracking** - Real-time updates via existing progress system

#### Crawler Orchestrator

```typescript
// crawler/orchestrator.ts
export class CrawlerOrchestrator {
  private queue: CrawlQueue;
  private rateLimiter: RateLimiter;

  async crawl(options: CrawlOptions): Promise<CrawlResult> {
    // 1. Discovery phase
    const urls = await this.discoverUrls(options);

    // 2. Crawl phase
    const results = [];
    const progress = this.createProgressTracker(options.crawlId);

    for (const url of urls) {
      // Rate limiting
      await this.rateLimiter.throttle(url.domain);

      // Check robots.txt
      if (!await this.isAllowed(url)) {
        progress.skipped(url, 'robots.txt');
        continue;
      }

      // Fetch page
      const content = await this.fetchPage(url, options);

      // Process and extract
      const processed = await this.processContent(content, url, options);
      results.push(processed);

      // Update progress
      progress.completed(url);
    }

    return { results, stats: progress.getStats() };
  }

  private async discoverUrls(options: CrawlOptions): Promise<CrawlUrl[]> {
    switch (options.mode) {
      case 'single':
        return [{ url: options.url, depth: 0 }];

      case 'sitemap':
        return await this.discoverFromSitemap(options.url);

      case 'recursive':
        return await this.breadthFirstDiscovery(options);

      default:
        throw new Error(`Unknown crawl mode: ${options.mode}`);
    }
  }

  private async discoverFromSitemap(url: string): Promise<CrawlUrl[]> {
    const sitemapUrl = this.resolveSitemapUrl(url);
    const response = await fetch(sitemapUrl);
    const xml = await response.text();

    // Parse sitemap XML
    const urls = this.parseSitemap(xml);

    return urls.map(u => ({ url: u, depth: 0, domain: this.extractDomain(u) }));
  }

  private async breadthFirstDiscovery(options: CrawlOptions): Promise<CrawlUrl[]> {
    const visited = new Set<string>();
    const queue: CrawlUrl[] = [{ url: options.url, depth: 0 }];

    while (queue.length > 0 && queue.length < options.maxPages) {
      const current = queue.shift()!;

      if (visited.has(current.url)) continue;
      visited.add(current.url);

      if (current.depth >= options.maxDepth) continue;

      // Fetch and extract links
      const links = await this.extractLinks(current.url, options);

      for (const link of links) {
        if (!visited.has(link.url) && this.sameOrigin(current.url, link.url)) {
          queue.push({ ...link, depth: current.depth + 1 });
        }
      }
    }

    return Array.from(visited).map(url => ({ url, depth: 0, domain: this.extractDomain(url) }));
  }

  private async fetchPage(url: string, options: CrawlOptions): Promise<PageContent> {
    // Use Playwright for JS-rendered pages (opt-in)
    if (options.jsRender) {
      return await this.fetchWithPlaywright(url);
    }

    // Default: HTTP fetch
    const response = await fetch(url, {
      headers: options.auth ? { 'Authorization': `Bearer ${options.auth.token}` } : {},
    });

    const html = await response.text();
    return { url, html, headers: response.headers };
  }

  private async processContent(
    content: PageContent,
    url: string,
    options: CrawlOptions
  ): Promise<ProcessedDocument> {
    // Extract readable content
    const markdown = await this.htmlToMarkdown(content.html);

    // Chunk using existing memory chunker
    const chunks = await this.chunkMarkdown(markdown);

    // Extract metadata
    const metadata = this.extractMetadata(content);

    // If knowledge graph enabled, extract entities
    let entities: ExtractedEntity[] = [];
    let relationships: ExtractedRelationship[] = [];

    if (options.knowledgeExtraction.enabled) {
      const extractionResult = await this.extractionPipeline.extractFromChunks(chunks);
      entities = extractionResult.entities;
      relationships = extractionResult.relationships;
    }

    // Store in knowledge base
    const sourceId = await this.storeInKnowledgeBase({
      url,
      content: markdown,
      metadata,
      chunks,
      entities,
      relationships,
    });

    return { sourceId, chunks: chunks.length, entities: entities.length };
  }
}
```

#### Robots.txt Handler

```typescript
// crawler/robots.ts
import { parse } from 'robots-txt-parser';
import { readFile } from 'fs/promises';

export class RobotsHandler {
  private cache: Map<string, RobotsTxt> = new Map();

  async isAllowed(url: string): Promise<boolean> {
    const domain = this.extractDomain(url);
    const robotsUrl = `${domain}/robots.txt`;

    let robots = this.cache.get(domain);
    if (!robots) {
      try {
        const response = await fetch(robotsUrl);
        const content = await response.text();
        robots = parse(content);
        this.cache.set(domain, robots);
      } catch {
        // If robots.txt fetch fails, allow crawling
        return true;
      }
    }

    const path = this.extractPath(url);
    return robots.isAllowed(path);
  }
}
```

---

## Part 4: Enhanced Memory Management

### 4.1 Memory Schema Extensions

**Current:** Extend existing `chunks` table

```sql
-- Add graph provenance to chunks
ALTER TABLE chunks ADD COLUMN entity_ids TEXT;  -- JSON array
ALTER TABLE chunks ADD COLUMN extraction_id TEXT; -- Link to extraction job

-- Entity name embeddings for fuzzy matching
CREATE TABLE IF NOT EXISTS kg_entity_names (
  entity_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  embedding BLOB NOT NULL,  -- float32 array from sqlite-vec
  model TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE kg_entity_names_vec USING sqlite_vec(
  embedding(kg_entity_names.embedding)
);
```

### 4.2 Memory Graph Queries

```typescript
// memory/graph-query.ts
export class MemoryGraphQuery {
  constructor(private db: Database) {}

  async findEntitiesByChunk(chunkId: string): Promise<Entity[]> {
    const row = this.db.prepare('SELECT entity_ids FROM chunks WHERE id = ?').get(chunkId);
    if (!row?.entity_ids) return [];

    const entityIds = JSON.parse(row.entity_ids);
    const placeholders = entityIds.map(() => '?').join(',');

    const stmt = this.db.prepare(`
      SELECT * FROM kg_entities
      WHERE entity_id IN (${placeholders})
    `);

    return stmt.all(...entityIds);
  }

  async getEntityNeighborhood(
    entityId: string,
    maxHops: number = 1,
    limit: number = 50
  ): Promise<GraphNeighborhood> {
    const stmt = this.db.prepare(`
      WITH RECURSIVE neighborhood(entity_id, depth) AS (
        SELECT ? AS entity_id, 0 AS depth
        UNION ALL
        SELECT
          CASE
            WHEN r.source_entity_id = n.entity_id THEN r.target_entity_id
            ELSE r.source_entity_id
          END,
          n.depth + 1
        FROM neighborhood n
        JOIN kg_relationships r
          ON r.source_entity_id = n.entity_id OR r.target_entity_id = n.entity_id
        WHERE n.depth < ?
      )
      SELECT DISTINCT e.*
      FROM neighborhood n
      JOIN kg_entities e ON e.entity_id = n.entity_id
      ORDER BY n.depth, e.mention_count DESC
      LIMIT ?
    `);

    const entities = stmt.all(entityId, maxHops, limit);

    // Get relationships
    const entityIds = entities.map(e => e.entity_id);
    const relStmt = this.db.prepare(`
      SELECT r.*
      FROM kg_relationships r
      WHERE r.source_entity_id IN (${Array(entityIds).fill('?').join(',')})
        OR r.target_entity_id IN (${Array(entityIds).fill('?').join(',')})
    `);

    const relationships = relStmt.all(...entityIds);

    return { entities, relationships };
  }
}
```

### 4.3 Hybrid Graph-Vector Search

```typescript
// memory/graph-aware-search.ts
export class GraphAwareSearchManager extends MemorySearchManager {
  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    // Phase 1: Existing hybrid search
    let results = await super.search(query, options);

    // Phase 2: Extract entities from query
    const entities = await this.extractQueryEntities(query);

    // Phase 3: Graph expansion (if entities found)
    if (entities.length > 0 && options.useGraph) {
      const graphResults = await this.expandWithGraph(entities, options);
      results = this.mergeGraphResults(results, graphResults);
    }

    return results;
  }

  private async expandWithGraph(
    entities: Entity[],
    options: SearchOptions
  ): Promise<SearchResult[]> {
    const graphNeighborhoods = await Promise.all(
      entities.map(e => this.graphQuery.getNeighborhood(e.id, {
        maxHops: options.graphMaxHops || 1,
        limit: options.graphMaxChunks || 4
      }))
    );

    // Convert graph results to search results
    const graphResults: SearchResult[] = [];

    for (const neighborhood of graphNeighborhoods) {
      for (const entity of neighborhood.entities) {
        // Get source chunks for this entity
        const entityChunks = await this.getChunksForEntity(entity.id);

        for (const chunk of entityChunks) {
          // Score based on relationship weight and hop distance
          const score = this.computeGraphScore({
            queryEntityWeight: this.getEntityWeightInQuery(entity, entities),
            hopDistance: 1, // TODO: track hop distance
            relationshipWeight: this.getAvgRelationshipWeight(entity, neighborhood.relationships),
            mentionCount: entity.mentionCount,
          });

          graphResults.push({
            path: chunk.path,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            snippet: chunk.snippet,
            score: score,
            source: 'graph-expansion',
          });
        }
      }
    }

    return graphResults;
  }

  private computeGraphScore(params: GraphScoreParams): number {
    const baseScore = params.queryEntityWeight * 0.3;
    const hopPenalty = params.hopDistance === 1 ? 1 : 0.5;
    const relationshipBoost = Math.min(params.relationshipWeight / 10, 1);
    const mentionBoost = Math.min(params.mentionCount / 50, 1);

    return baseScore * hopPenalty * (0.7 + 0.3 * relationshipBoost) * (0.8 + 0.2 * mentionBoost);
  }
}
```

---

## Part 5: Enhanced Embedding System

### 5.1 Multi-Modal Embeddings

**Current:** Text-only embeddings

**Enhanced:** Support for code, images, tables

```typescript
// embeddings/multi-modal.ts
export class MultiModalEmbeddingProvider implements EmbeddingProvider {
  async embedDocument(content: ProcessedDocument): Promise<DocumentEmbedding> {
    const embeddings = {
      text: await this.embedText(content.fullText),
      code: await this.embedCodeBlocks(content.codeBlocks),
      tables: await this.embedTables(content.tables),
      images: await this.embedImages(content.images),  // Optional, CLIP model
    };

    return embeddings;
  }

  private async embedText(text: string): Promise<number[]> {
    // Use existing provider
    return await this.provider.embedQuery(text);
  }

  private async embedCodeBlocks(blocks: CodeBlock[]): Promise<Map<string, number[]>> {
    // Use code-aware embedding model (optional)
    // Could use sentence-transformers with code model
    return new Map(blocks.map(b => [b.id, await this.provider.embedQuery(b.code)]));
  }
}
```

### 5.2 Contextual Embeddings

**Purpose:** Improve retrieval by embedding with entity context

```typescript
// embeddings/contextual.ts
export class ContextualEmbeddingService {
  async embedWithContext(chunk: MemoryChunk, context: EntityContext): Promise<number[]> {
    const baseEmbedding = await this.provider.embedQuery(chunk.text);

    if (!context.entities.length) {
      return baseEmbedding;
    }

    // Enhance with entity presence
    const entitySignals = this.encodeEntityPresence(context.entities);

    // Combine base embedding with entity signals
    const contextualEmbedding = this.combineEmbeddings(baseEmbedding, entitySignals);

    return contextualEmbedding;
  }

  private encodeEntityPresence(entities: Entity[]): number[] {
    // Create entity presence vector (same dimension as embeddings)
    // Could use learned mapping or simple averaging
    const presenceVector = new Array(this.embeddingDim).fill(0);

    for (const entity of entities) {
      const entityEmbedding = await this.getEntityEmbedding(entity.name);
      for (let i = 0; i < this.embeddingDim; i++) {
        presenceVector[i] += entityEmbedding[i] * entity.weight;
      }
    }

    // Normalize
    const norm = Math.sqrt(presenceVector.reduce((sum, val) => sum + val * val, 0));
    return presenceVector.map(v => v / norm);
  }
}
```

### 5.3 Embedding Cache Strategy

**Current:** Cache by (provider, model, text hash)

**Enhanced:** Hierarchical caching

```sql
-- Multi-level caching
CREATE TABLE embedding_cache_v2 (
  cache_key TEXT PRIMARY KEY,  -- composite key
  cache_level TEXT NOT NULL,  -- 'query' | 'chunk' | 'document' | 'entity'
  embedding BLOB NOT NULL,
  dims INTEGER NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  access_count INTEGER DEFAULT 1,
  last_accessed INTEGER NOT NULL
);

CREATE INDEX idx_embedding_cache_level ON embedding_cache_v2(cache_level, created_at);
```

```typescript
// embeddings/hierarchical-cache.ts
export class HierarchicalEmbeddingCache {
  async get(key: CacheKey, level: CacheLevel): Promise<number[] | null> {
    const stmt = this.db.prepare(`
      SELECT embedding, dims FROM embedding_cache_v2
      WHERE cache_key = ? AND cache_level = ?
      AND last_accessed > ?  -- TTL check
    `);

    const result = stmt.get(key.composite(), level, Date.now() - this.ttl(level));

    if (result) {
      // Update access count
      this.updateAccess(key.composite(), level);
      return result.embedding;
    }

    return null;
  }

  async set(key: CacheKey, level: CacheLevel, embedding: number[]): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO embedding_cache_v2
      (cache_key, cache_level, embedding, dims, model, provider, created_at, last_accessed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      key.composite(),
      level,
      new Uint8Array(new Float32Array(embedding).buffer),
      embedding.length,
      this.currentModel,
      this.currentProvider,
      Date.now(),
      Date.now()
    );
  }
}

enum CacheLevel {
  Query = 'query',        // Single query string
  Chunk = 'chunk',        // Single chunk content
  Document = 'document',  // Full document (all chunks)
  Entity = 'entity',       // Entity with context
}
```

---

## Part 6: Integration with Existing Systems

### 6.1 CLI Commands

```bash
# Knowledge management
clawdbot knowledge stats                    # Show graph statistics
clawdbot knowledge search <query>            # Graph-aware search
clawdbot knowledge entities <name>            # Inspect entity
clawdbot knowledge reindex [--full]           # Re-extract all content

# Crawling
clawdbot knowledge crawl <url>                   # Crawl URL
clawdbot knowledge crawl-status <crawlId>        # Check crawl status
clawdbot knowledge ingest <file>                 # Ingest document

# Configuration
clawdbot config set knowledge.enabled true    # Enable knowledge graph
clawdbot config set knowledge.extraction.model gpt-4.1-mini
```

### 6.2 Agent Tools

```typescript
// agents/tools/knowledge-tools.ts
export const knowledgeTools = [
  {
    name: 'knowledge_search',
    description: 'Search knowledge graph with entity awareness',
    parameters: {
      query: { type: 'string' },
      useGraph: { type: 'boolean', default: true },
      maxHops: { type: 'number', default: 1 },
    },
  },
  {
    name: 'knowledge_inspect',
    description: 'Get detailed information about an entity',
    parameters: {
      entityName: { type: 'string' },
      includeNeighborhood: { type: 'boolean', default: true },
    },
  },
  {
    name: 'knowledge_ingest',
    description: 'Ingest a document into knowledge base',
    parameters: {
      path: { type: 'string' },
      text: { type: 'string' },
      extractEntities: { type: 'boolean', default: true },
    },
  },
];
```

---

## Part 7: Performance Optimizations

### 7.1 Incremental Extraction

**Strategy:** Only extract from changed chunks

```sql
-- Track extraction per chunk
CREATE TABLE kg_extraction_status (
  chunk_id TEXT PRIMARY KEY REFERENCES chunks(id),
  extraction_id TEXT NOT NULL,
  extracted_at INTEGER NOT NULL,
  entity_count INTEGER,
  relationship_count INTEGER,
  checksum TEXT,  -- Hash of extracted data
  status TEXT  -- 'pending' | 'done' | 'failed'
);
```

```typescript
// extraction/incremental.ts
export class IncrementalExtractor {
  async extractFromChunks(chunks: MemoryChunk[]): Promise<void> {
    for (const chunk of chunks) {
      const status = await this.getExtractionStatus(chunk.id);

      const currentHash = this.computeContentHash(chunk);

      if (status?.checksum === currentHash && status?.status === 'done') {
        continue;  // Already extracted, content unchanged
      }

      // Perform extraction
      const result = await this.extractor.extractFromChunk(chunk);

      // Store results
      await this.storeExtractionResult(chunk.id, result);
    }
  }
}
```

### 7.2 Background Extraction Queue

```typescript
// extraction/queue.ts
export class BackgroundExtractionQueue {
  private queue: PQueue<ExtractionJob>;

  constructor() {
    this.queue = new PQueue({
      concurrency: 3,  // Max parallel extractions
      interval: 1000,  // Poll interval
      autoStart: true,
    });

    // Worker
    this.queue.addWorker(async (job: ExtractionJob) => {
      await this.processJob(job);
    });
  }

  async enqueueChunk(chunk: MemoryChunk): Promise<void> {
    await this.queue.add({
      type: 'chunk',
      chunk,
      priority: 'normal',
    });
  }
}
```

### 7.3 Graph Query Optimization

```sql
-- Materialized view for common queries
CREATE TABLE kg_entity_cache AS
SELECT
  e.entity_id,
  e.name,
  e.type,
  e.description,
  e.mention_count,
  COUNT(DISTINCT r.source_entity_id || r.target_entity_id) as degree
FROM kg_entities e
LEFT JOIN kg_relationships r
  ON e.entity_id = r.source_entity_id OR e.entity_id = r.target_entity_id
GROUP BY e.entity_id;

-- Refresh triggers
CREATE TRIGGER kg_entity_cache_refresh AFTER INSERT ON kg_entities
BEGIN
  INSERT OR REPLACE INTO kg_entity_cache
  SELECT * FROM kg_entities WHERE entity_id = NEW.entity_id;
END;

CREATE TRIGGER kg_entity_cache_refresh AFTER UPDATE ON kg_entities
BEGIN
  INSERT OR REPLACE INTO kg_entity_cache
  SELECT * FROM kg_entities WHERE entity_id = NEW.entity_id;
END;
```

---

## Part 8: Configuration Examples

### 8.1 Minimal Configuration

```yaml
# config.yaml
agents:
  defaults:
    knowledge:
      enabled: true
      extraction:
        enabled: true
        provider: openai
        model: gpt-4.1-mini
        gleaning:
          enabled: true
          passes: 1
        batchSize: 5
      consolidation:
        fuzzyThreshold: 0.92
        editDistanceThreshold: 3
      retrieval:
        graphExpansion:
          enabled: true
          maxHops: 1
          maxChunks: 4
          minGraphScore: 0.3
```

### 8.2 Advanced Configuration

```yaml
agents:
  defaults:
    knowledge:
      enabled: true
      extraction:
        enabled: true
        provider: openai
        model: gpt-4o
        entityTypes:
          - person
          - org
          - concept
          - tool
          - repo
          - file
        relationshipTypes:
          - uses
          - depends_on
          - implements
          - references
          - related_to
        gleaning:
          enabled: true
          passes: 2
        batchSize: 10
        concurrency: 5
      consolidation:
        fuzzyThreshold: 0.90
        llmConfirm: true
        maxDescriptionFragments: 6
      retrieval:
        graphExpansion:
          enabled: true
          maxHops: 2
          maxChunks: 8
          minGraphScore: 0.4
          weight: 0.3
      crawl:
        maxPagesPerCrawl: 500
        requestsPerSecond: 3
        respectRobotsTxt: true
        userAgent: "Clawdbot-Knowledge/1.0"
        jsRender: false
        concurrency: 5
```

---

## Part 9: Error Handling & Edge Cases

### 9.1 Extraction Failures

```typescript
// extraction/error-handling.ts
export class ExtractionErrorHandler {
  async handleExtractionFailure(
    chunk: MemoryChunk,
    error: Error
  ): Promise<ExtractionResult> {
    // Log error but don't fail entire sync
    logger.warn(`Extraction failed for chunk ${chunk.id}: ${error.message}`);

    // Return empty result - don't block memory sync
    return {
      entities: [],
      relationships: [],
      errors: [error.message],
    };
  }

  async retryWithFallback(
    chunk: MemoryChunk,
    maxAttempts: number = 3
  ): Promise<ExtractionResult> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.extractor.extractFromChunk(chunk);
      } catch (error) {
        if (attempt === maxAttempts) {
          // Last attempt failed, try simpler model
          return await this.extractWithSimplerModel(chunk);
        }
        await this.backoff(attempt);
      }
    }
  }
}
```

### 9.2 Crawler Robustness

```typescript
// crawler/resilience.ts
export class ResilientCrawler {
  async crawlWithRetry(url: string, options: CrawlOptions): Promise<CrawlResult> {
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.crawl(url, options);
      } catch (error) {
        if (this.isRecoverable(error)) {
          await this.backoff(attempt * 1000);
          continue;
        }

        // Unrecoverable error
        throw error;
      }
    }

    throw new Error(`Failed to crawl ${url} after ${maxRetries} attempts`);
  }

  private isRecoverable(error: Error): boolean {
    // Network errors, timeouts, rate limits - recoverable
    // Parse errors, invalid URLs - not recoverable
    const recoverablePatterns = [
      /ETIMEDOUT/,
      /ECONNREFUSED/,
      /rate limit/i,
      /timeout/i,
    ];

    return recoverablePatterns.some(pattern => pattern.test(error.message));
  }
}
```

---

## Part 10: Monitoring & Observability

### 10.1 Metrics to Track

```typescript
// knowledge/metrics.ts
export class KnowledgeMetrics {
  // Extraction metrics
  extractionDuration: Histogram;
  extractionSuccessRate: Gauge;
  extractionEntityCount: Histogram;
  extractionRelationshipCount: Histogram;

  // Graph metrics
  graphEntityCount: Gauge;
  graphRelationshipCount: Gauge;
  graphCacheHitRate: Gauge;
  graphQueryLatency: Histogram;

  // Crawler metrics
  crawlDuration: Histogram;
  crawlPagesCrawled: Counter;
  crawlErrors: Counter;
  crawlRateLimitHits: Counter;

  // Storage metrics
  storageDbSize: Gauge;
  storageEmbeddingCacheSize: Gauge;
}
```

### 10.2 Health Checks

```typescript
// knowledge/health.ts
export class KnowledgeHealthCheck {
  async health(): Promise<HealthStatus> {
    const checks: HealthCheck[] = [
      {
        name: 'extraction_service',
        status: await this.checkExtractionService(),
      },
      {
        name: 'graph_database',
        status: await this.checkGraphTables(),
      },
      {
        name: 'entity_embeddings',
        status: await this.checkEmbeddingIndex(),
      },
      {
        name: 'crawler_queue',
        status: await this.checkCrawlerQueue(),
      },
    ];

    const overall = checks.every(c => c.status === 'healthy')
      ? 'healthy'
      : 'degraded';

    return { status: overall, checks };
  }
}
```

---

## Part 11: Migration Path

### Phase 1: Schema & Storage (Week 1)

1. Add graph tables to `ensureMemoryIndexSchema()`
2. Create migration script for existing data
3. Add embedding cache table
4. Update file watching hooks

### Phase 2: Extraction Pipeline (Week 2)

1. Implement `ExtractionPipeline` class
2. Add LLM extraction with gleaning
3. Implement 3-tier consolidation
4. Add unit tests

### Phase 3: Crawler System (Week 3)

1. Implement `CrawlerOrchestrator`
2. Add robots.txt handler
3. Implement progress tracking
4. Add CLI commands

### Phase 4: Graph Search Integration (Week 4)

1. Extend `MemorySearchManager` with graph awareness
2. Implement graph expansion
3. Add `GraphAwareSearchManager`
4. Update agent tools

### Phase 5: Python Service (Optional, Week 5-6)

1. Create FastAPI service for advanced features
2. Move entity extraction to Python (if beneficial)
3. Implement graph algorithms (community detection)
4. Add reranking service

### Phase 6: Testing & Refinement (Week 7)

1. Add E2E tests
2. Performance benchmarks
3. Load testing
4. Documentation

---

## Part 12: Key Design Decisions

### Decision 1: SQLite-First Graph Storage

**Choice:** Use SQLite recursive CTEs for graph queries

**Rationale:**
- No additional infrastructure
- Proven performance up to 50K entities
- Consistent with existing memory system
- Optional Neo4j extension for scale

**Trade-offs:**
- Max 3-hop queries at scale
- No built-in graph algorithms
- Can add Python service for advanced features

### Decision 2: Delimiter-Based LLM Extraction

**Choice:** Delimiter format over JSON mode

**Rationale:**
- More token-efficient
- Works reliably across models
- Easier to parse
- Proven pattern from LightRAG

**Trade-offs:**
- Custom parser required
- No schema validation at parse time

### Decision 3: Node.js for Crawling

**Choice:** Node.js with Playwright for crawling

**Rationale:**
- Playwright already in dependencies
- Better HTTP performance
- Easier integration with existing code

**Trade-offs:**
- Python has better HTML parsing libraries (but Node.js is sufficient)
- JS rendering requires Playwright either way

### Decision 4: Incremental Extraction

**Choice:** Extract only from changed chunks

**Rationale:**
- Reduces LLM costs
- Faster sync cycles
- Easier debugging

**Trade-offs:**
- Need extraction status tracking
- May miss implicit changes

### Decision 5: Optional Graph Expansion

**Choice:** Add graph expansion as enhancement to hybrid search

**Rationale:**
- Doesn't break existing search
- Configurable and can be disabled
- Improves results for entity-heavy queries

**Trade-offs:**
- Additional latency for graph queries
- More complex result merging
- Requires graph to be useful

---

## Part 13: Failure Modes & Degradation

### 13.1 Graph Service Unavailable

**Behavior:** Fall back to pure vector/BM25 search

```typescript
const results = this.graphConfig.enabled
  ? await this.expandWithGraph(query)
  : await this.hybridSearch(query);
```

### 13.2 Extraction Timeout

**Behavior:** Return empty extraction, log error, don't block sync

```typescript
try {
  return await this.extractWithTimeout(chunk, 30000);
} catch (error) {
  logger.error(`Extraction timeout for chunk ${chunk.id}, using empty result`);
  return { entities: [], relationships: [] };
}
```

### 13.3 Graph Query Performance Degradation

**Behavior:** Reduce max hops, limit results

```typescript
let maxHops = options.graphMaxHops || 1;

// If query takes too long, reduce complexity
if (queryDuration > 5000) {
  maxHops = Math.max(1, maxHops - 1);
}
```

---

## Conclusion

This design provides a comprehensive knowledge graph, crawler, and enhanced memory system that:

1. **Builds on existing strengths** - SQLite, hybrid search, provider abstraction
2. **Maintains performance** - Sub-100ms search latency, incremental processing
3. **Adds capabilities gradually** - Optional features that don't break core functionality
4. **Supports multiple deployment models** - All-in-one Node.js or hybrid with Python service
5. **Provides graceful degradation** - Graph failures don't break memory search

The key is **evolutionary, not revolutionary** - add graph intelligence without disrupting what already works.
