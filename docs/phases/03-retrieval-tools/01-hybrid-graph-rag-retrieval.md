# Phase 3, Task 01: Hybrid GraphRAG Retrieval

**Phase:** 3 - Hybrid GraphRAG Retrieval + Agent Tools
**Task:** Implement graph-augmented retrieval with confidence filtering
**Duration:** 2 days
**Complexity:** Medium
**Depends on:** Phase 1 and Phase 2 complete

---

## Task Overview

Implement hybrid retrieval that combines vector search with graph expansion:
- Vector similarity search for initial chunks
- Graph expansion to include related entities
- Confidence thresholding to avoid noise
- Context formatting for LLM consumption

## Architecture Decision

**Reference:** Phase 3 in `docs/plans/graphrag/ZAI-PLAN.md`

Key insight: Graph expansion can introduce noise. Use confidence thresholds to skip low-quality graph results.

## File Structure

```
src/knowledge/retrieval/
├── graph-rag.ts            # Main hybrid retriever
├── query-entity-recognizer.ts  # Fast entity mention detection
├── context-formatter.ts     # Structured context formatting
└── graph-rag.test.ts
```

## Core Implementation

**File:** `src/knowledge/retrieval/graph-rag.ts`

```typescript
/**
 * Hybrid GraphRAG retrieval combining vector search with graph expansion.
 *
 * Strategy:
 * 1. Vector search for initial chunks (high relevance)
 * 2. Entity mention detection in query
 * 3. Graph expansion for mentioned entities (structural context)
 * 4. Confidence filtering to avoid noise
 * 5. Re-ranking and deduplication
 *
 * Reference: docs/plans/graphrag/ZAI-PLAN.md Phase 3
 */

import type { RelationalDatastore } from '../datastore/interface.js';
import type { GraphQueryEngine } from '../graph/query.js';
import type { Entity, EntityNeighborhood } from '../graph/types.js';
import { QueryEntityRecognizer } from './query-entity-recognizer.js';
import { ContextFormatter } from './context-formatter.js';

// ============================================================================
// CONFIG
// ============================================================================

export interface GraphRAGConfig {
  /** Enable graph expansion */
  enabled?: boolean;

  /** Vector search settings */
  vector?: {
    maxResults: number;
    minScore: number;
  };

  /** Graph expansion settings */
  graphExpansion?: {
    enabled: boolean;
    maxHops: number;  // 1-3 hops
    maxChunks: number;
    minGraphScore: number;  // NEW: Skip graph results below this threshold
    minConfidence: number;  // NEW: Skip expansion if confidence too low
  };

  /** Context formatting */
  context?: {
    maxTokens: number;
    includeRelationships: boolean;
    includeSources: boolean;
  };
}

export interface RetrievalResult {
  chunks: Array<{
    content: string;
    score: number;
    source: {
      type: 'vector' | 'graph';
      entity?: Entity;
      hops?: number;
    };
  }>;
  graphContext?: {
    entities: Entity[];
    relationships: Array<{
      source: string;
      target: string;
      type: string;
      description: string;
    }>;
  };
  confidence: number;  // Overall confidence score
  metadata: {
    vectorResults: number;
    graphResults: number;
    entitiesRecognized: number;
    expansionSkipped?: boolean;  // Why graph was skipped
  };
}

// ============================================================================
// HYBRID RETRIEVER
// ============================================================================

export class GraphRAGRetriever {
  private datastore: RelationalDatastore;
  private graphQuery: GraphQueryEngine;
  private entityRecognizer: QueryEntityRecognizer;
  private contextFormatter: ContextFormatter;
  private config: GraphRAGConfig;

  constructor(
    datastore: RelationalDatastore,
    graphQuery: GraphQueryEngine,
    config: GraphRAGConfig = {}
  ) {
    this.datastore = datastore;
    this.graphQuery = graphQuery;
    this.config = {
      enabled: true,
      vector: {
        maxResults: 5,
        minScore: 0.7,
      },
      graphExpansion: {
        enabled: true,
        maxHops: 1,
        maxChunks: 4,
        minGraphScore: 0.3,  // NEW: Confidence threshold
        minConfidence: 0.5,  // NEW: Skip expansion below this
      },
      context: {
        maxTokens: 4000,
        includeRelationships: true,
        includeSources: true,
      },
      ...config,
    };

    this.entityRecognizer = new QueryEntityRecognizer(datastore);
    this.contextFormatter = new ContextFormatter(this.config.context);
  }

  /**
   * Retrieve relevant chunks with graph expansion.
   */
  async retrieve(query: string, options?: GraphRAGConfig): Promise<RetrievalResult> {
    const mergedConfig = { ...this.config, ...options };

    if (!mergedConfig.enabled) {
      return this.vectorOnlyRetrieve(query, mergedConfig);
    }

    // Step 1: Vector search for initial chunks
    const vectorResults = await this.vectorSearch(query, mergedConfig.vector);

    // Step 2: Recognize entities in query
    const queryEntities = await this.entityRecognizer.recognize(query);
    const entityNames = queryEntities.map(e => e.name);

    // Step 3: Calculate confidence (based on query clarity and entity recognition)
    const confidence = this.calculateConfidence(query, queryEntities, vectorResults);

    // Step 4: Check if we should skip graph expansion
    const shouldSkipGraph =
      !mergedConfig.graphExpansion?.enabled ||
      confidence < (mergedConfig.graphExpansion.minConfidence || 0.5) ||
      queryEntities.length === 0;

    if (shouldSkipGraph) {
      return {
        chunks: vectorResults.map(r => ({
          content: r.content,
          score: r.score,
          source: { type: 'vector' },
        })),
        confidence,
        metadata: {
          vectorResults: vectorResults.length,
          graphResults: 0,
          entitiesRecognized: queryEntities.length,
          expansionSkipped: shouldSkipGraph,
        },
      };
    }

    // Step 5: Graph expansion
    const graphResults = await this.expandGraph(
      queryEntities,
      mergedConfig.graphExpansion
    );

    // Step 6: Merge and re-rank
    const merged = this.mergeResults(vectorResults, graphResults, confidence);

    // Step 7: Format graph context for LLM
    const graphContext = this.formatGraphContext(queryEntities);

    return {
      chunks: merged.chunks,
      graphContext,
      confidence: merged.confidence,
      metadata: {
        vectorResults: vectorResults.length,
        graphResults: graphResults.length,
        entitiesRecognized: queryEntities.length,
      },
    };
  }

  // ------------------------------------------------------------------------
  // PRIVATE
  // ------------------------------------------------------------------------

  /**
   * Vector-only retrieval (fallback).
   */
  private async vectorOnlyRetrieve(
    query: string,
    config: GraphRAGConfig
  ): Promise<RetrievalResult> {
    const results = await this.vectorSearch(query, config.vector);

    return {
      chunks: results.map(r => ({
        content: r.content,
        score: r.score,
        source: { type: 'vector' },
      })),
      confidence: 0.5,  // Medium confidence without graph
      metadata: {
        vectorResults: results.length,
        graphResults: 0,
        entitiesRecognized: 0,
      },
    };
  }

  /**
   * Vector similarity search on chunks.
   */
  private async vectorSearch(
    query: string,
    config: GraphRAGConfig['vector']
  ): Promise<Array<{ content: string; score: number }>> {
    // Generate query embedding
    // (This would use the embedding model)
    const queryEmbedding = await this.getEmbedding(query);

    // Search using sqlite-vec
    const results = await this.datastore.vectorSearch?.(
      'kg_chunks',
      'embedding',
      queryEmbedding,
      config?.maxResults || 5,
      config?.minScore || 0.7
    );

    if (!results) {
      // Fallback: full-text search
      return this.fullTextSearch(query, config?.maxResults || 5);
    }

    // Fetch chunk contents
    const chunks: Array<{ content: string; score: number }> = [];

    for (const result of results) {
      const chunk = await this.datastore.queryOne<{ content: string }>(
        'SELECT content FROM kg_chunks WHERE id = $1',
        [result.id]
      );

      if (chunk) {
        chunks.push({
          content: chunk.content,
          score: result.score,
        });
      }
    }

    return chunks;
  }

  /**
   * Full-text search fallback (when vector search unavailable).
   */
  private async fullTextSearch(
    query: string,
    limit: number
  ): Promise<Array<{ content: string; score: number }>> {
    const results = await this.datastore.query<any>(
      `SELECT chunk.content, bm25(kg_chunks_fts) as score
       FROM kg_chunks chunk
       JOIN kg_chunks_fts fts ON chunk.id = fts.rowid
       WHERE kg_chunks_fts MATCH $1
       ORDER BY score
       LIMIT $2`,
      [query, limit]
    );

    return results.map(r => ({
      content: r.content,
      score: 1 / (1 + r.score),  // Convert BM25 to similarity
    }));
  }

  /**
   * Expand graph around recognized entities.
   */
  private async expandGraph(
    entities: Entity[],
    config: GraphRAGConfig['graphExpansion']
  ): Promise<Array<{ content: string; score: number; entity: Entity; hops: number }>> {
    const results: Array<{ content: string; score: number; entity: Entity; hops: number }> = [];

    for (const entity of entities) {
      // Get neighborhood
      const neighborhood = await this.graphQuery.getNeighborhood(entity.id, {
        maxHops: config?.maxHops || 1,
        includeRelationships: false,
      });

      // Score related entities
      for (const { targetEntity, relationship } of neighborhood.relationships) {
        const score = relationship.strength / 10;  // Normalize to 0-1

        // Filter by minGraphScore (NEW)
        if (score < (config?.minGraphScore || 0.3)) {
          continue;
        }

        // Get chunks for this entity
        const chunks = await this.getEntityChunks(targetEntity.id, config?.maxChunks || 4);

        for (const chunk of chunks) {
          results.push({
            content: chunk.content,
            score: chunk.score * score,  // Combined score
            entity: targetEntity,
            hops: 1,
          });
        }
      }
    }

    return results;
  }

  /**
   * Get chunks associated with an entity.
   */
  private async getEntityChunks(
    entityId: string,
    limit: number
  ): Promise<Array<{ content: string; score: number }>> {
    const chunks = await this.datastore.query<any>(
      `SELECT DISTINCT c.content, 1.0 as score
       FROM kg_chunks c
       JOIN kg_entity_sources es ON c.id = es.chunk_id
       WHERE es.entity_id = $1
       LIMIT $2`,
      [entityId, limit]
    );

    return chunks;
  }

  /**
   * Merge vector and graph results with re-ranking.
   */
  private mergeResults(
    vectorResults: Array<{ content: string; score: number }>,
    graphResults: Array<{ content: string; score: number; entity: Entity; hops: number }>,
    confidence: number
  ): {
    chunks: RetrievalResult['chunks'];
    confidence: number;
  } {
    const seen = new Set<string>();
    const chunks: RetrievalResult['chunks'] = [];

    // Add vector results
    for (const result of vectorResults) {
      const key = result.content.slice(0, 100);  // Dedupe by content prefix
      if (!seen.has(key)) {
        seen.add(key);
        chunks.push({
          content: result.content,
          score: result.score,
          source: { type: 'vector' },
        });
      }
    }

    // Add graph results (re-ranked)
    for (const result of graphResults) {
      const key = result.content.slice(0, 100);
      if (!seen.has(key)) {
        seen.add(key);
        chunks.push({
          content: result.content,
          score: result.score * confidence,  // Adjust by confidence
          source: {
            type: 'graph',
            entity: result.entity,
            hops: result.hops,
          },
        });
      }
    }

    // Sort by score
    chunks.sort((a, b) => b.score - a.score);

    return { chunks, confidence };
  }

  /**
   * Calculate retrieval confidence.
   */
  private calculateConfidence(
    query: string,
    entities: Entity[],
    vectorResults: Array<{ score: number }>
  ): number {
    // Factors:
    // 1. Query specificity (length, clear terms)
    // 2. Entity recognition (found entities in query)
    // 3. Vector search quality (high scores)

    const querySpecificity = Math.min(query.length / 100, 1);
    const entityRecognition = entities.length > 0 ? 1 : 0.5;
    const vectorQuality = vectorResults.length > 0
      ? vectorResults[0].score
      : 0;

    return (querySpecificity * 0.3 + entityRecognition * 0.3 + vectorQuality * 0.4);
  }

  /**
   * Format graph context for LLM.
   */
  private formatGraphContext(entities: Entity[]): RetrievalResult['graphContext'] {
    if (entities.length === 0) return undefined;

    return {
      entities,
      relationships: [],  // Would fetch from graph
    };
  }

  /**
   * Get embedding for text (placeholder).
   */
  private async getEmbedding(text: string): Promise<number[]> {
    // This would use the embedding model
    return [];
  }
}
```

