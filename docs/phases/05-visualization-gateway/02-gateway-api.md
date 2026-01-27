# Phase 5, Task 02: Gateway API Endpoints

**Phase:** 5 - Web Visualization + Gateway API
**Task:** Implement REST API endpoints for knowledge graph
**Duration:** 1 week
**Complexity:** Medium
**Depends on:** Phase 1-4 complete

---

## Task Overview

Implement Gateway API endpoints for knowledge graph:
- `/api/knowledge/graph/*` - Graph query endpoints
- `/api/knowledge/ingest` - Ingestion endpoint
- `/api/knowledge/crawl` - Crawl endpoint
- `/api/knowledge/sources` - Source management

## File Structure

```
src/gateway/routes/
└── knowledge.ts           # Knowledge graph API routes
```

## Implementation

```typescript
/**
 * Knowledge graph API endpoints.
 */

import { Hono } from 'hono';
import { Type } from '@sinclair/typebox';

const app = new Hono();

// ============================================================================
// GRAPH QUERIES
// ============================================================================

/**
 * GET /api/knowledge/graph/stats
 *
 * Get overall graph statistics.
 */
app.get('/api/knowledge/graph/stats', async (c) => {
  const stats = await graphQuery.getStats();
  return c.json(stats);
});

/**
 * GET /api/knowledge/graph/entities
 *
 * Search and filter entities.
 */
app.get('/api/knowledge/graph/entities', async (c) => {
  const { types, search, limit } = c.req.query();

  let sql = 'SELECT * FROM kg_entities WHERE 1=1';
  const params: any[] = [];

  if (types) {
    const typeList = (types as string).split(',');
    sql += ` AND type IN (${typeList.map(() => '?').join(',')})`;
    params.push(...typeList);
  }

  if (search) {
    sql += ` AND (name LIKE ? OR description LIKE ?)`;
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm);
  }

  sql += ` ORDER BY last_seen DESC LIMIT ?`;
  params.push(Number(limit) || 100);

  const entities = await datastore.query(sql, params);

  return c.json({ entities });
});

/**
 * GET /api/knowledge/graph/entity/:entityId
 *
 * Get detailed entity information.
 */
app.get('/api/knowledge/graph/entity/:entityId', async (c) => {
  const { entityId } = c.req.param();

  const entity = await graphQuery.getEntity(entityId);

  if (!entity) {
    return c.json({ error: 'Entity not found' }, 404);
  }

  return c.json({ entity });
});

/**
 * GET /api/knowledge/graph/entity/:entityId/neighborhood
 *
 * Get entity neighborhood (connected entities).
 */
app.get('/api/knowledge/graph/entity/:entityId/neighborhood', async (c) => {
  const { entityId } = c.req.param();
  const { hops = 1, limit = 20 } = c.req.query();

  const neighborhood = await graphQuery.getNeighborhood(entityId, {
    maxHops: Number(hops),
    limit: Number(limit),
    includeRelationships: true,
  });

  return c.json({ neighborhood });
});

/**
 * GET /api/knowledge/graph/relationships
 *
 * Query relationships between entities.
 */
app.get('/api/knowledge/graph/relationships', async (c) => {
  const { sourceId, targetId, type } = c.req.query();

  let sql = 'SELECT * FROM kg_relationships WHERE 1=1';
  const params: any[] = [];

  if (sourceId) {
    sql += ' AND source_id = ?';
    params.push(sourceId);
  }

  if (targetId) {
    sql += ' AND target_id = ?';
    params.push(targetId);
  }

  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }

  sql += ' ORDER BY strength DESC LIMIT 100';

  const relationships = await datastore.query(sql, params);

  return c.json({ relationships });
});

/**
 * GET /api/knowledge/graph/subgraph
 *
 * Get subgraph connecting multiple entities.
 */
app.get('/api/knowledge/graph/subgraph', async (c) => {
  const { entityIds } = c.req.query();

  if (!entityIds) {
    return c.json({ error: 'entityIds query parameter required' }, 400);
  }

  const ids = (entityIds as string).split(',');

  // Get entities
  const entities = await datastore.query(
    `SELECT * FROM kg_entities WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids
  );

  // Get relationships between these entities
  const relationships = await datastore.query(
    `SELECT * FROM kg_relationships
     WHERE source_id IN (${ids.map(() => '?').join(',')})
       AND target_id IN (${ids.map(() => '?').join(',')})
     ORDER BY strength DESC`,
    [...ids, ...ids]
  );

  return c.json({ entities, relationships });
});

// ============================================================================
// INGESTION
// ============================================================================

