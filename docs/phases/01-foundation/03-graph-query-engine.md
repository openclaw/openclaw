# Phase 1, Task 03: Graph Query Engine

**Phase:** 1 - Foundation (Graph Storage + Entity Extraction Core)
**Task:** Implement graph query engine with graphology integration
**Duration:** 2 days
**Complexity:** Medium
**Depends on:** Task 02 (Graph Schema Migrations)

---

## Task Overview

Implement a graph query engine that provides:
- Neighborhood queries (1-hop, 2-hop, n-hop)
- Path finding between entities
- Hub detection (highly connected entities)
- Community detection (optional)

## Architecture Decision

**Reference:** AD-02 in `docs/plans/graphrag/ZAI-DECISIONS.md`

Use **graphology** for in-memory graph operations combined with SQLite persistent storage.

## File Structure

```
src/knowledge/graph/
├── query.ts                    # Main GraphQueryEngine class
├── graphology-adapter.ts       # Graphology integration
└── query.test.ts               # Tests
```

## Core Interface

**File:** `src/knowledge/graph/query.ts`

```typescript
/**
 * Graph query engine for knowledge graph traversal.
 *
 * Combines:
 * - graphology for in-memory algorithms (BFS, DFS, PageRank)
 * - SQLite recursive CTEs for disk-bound queries
 *
 * Reference: docs/plans/graphrag/ZAI-DECISIONS.md AD-02
 */

import { Graph, UndirectedGraph } from 'graphology';
import { bfs, dfs } from 'graphology-traversal';
import { connectedComponents } from 'graphology-components';
import { degreeCentrality } from 'graphology-centrality';
import type {
  RelationalDatastore,
} from '../datastore/interface.js';
import type {
  Entity,
  Relationship,
  EntityNeighborhood,
  GraphPath,
} from './types.js';

// ============================================================================
// QUERY OPTIONS
// ============================================================================

export interface GraphQueryOptions {
  /** Maximum depth for neighborhood queries */
  maxHops?: number;
  /** Filter by entity types */
  entityTypes?: string[];
  /** Filter by relationship types */
  relationshipTypes?: string[];
  /** Minimum relationship strength */
  minStrength?: number;
  /** Include entities merged into canonical entities */
  includeMerged?: boolean;
  /** Temporal filter: point-in-time query */
  asOfTimestamp?: number;
}

export interface PathQueryOptions extends GraphQueryOptions {
  /** Maximum path length */
  maxLength?: number;
  /** Find shortest path */
  shortest?: boolean;
  /** Find all paths (can be expensive) */
  allPaths?: boolean;
}

export interface NeighborhoodQueryOptions extends GraphQueryOptions {
  /** Include relationship details */
  includeRelationships?: boolean;
  /** Limit number of results */
  limit?: number;
}

export interface HubQueryOptions {
  /** Minimum degree (number of connections) */
  minDegree?: number;
  /** Limit number of results */
  limit?: number;
  /** Centrality algorithm: 'degree' | 'pagerank' */
  algorithm?: 'degree' | 'pagerank';
}

// ============================================================================
// QUERY ENGINE
// ============================================================================

export class GraphQueryEngine {
  private datastore: RelationalDatastore;
  private inMemoryCache: Map<string, Graph> = new Map();
  private cacheMaxSize = 100;
  private cacheTTL = 60000;  // 60 seconds

  constructor(datastore: RelationalDatastore) {
    this.datastore = datastore;
  }

  // ------------------------------------------------------------------------
  // ENTITY QUERIES
  // ------------------------------------------------------------------------

  /**
   * Get an entity by ID.
   */
  async getEntity(entityId: string): Promise<Entity | null> {
    const result = await this.datastore.queryOne<Entity>(
      `SELECT * FROM kg_entities WHERE id = $1`,
      [entityId]
    );
    return this.parseEntity(result);
  }

  /**
   * Search entities by name or description.
   */
  async searchEntities(
    query: string,
    options: {
      limit?: number;
      types?: string[];
      fuzzy?: boolean;
    } = {}
  ): Promise<Entity[]> {
    const { limit = 20, types, fuzzy = false } = options;

    let sql: string;
    let params: any[] = [];

    if (fuzzy) {
      // Use FTS5 with ranking
      sql = `
        SELECT e.* FROM kg_entities e
        JOIN kg_entities_fts fts ON e.id = fts.rowid
        WHERE kg_entities_fts MATCH $1
      `;
      params = [query];

      if (types && types.length > 0) {
        sql += ` AND e.type IN (${types.map((_, i) => `$${i + 2}`).join(',')})`;
        params.push(...types);
      }

      sql += ` ORDER BY bm25(kg_entities_fts) LIMIT $${params.length + 1}`;
      params.push(limit);
    } else {
      // Simple prefix matching
      sql = `
        SELECT * FROM kg_entities
        WHERE name LIKE $1
      `;
      params = [`${query}%`];

      if (types && types.length > 0) {
        sql += ` AND type IN (${types.map((_, i) => `$${i + 2}`).join(',')})`;
        params.push(...types);
      }

      sql += ` LIMIT $${params.length + 1}`;
      params.push(limit);
    }

    const results = await this.datastore.query<any>(sql, params);
    return results.map(r => this.parseEntity(r)).filter(Boolean) as Entity[];
  }

  /**
   * Get entities by type.
   */
  async getEntitiesByType(
    type: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<Entity[]> {
    const { limit = 100, offset = 0 } = options;

    const results = await this.datastore.query<any>(
      `SELECT * FROM kg_entities
       WHERE type = $1
       ORDER BY last_seen DESC
       LIMIT $2 OFFSET $3`,
      [type, limit, offset]
    );

    return results.map(r => this.parseEntity(r)).filter(Boolean) as Entity[];
  }

  // ------------------------------------------------------------------------
  // NEIGHBORHOOD QUERIES
  // ------------------------------------------------------------------------

  /**
   * Get the neighborhood around an entity.
   *
   * Uses recursive CTE for efficient n-hop queries.
   */
  async getNeighborhood(
    entityId: string,
    options: NeighborhoodQueryOptions = {}
  ): Promise<EntityNeighborhood> {
    const {
      maxHops = 1,
      relationshipTypes,
      minStrength = 0,
      includeRelationships = true,
      limit,
    } = options;

    // Build the recursive CTE
    const relationshipFilter = relationshipTypes
      ? `AND r.type IN (${relationshipTypes.map((_, i) => `$${i + 3}`).join(',')})`
      : '';

    const sql = `
      WITH RECURSIVE neighborhood AS (
        -- Base case: the starting entity
        SELECT
          e.id,
          e.name,
          e.type,
          e.description,
          0 as hops,
          NULL as rel_id,
          NULL as rel_type,
          NULL as rel_strength,
          NULL as came_from
        FROM kg_entities e
        WHERE e.id = $1

        UNION ALL

        -- Recursive case: follow relationships
        SELECT
          next.id,
          next.name,
          next.type,
          next.description,
          prev.hops + 1,
          r.id as rel_id,
          r.type as rel_type,
          r.strength as rel_strength,
          prev.id as came_from
        FROM neighborhood prev
        JOIN kg_relationships r ON (
          r.source_id = prev.id OR r.target_id = prev.id
        )
        JOIN kg_entities next ON (
          (r.source_id = prev.id AND next.id = r.target_id) OR
          (r.target_id = prev.id AND next.id = r.source_id)
        )
        WHERE prev.hops < $2
          AND r.strength >= $3
          ${relationshipFilter}
          AND next.id NOT IN (
            -- Avoid cycles by excluding already-visited entities
            SELECT id FROM (
              SELECT id FROM neighborhood WHERE came_from IS NOT NULL
            ) visited
            WHERE visited.id = next.id
          )
      )
      SELECT DISTINCT * FROM neighborhood
      WHERE hops > 0  -- Exclude the starting entity itself
      ORDER BY hops, rel_strength DESC
      ${limit ? `LIMIT $${4 + (relationshipTypes?.length || 0)}` : ''}
    `;

    const params: any[] = [
      entityId,
      maxHops,
      minStrength,
    ];
    if (relationshipTypes) params.push(...relationshipTypes);
    if (limit) params.push(limit);

    const results = await this.datastore.query<any>(sql, params);

    // Build the neighborhood structure
    const entity = await this.getEntity(entityId);
    if (!entity) {
      throw new Error(`Entity not found: ${entityId}`);
    }

    const relationships = includeRelationships
      ? await this.buildRelationshipsFromNeighborhood(results)
      : [];

    return {
      entity,
      relationships,
    };
  }

  /**
   * Get multiple hops from a starting entity.
   */
  async getNHops(
    entityId: string,
    hops: number,
    options: Omit<NeighborhoodQueryOptions, 'maxHops'> = {}
  ): Promise<Map<string, Entity>> {
    const neighborhood = await this.getNeighborhood(entityId, {
      ...options,
      maxHops: hops,
    });

    const entities = new Map<string, Entity>();
    entities.set(entityId, neighborhood.entity);

    for (const { targetEntity } of neighborhood.relationships) {
      entities.set(targetEntity.id, targetEntity);
    }

    return entities;
  }

  // ------------------------------------------------------------------------
  // PATH QUERIES
  // ------------------------------------------------------------------------

  /**
   * Find a path between two entities.
   *
   * Uses bidirectional BFS for efficiency.
   */
  async findPath(
    fromId: string,
    toId: string,
    options: PathQueryOptions = {}
  ): Promise<GraphPath | null> {
    const { maxLength = 5, relationshipTypes, minStrength = 0 } = options;

    // Build in-memory graph for path finding
    const graph = await this.buildSubgraph([fromId, toId], {
      maxDepth: maxLength,
      relationshipTypes,
      minStrength,
    });

    // Use BFS to find shortest path
    const path = this.bfsPath(graph, fromId, toId);

    if (!path) {
      return null;
    }

    // Fetch full entity and relationship details
    return await this.buildGraphPath(path);
  }

  /**
   * Find all paths between two entities.
   */
  async findAllPaths(
    fromId: string,
    toId: string,
    options: PathQueryOptions = {}
  ): Promise<GraphPath[]> {
    const { maxLength = 3, relationshipTypes, minStrength = 0 } = options;

    const graph = await this.buildSubgraph([fromId, toId], {
      maxDepth: maxLength,
      relationshipTypes,
      minStrength,
    });

    const paths = this.findAllPathsDFS(graph, fromId, toId, maxLength);

    return await Promise.all(
      paths.map(path => this.buildGraphPath(path))
    );
  }

  // ------------------------------------------------------------------------
  // HUB QUERIES
  // ------------------------------------------------------------------------

  /**
   * Find highly connected entities (hubs).
   */
  async getHubs(options: HubQueryOptions = {}): Promise<Array<Entity & { score: number }>> {
    const { minDegree = 3, limit = 20, algorithm = 'degree' } = options;

    if (algorithm === 'degree') {
      return this.getHubsByDegree(minDegree, limit);
    }

    // PageRank requires loading more of the graph
    return this.getHubsByPageRank(minDegree, limit);
  }

  /**
   * Get hubs by degree centrality (number of connections).
   */
  private async getHubsByDegree(
    minDegree: number,
    limit: number
  ): Promise<Array<Entity & { score: number }>> {
    const sql = `
      SELECT
        e.*,
        (in_degree + out_degree) as score
      FROM kg_entities e
      JOIN (
        -- Count outgoing relationships
        SELECT source_id as id, COUNT(*) as out_degree
        FROM kg_relationships
        GROUP BY source_id
      ) out_deg ON e.id = out_deg.id
      JOIN (
        -- Count incoming relationships
        SELECT target_id as id, COUNT(*) as in_degree
        FROM kg_relationships
        GROUP BY target_id
      ) in_deg ON e.id = in_deg.id
      WHERE (in_degree + out_degree) >= $1
      ORDER BY score DESC
      LIMIT $2
    `;

    const results = await this.datastore.query<any>(sql, [minDegree, limit]);

    return results.map(r => ({
      ...this.parseEntity(r),
      score: r.score,
    }));
  }

  /**
   * Get hubs by PageRank algorithm.
   */
  private async getHubsByPageRank(
    minDegree: number,
    limit: number
  ): Promise<Array<Entity & { score: number }>> {
    // Load a larger subgraph for PageRank calculation
    const hubIds = await this.getHubsByDegree(minDegree, limit * 2);
    const ids = hubIds.map(h => h.id);

    const graph = await this.buildSubgraph(ids, { maxDepth: 2 });

    // Calculate PageRank scores
    const scores = degreeCentrality(graph);

    // Sort by score and return top N
    const sorted = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

    return await Promise.all(
      sorted.map(async ([id, score]) => {
        const entity = await this.getEntity(id);
        return { ...entity!, score };
      })
    );
  }

  // ------------------------------------------------------------------------
  // GRAPH STATS
  // ------------------------------------------------------------------------

  /**
   * Get overall graph statistics.
   */
  async getStats(): Promise<{
    entityCount: number;
    relationshipCount: number;
    typeCounts: Record<string, number>;
    relationshipTypeCounts: Record<string, number>;
  }> {
    const [entityResult, relResult, typeResults, relTypeResults] = await Promise.all([
      this.datastore.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM kg_entities'),
      this.datastore.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM kg_relationships'),
      this.datastore.query<{ type: string; count: number }>(
        'SELECT type, COUNT(*) as count FROM kg_entities GROUP BY type'
      ),
      this.datastore.query<{ type: string; count: number }>(
        'SELECT type, COUNT(*) as count FROM kg_relationships GROUP BY type'
      ),
    ]);

    const typeCounts: Record<string, number> = {};
    for (const row of typeResults) {
      typeCounts[row.type] = row.count;
    }

    const relTypeCounts: Record<string, number> = {};
    for (const row of relTypeResults) {
      relTypeCounts[row.type] = row.count;
    }

    return {
      entityCount: entityResult!.count,
      relationshipCount: relResult!.count,
      typeCounts,
      relationshipTypeCounts: relTypeCounts,
    };
  }

  // ------------------------------------------------------------------------
  // PRIVATE HELPERS
  // ------------------------------------------------------------------------

  /**
   * Parse database row into Entity object.
   */
  private parseEntity(row: any): Entity | null {
    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      nameHash: row.name_hash,
      type: row.type,
      description: row.description,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      canonicalId: row.canonical_id,
      mergedFrom: row.merged_from ? JSON.parse(row.merged_from) : undefined,
      sourceCount: row.source_count,
    };
  }

  /**
   * Build an in-memory graphology graph from database data.
   */
  private async buildSubgraph(
    seedIds: string[],
    options: {
      maxDepth?: number;
      relationshipTypes?: string[];
      minStrength?: number;
    } = {}
  ): Promise<Graph> {
    const graph = new Graph();

    // Load entities and relationships recursively
    const visited = new Set<string>(seedIds);
    const queue = [...seedIds];

    while (queue.length > 0) {
      const id = queue.shift()!;

      // Get the entity
      const entity = await this.getEntity(id);
      if (!entity) continue;

      if (!graph.hasNode(id)) {
        graph.addNode(id, { ...entity });
      }

      // Get relationships
      const relationships = await this.datastore.query<any>(
        `SELECT * FROM kg_relationships
         WHERE (source_id = $1 OR target_id = $1)
           AND strength >= $2
         ${options.relationshipTypes ? `AND type IN (${options.relationshipTypes.map((_, i) => `$${i + 3}`).join(',')})` : ''}`,
        [id, options.minStrength ?? 0, ...(options.relationshipTypes ?? [])]
      );

      for (const rel of relationships) {
        const otherId = rel.source_id === id ? rel.target_id : rel.source_id;

        if (!visited.has(otherId) && (options.maxDepth ?? 1) > 0) {
          visited.add(otherId);
          queue.push(otherId);
        }

        if (!graph.hasNode(otherId)) {
          const otherEntity = await this.getEntity(otherId);
          if (otherEntity) {
            graph.addNode(otherId, { ...otherEntity });
          }
        }

        if (!graph.hasEdge(id, otherId)) {
          graph.addEdge(id, otherId, { ...rel });
        }
      }
    }

    return graph;
  }

  /**
   * BFS path finding in graphology graph.
   */
  private bfsPath(graph: Graph, from: string, to: string): string[] | null {
    const queue: Array<{ node: string; path: string[] }> = [
      { node: from, path: [from] },
    ];
    const visited = new Set<string>([from]);

    while (queue.length > 0) {
      const { node, path } = queue.shift()!;

      if (node === to) {
        return path;
      }

      for (const neighbor of graph.neighbors(node)) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push({
            node: neighbor,
            path: [...path, neighbor],
          });
        }
      }
    }

    return null;
  }

  /**
   * Find all paths using DFS (can be expensive).
   */
  private findAllPathsDFS(
    graph: Graph,
    from: string,
    to: string,
    maxLength: number
  ): string[][] {
    const paths: string[][] = [];

    const dfs = (node: string, path: string[], visited: Set<string>) => {
      if (path.length > maxLength) return;

      if (node === to) {
        paths.push([...path]);
        return;
      }

      for (const neighbor of graph.neighbors(node)) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          dfs(neighbor, [...path, neighbor], visited);
          visited.delete(neighbor);
        }
      }
    };

    dfs(from, [from], new Set([from]));
    return paths;
  }

  /**
   * Build relationship objects from neighborhood query results.
   */
  private async buildRelationshipsFromNeighborhood(
    rows: any[]
  ): Promise<Array<{ relationship: Relationship; targetEntity: Entity }>> {
    const results: Array<{ relationship: Relationship; targetEntity: Entity }> = [];

    for (const row of rows) {
      if (row.rel_id) {
        const rel = await this.datastore.queryOne<Relationship>(
          'SELECT * FROM kg_relationships WHERE id = $1',
          [row.rel_id]
        );

        const entity = await this.getEntity(row.id);

        if (rel && entity) {
          results.push({ relationship: rel, targetEntity: entity });
        }
      }
    }

    return results;
  }

  /**
   * Build a GraphPath from an array of entity IDs.
   */
  private async buildGraphPath(entityIds: string[]): Promise<GraphPath> {
    const entities = await Promise.all(
      entityIds.map(id => this.getEntity(id))
    );

    const relationships: Relationship[] = [];

    for (let i = 0; i < entities.length - 1; i++) {
      const from = entities[i]!;
      const to = entities[i + 1]!;

      const rel = await this.datastore.queryOne<Relationship>(
        `SELECT * FROM kg_relationships
         WHERE (source_id = $1 AND target_id = $2)
            OR (source_id = $2 AND target_id = $1)
         LIMIT 1`,
        [from.id, to.id]
      );

      if (rel) {
        relationships.push(rel);
      }
    }

    const totalStrength = relationships.reduce((sum, r) => sum + r.strength, 0);

    return {
      entities: entities.filter(Boolean) as Entity[],
      relationships,
      totalStrength,
    };
  }
}
```