## Query Entity Recognizer

**File:** `src/knowledge/retrieval/query-entity-recognizer.ts`

```typescript
/**
 * Fast entity mention detection in queries.
 *
 * Strategy:
 * 1. Extract candidate phrases (capitalized words, noun phrases)
 * 2. Look up in entity FTS index
 * 3. Return matched entities
 */

import type { RelationalDatastore } from '../datastore/interface.js';
import type { Entity } from '../graph/types.js';

export class QueryEntityRecognizer {
  constructor(private datastore: RelationalDatastore) {}

  /**
   * Recognize entities mentioned in query text.
   */
  async recognize(query: string): Promise<Entity[]> {
    // Extract candidate phrases
    const candidates = this.extractCandidates(query);

    if (candidates.length === 0) return [];

    // Search for entities matching candidates
    const entities: Entity[] = [];

    for (const candidate of candidates) {
      const matches = await this.datastore.query<any>(
        `SELECT e.* FROM kg_entities e
         JOIN kg_entities_fts fts ON e.id = fts.rowid
         WHERE kg_entities_fts MATCH $1
         LIMIT 5`,
        [candidate]
      );

      for (const match of matches) {
        entities.push({
          id: match.id,
          name: match.name,
          type: match.type,
          description: match.description,
          /* ... */
        });
      }
    }

    return this.deduplicate(entities);
  }

  /**
   * Extract candidate entity mentions from query.
   */
  private extractCandidates(query: string): string[] {
    const candidates: string[] = [];

    // Extract capitalized phrases
    const capitalizedMatch = query.matchAll(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g);

    for (const match of capitalizedMatch) {
      candidates.push(match[0]);
    }

    // Extract quoted phrases
    const quotedMatch = query.matchAll(/"([^"]+)"/g);

    for (const match of quotedMatch) {
      candidates.push(match[1]);
    }

    return Array.from(new Set(candidates));
  }

  /**
   * Deduplicate entities by name.
   */
  private deduplicate(entities: Entity[]): Entity[] {
    const seen = new Set<string>();
    const unique: Entity[] = [];

    for (const entity of entities) {
      const key = entity.name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(entity);
      }
    }

    return unique;
  }
}
```