/**
 * POST /api/knowledge/ingest
 *
 * Ingest a file or text into the knowledge graph.
 */
const IngestSchema = Type.Object({
  source: Type.Union(Type.Literal('file'), Type.Literal('text')),
  content: Type.String(),
  title: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  skipExtraction: Type.Optional(Type.Boolean()),
});

app.post('/api/knowledge/ingest', async (c) => {
  const body = await c.req.json();

  // Validate
  const validated = IngestSchema.safeParse(body);
  if (!validated.success) {
    return c.json({ error: 'Invalid request', details: validated.error }, 400);
  }

  const { source, content, title, tags, skipExtraction } = validated.data;

  try {
    let result;

    if (source === 'text') {
      result = await ingestion.ingestText({
        source: 'api',
        text: content,
        title,
        tags: tags || [],
        skipExtraction,
      });
    } else {
      // File content would be uploaded via multipart form
      return c.json({ error: 'File upload not implemented yet' }, 501);
    }

    return c.json({
      success: result.status === 'success',
      sourceId: result.sourceId,
      chunksProcessed: result.chunksProcessed,
      entitiesExtracted: result.entitiesExtracted,
      relationshipsExtracted: result.relationshipsExtracted,
      duration: result.duration,
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

// ============================================================================
// CRAWLING
// ============================================================================

/**
 * POST /api/knowledge/crawl
 *
 * Start a new crawl job.
 */
const CrawlSchema = Type.Object({
  url: Type.String(),
  mode: Type.Union(Type.Literal('single'), Type.Literal('sitemap'), Type.Literal('recursive')),
  maxPages: Type.Optional(Type.Number()),
  maxDepth: Type.Optional(Type.Number()),
  jsRender: Type.Optional(Type.Boolean()),
  tags: Type.Optional(Type.Array(Type.String())),
});

app.post('/api/knowledge/crawl', async (c) => {
  const body = await c.req.json();

  const validated = CrawlSchema.safeParse(body);
  if (!validated.success) {
    return c.json({ error: 'Invalid request', details: validated.error }, 400);
  }

  const { url, mode, maxPages, maxDepth, jsRender, tags } = validated.data;

  try {
    const result = await crawler.crawl({
      url,
      mode,
      maxPages: maxPages || 100,
      maxDepth: maxDepth || 2,
      jsRender,
      sameDomain: true,
      tags: tags || [],
    });

    return c.json({
      crawlId: result.crawlId,
      status: result.status,
      totalPages: result.totalPages,
      successfulPages: result.successfulPages,
      failedPages: result.failedPages,
      duration: result.duration,
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

/**
 * GET /api/knowledge/crawl/:crawlId
 *
 * Get crawl status.
 */
app.get('/api/knowledge/crawl/:crawlId', async (c) => {
  const { crawlId } = c.req.param();

  const status = await crawler.getCrawlStatus(crawlId);

  if (!status) {
    return c.json({ error: 'Crawl not found' }, 404);
  }

  return c.json(status);
});

// ============================================================================
// SOURCES
// ============================================================================

/**
 * GET /api/knowledge/sources
 *
 * List knowledge sources.
 */
app.get('/api/knowledge/sources', async (c) => {
  const { type, limit = 50 } = c.req.query();

  let sql = 'SELECT * FROM kg_sources WHERE 1=1';
  const params: any[] = [];

  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Number(limit));

  const sources = await datastore.query(sql, params);

  return c.json({ sources });
});

/**
 * GET /api/knowledge/sources/:sourceId
 *
 * Get source details.
 */
app.get('/api/knowledge/sources/:sourceId', async (c) => {
  const { sourceId } = c.req.param();

  const source = await datastore.queryOne(
    'SELECT * FROM kg_sources WHERE id = ?',
    [sourceId]
  );

  if (!source) {
    return c.json({ error: 'Source not found' }, 404);
  }

  return c.json({ source });
});

/**
 * DELETE /api/knowledge/sources/:sourceId
 *
 * Delete a source and all associated data.
 */
app.delete('/api/knowledge/sources/:sourceId', async (c) => {
  const { sourceId } = c.req.param();

  // Delete source (cascade will handle chunks, entity_sources, etc.)
  await datastore.execute('DELETE FROM kg_sources WHERE id = ?', [sourceId]);

  return c.json({ success: true, deleted: sourceId });
});

export default app;
```

## Success Criteria

- [ ] All endpoints implemented
- [ ] Request validation works
- [ ] Error handling works
- [ ] CORS configured
- [ ] Tests pass

## References

- Phase 5 Plan: `docs/plans/graphrag/ZAI-PLAN.md`