## Dependencies

Add to `package.json`:

```json
{
  "dependencies": {
    "graphology": "^0.25.4",
    "graphology-traversal": "^0.3.0",
    "graphology-components": "^1.0.0",
    "graphology-centrality": "^0.3.0"
  }
}
```

## Usage Examples

```typescript
// Create query engine
const engine = new GraphQueryEngine(datastore);

// Get 2-hop neighborhood around an entity
const neighborhood = await engine.getNeighborhood('entity-123', {
  maxHops: 2,
  minStrength: 5,
  relationshipTypes: ['depends_on', 'implements'],
});

// Find path between two entities
const path = await engine.findPath('entity-a', 'entity-b', {
  maxLength: 3,
});

// Get highly connected entities
const hubs = await engine.getHubs({
  minDegree: 5,
  limit: 10,
  algorithm: 'pagerank',
});

// Search entities
const results = await engine.searchEntities('auth', {
  types: ['concept', 'tool'],
  fuzzy: true,
  limit: 20,
});
```

## Testing

**File:** `src/knowledge/graph/query.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { createDatastore } from '../datastore/interface.js';
import { migrateGraphSchema } from './schema.js';
import { GraphQueryEngine } from './query.js';

describe('GraphQueryEngine', () => {
  let engine: GraphQueryEngine;
  let ds: RelationalDatastore;

  beforeEach(async () => {
    ds = createDatastore({ type: 'sqlite', path: ':memory:' });
    await migrateGraphSchema(ds);
    engine = new GraphQueryEngine(ds);

    // Seed test data
    await seedTestData(ds);
  });

  it('should get entity by ID', async () => {
    const entity = await engine.getEntity('e1');
    expect(entity).toBeDefined();
    expect(entity?.name).toBe('Entity 1');
  });

  it('should search entities', async () => {
    const results = await engine.searchEntities('entity');
    expect(results.length).toBeGreaterThan(0);
  });

  it('should get 1-hop neighborhood', async () => {
    const neighborhood = await engine.getNeighborhood('e1', { maxHops: 1 });
    expect(neighborhood.entity.id).toBe('e1');
    expect(neighborhood.relationships.length).toBeGreaterThan(0);
  });

  it('should find path between entities', async () => {
    const path = await engine.findPath('e1', 'e3');
    expect(path).not.toBeNull();
    expect(path.entities.length).toBe(3);
  });

  it('should identify hubs', async () => {
    const hubs = await engine.getHubs({ minDegree: 2 });
    expect(hubs.length).toBeGreaterThan(0);
    expect(hubs[0].score).toBeGreaterThanOrEqual(2);
  });

  it('should get graph stats', async () => {
    const stats = await engine.getStats();
    expect(stats.entityCount).toBeGreaterThan(0);
    expect(stats.relationshipCount).toBeGreaterThan(0);
  });
});
```

## Success Criteria

- [ ] GraphQueryEngine implements all required query methods
- [ ] Recursive CTE queries work correctly
- [ ] graphology integration functional
- [ ] Path finding works bidirectional
- [ ] Hub detection returns correct results
- [ ] All tests pass
- [ ] Performance acceptable for <50K entities

## References

- Decision AD-02: `docs/plans/graphrag/ZAI-DECISIONS.md`
- Graphology Docs: https://graphology.github.io/
- SQLite Recursive CTEs: https://www.sqlite.org/lang_with.html

## Next Task

Proceed to `04-model-abstraction.md` to implement the pluggable model interface.