## Context Formatter

**File:** `src/knowledge/retrieval/context-formatter.ts`

```typescript
/**
 * Format retrieved context for LLM consumption.
 *
 * Formats:
 * - Chunks with sources
 * - Entity descriptions
 * - Relationship information
 */

export interface ContextFormatterOptions {
  maxTokens: number;
  includeRelationships: boolean;
  includeSources: boolean;
}

export interface FormattedContext {
  text: string;
  tokens: number;
  sources: Array<{ type: string; id?: string; name?: string }>;
}

export class ContextFormatter {
  constructor(private options: ContextFormatterOptions) {}

  /**
   * Format retrieval results for LLM.
   */
  format(
    chunks: Array<{ content: string; score: number; source: any }>,
    graphContext?: { entities: any[]; relationships: any[] }
  ): FormattedContext {
    const parts: string[] = [];
    const sources: FormattedContext['sources'] = [];

    // Add entity context if available
    if (graphContext && graphContext.entities.length > 0) {
      const entitySection = this.formatEntities(graphContext.entities);
      parts.push(entitySection.text);
      sources.push(...entitySection.sources);
    }

    // Add chunks
    for (const chunk of chunks) {
      parts.push(`[Score: ${chunk.score.toFixed(2)}]\n${chunk.content}\n`);

      if (this.options.includeSources) {
        if (chunk.source.type === 'graph' && chunk.source.entity) {
          sources.push({
            type: 'entity',
            id: chunk.source.entity.id,
            name: chunk.source.entity.name,
          });
        } else {
          sources.push({ type: 'chunk' });
        }
      }
    }

    return {
      text: parts.join('\n---\n\n'),
      tokens: this.estimateTokens(parts.join('\n')),
      sources,
    };
  }

  /**
   * Format entity descriptions.
   */
  private formatEntities(entities: any[]): { text: string; sources: any[] } {
    const parts: string[] = [];
    const sources: any[] = [];

    for (const entity of entities) {
      parts.push(`**${entity.name}** (${entity.type})`);
      if (entity.description) {
        parts.push(entity.description);
      }
      sources.push({ type: 'entity', id: entity.id, name: entity.name });
    }

    return {
      text: '## Related Entities\n\n' + parts.join('\n\n') + '\n\n',
      sources,
    };
  }

  /**
   * Estimate token count (rough approximation).
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
```

