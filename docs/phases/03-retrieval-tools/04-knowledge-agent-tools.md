# Phase 3, Task 04: Knowledge Agent Tools

**Phase:** 3 - Hybrid GraphRAG Retrieval + Agent Tools
**Task:** Implement graph-aware agent tools (graph_search, graph_inspect, knowledge_ingest, knowledge_crawl)
**Duration:** 2 days
**Complexity:** Medium
**Depends on:** Task 01 (Hybrid Retrieval), Task 02 (Entity Recognizer)

---

## Task Overview

Implement agent tools that expose knowledge graph capabilities:
- `graph_search` - Entity-aware search
- `graph_inspect` - Detailed entity info
- `knowledge_ingest` - Self-ingest documents
- `knowledge_crawl` - Crawl documentation

## File Structure

```
src/agents/tools/
└── knowledge-tools.ts     # Knowledge graph agent tools
```

## Tool Definitions

```typescript
/**
 * Knowledge graph agent tools.
 *
 * Expose graph capabilities to agents:
 * - Search entities and relationships
 * - Inspect entity details
 * - Ingest content
 * - Crawl documentation
 */

import { Type } from '@sinclair/typebox';
import type { RelationalDatastore } from '../../knowledge/datastore/interface.js';
import type { GraphQueryEngine } from '../../knowledge/graph/query.js';
import { GraphRAGRetriever } from '../../knowledge/retrieval/graph-rag.js';
import { IngestionPipeline } from '../../knowledge/ingest/pipeline.js';
import { WebCrawler } from '../../knowledge/crawler/crawler.js';

// ============================================================================
// TOOL SCHEMAS
// ============================================================================

export const GraphSearchToolSchema = Type.Object({
  query: Type.String(),
  entityType: Type.Optional(Type.String()),
  maxHops: Type.Optional(Type.Number({ minimum: 1, maximum: 3 })),
  maxResults: Type.Optional(Type.Number()),
  minGraphScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

export const GraphInspectToolSchema = Type.Object({
  entityName: Type.String(),
  includeNeighborhood: Type.Optional(Type.Boolean()),
  includeRelationships: Type.Optional(Type.Boolean()),
});

export const KnowledgeIngestToolSchema = Type.Object({
  path: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
});

export const KnowledgeCrawlToolSchema = Type.Object({
  url: Type.String(),
  mode: Type.Optional(Type.Union(Type.Literal('single'), Type.Literal('sitemap'), Type.Literal('recursive'))),
  maxPages: Type.Optional(Type.Number()),
  tags: Type.Optional(Type.Array(Type.String())),
});

// ============================================================================
// TOOL HANDLERS
// ============================================================================

export class KnowledgeAgentTools {
  private retriever: GraphRAGRetriever;
  private graphQuery: GraphQueryEngine;
  private ingestion: IngestionPipeline;
  private crawler: WebCrawler;

  constructor(
    datastore: RelationalDatastore,
    graphQuery: GraphQueryEngine
  ) {
    this.graphQuery = graphQuery;
    this.retriever = new GraphRAGRetriever(datastore, graphQuery);
    this.ingestion = new IngestionPipeline(/* deps */);
    this.crawler = new WebCrawler(/* deps */);
  }

  /**
   * graph_search - Entity-aware search in knowledge graph.
   */
  async graphSearch(params: {
    query: string;
    entityType?: string;
    maxHops?: number;
    maxResults?: number;
    minGraphScore?: number;
  }): Promise<string> {
    const result = await this.retriever.retrieve(params.query, {
      graphExpansion: {
        enabled: true,
        maxHops: params.maxHops || 1,
        maxChunks: params.maxResults || 5,
        minGraphScore: params.minGraphScore || 0.3,
      },
    });

    // Format results
    const chunks = result.chunks.slice(0, params.maxResults || 10);

    let output = `Found ${result.chunks.length} relevant results:\n\n`;

    for (const chunk of chunks) {
      output += `[Score: ${chunk.score.toFixed(2)}]\n`;
      output += `${chunk.content}\n\n`;
    }

    if (result.graphContext) {
      output += `\n## Related Entities\n`;
      for (const entity of result.graphContext.entities) {
        output += `- **${entity.name}** (${entity.type})`;
        if (entity.description) {
          output += `: ${entity.description.slice(0, 100)}...`;
        }
        output += '\n';
      }
    }

    return output;
  }

  /**
   * graph_inspect - Get detailed entity information.
   */
  async graphInspect(params: {
    entityName: string;
    includeNeighborhood?: boolean;
    includeRelationships?: boolean;
  }): Promise<string> {
    // Search for entity
    const entities = await this.graphQuery.searchEntities(params.entityName, {
      limit: 1,
      types: [],
    });

    if (entities.length === 0) {
      return `Entity "${params.entityName}" not found in knowledge graph.`;
    }

    const entity = entities[0];
    let output = `**${entity.name}** (${entity.type})\n\n`;

    if (entity.description) {
      output += `Description: ${entity.description}\n\n`;
    }

    if (params.includeNeighborhood) {
      const neighborhood = await this.graphQuery.getNeighborhood(entity.id, {
        maxHops: 1,
        includeRelationships: true,
      });

      output += `## Direct Relationships (${neighborhood.relationships.length})\n\n`;

      for (const { targetEntity, relationship } of neighborhood.relationships) {
        output += `- ${relationship.type} → **${targetEntity.name}** (${targetEntity.type})`;
        if (relationship.description) {
          output += `: ${relationship.description}`;
        }
        output += ` [strength: ${relationship.strength}/10]\n`;
      }
    }

    return output;
  }

  /**
   * knowledge_ingest - Ingest local file or raw text.
   */
  async knowledgeIngest(params: {
    path?: string;
    text?: string;
    tags?: string[];
  }): Promise<string> {
    if (!params.path && !params.text) {
      return 'Error: Either path or text must be provided.';
    }

    try {
      let result;

      if (params.text) {
        result = await this.ingestion.ingestText({
          source: 'manual',
          text: params.text,
          tags: params.tags || [],
        });
      } else if (params.path) {
        result = await this.ingestion.ingestFile({
          source: 'manual',
          filePath: params.path!,
          tags: params.tags || [],
        });
      } else {
        return 'Error: Invalid parameters.';
      }

      if (result.status === 'success') {
        return `Successfully ingested content:\n` +
               `- Chunks processed: ${result.chunksProcessed}\n` +
               `- Entities extracted: ${result.entitiesExtracted}\n` +
               `- Relationships extracted: ${result.relationshipsExtracted}\n` +
               `- Source ID: ${result.sourceId}`;
      } else {
        return `Ingestion failed: ${result.error}`;
      }
    } catch (error) {
      return `Error: ${(error as Error).message}`;
    }
  }

  /**
   * knowledge_crawl - Crawl documentation from URL.
   */
  async knowledgeCrawl(params: {
    url: string;
    mode?: 'single' | 'sitemap' | 'recursive';
    maxPages?: number;
    tags?: string[];
  }): Promise<string> {
    try {
      const result = await this.crawler.crawl({
        url: params.url,
        mode: params.mode || 'single',
        maxPages: params.maxPages || 100,
        sameDomain: true,
        tags: params.tags || [],
      });

      if (result.status === 'completed' || result.status === 'partial') {
        return `Crawl completed:\n` +
               `- Crawl ID: ${result.crawlId}\n` +
               `- Pages: ${result.successfulPages}/${result.totalPages}\n` +
               `- Failed: ${result.failedPages}\n` +
               `- Duration: ${result.duration}ms`;
      } else {
        return `Crawl failed: ${result.errors.join(', ')}`;
      }
    } catch (error) {
      return `Error: ${(error as Error).message}`;
    }
  }
}

// ============================================================================
// TOOL REGISTRATION
// ============================================================================

export function registerKnowledgeTools(
  agent: any,
  tools: KnowledgeAgentTools
): void {
  agent.registerTool('graph_search', {
    schema: GraphSearchToolSchema,
    handler: (params: any) => tools.graphSearch(params),
  });

  agent.registerTool('graph_inspect', {
    schema: GraphInspectToolSchema,
    handler: (params: any) => tools.graphInspect(params),
  });

  agent.registerTool('knowledge_ingest', {
    schema: KnowledgeIngestToolSchema,
    handler: (params: any) => tools.knowledgeIngest(params),
  });

  agent.registerTool('knowledge_crawl', {
    schema: KnowledgeCrawlToolSchema,
    handler: (params: any) => tools.knowledgeCrawl(params),
  });
}
```

## Enhanced memory_search

```typescript
// Modify existing memory_search tool to support graph expansion

export const memorySearchToolSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
  useGraph: Type.Optional(Type.Boolean()),  // NEW: default true
  minGraphScore: Type.Optional(Type.Number()),  // NEW: confidence threshold
});

export async function memorySearch(params: {
  query: string;
  maxResults?: number;
  minScore?: number;
  useGraph?: boolean;
  minGraphScore?: number;
}): Promise<string> {
  const { useGraph = true, minGraphScore = 0.3, ...rest } = params;

  if (useGraph && knowledgeEnabled) {
    // Use GraphRAG retriever
    const retriever = new GraphRAGRetriever(datastore, graphQuery);
    const result = await retriever.retrieve(params.query, {
      graphExpansion: { minGraphScore },
    });

    return formatResult(result);
  } else {
    // Fallback to vector-only search
    return vectorSearch.search(params.query, params.maxResults);
  }
}
```

## Success Criteria

- [ ] graph_search tool works end-to-end
- [ ] graph_inspect returns detailed entity info
- [ ] knowledge_ingest ingests files/text
- [ ] knowledge_crawl crawls URLs
- [ ] Tools registered conditionally on config
- [ ] memory_search enhanced with graph option
- [ ] All tools handle errors gracefully
- [ ] Tests pass

## References

- Phase 3 Plan: `docs/plans/graphrag/ZAI-PLAN.md`
- Tool Schema: `docs/plans/graphrag/ZAI-PLAN.md` Phase 3