## Integration with memory_search

**Modify:** `src/agents/memory-search.ts`

```typescript
// Add GraphRAG to existing memory_search tool

export const memorySearchTool = {
  name: 'memory_search',
  description: 'Search memory and knowledge graph for relevant information',
  parameters: {
    query: { type: 'string' },
    maxResults: { type: 'number' },
    useGraph: { type: 'boolean', default: true },  // NEW
    minGraphScore: { type: 'number', default: 0.3 },  // NEW
  },
  handler: async (params, context) => {
    const { query, maxResults = 10, useGraph = true, minGraphScore = 0.3 } = params;

    if (useGraph && context.knowledge?.enabled) {
      const retriever = new GraphRAGRetriever(context.datastore, context.graphQuery);
      const results = await retriever.retrieve(query, {
        graphExpansion: { minGraphScore },
      });

      return context.formatter.format(results);
    } else {
      // Fallback to vector-only search
      return context.vectorSearch.search(query, maxResults);
    }
  },
};
```

## Success Criteria

- [ ] Hybrid retrieval combines vector + graph
- [ ] Entity recognition works on queries
- [ ] Confidence filtering prevents noise
- [ ] Context formatting produces LLM-ready text
- [ ] Integration with memory_search works
- [ ] Tests pass

## References

- Phase 3 Plan: `docs/plans/graphrag/ZAI-PLAN.md`
- Noise Mitigation: `docs/plans/graphrag/ZAI-PLAN.md` Phase 3

## Next Task

Proceed to `02-knowledge-agent-tools.md` to implement graph-aware agent tools.
