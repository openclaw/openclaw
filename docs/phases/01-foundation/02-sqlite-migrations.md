# Phase 1, Task 02: Graph Schema Migrations

**Phase:** 1 - Foundation (Graph Storage + Entity Extraction Core)
**Task:** Define and implement SQLite graph schema with extensible types
**Duration:** 2 days
**Complexity:** Medium
**Depends on:** Task 01 (Datastore Interface)

---

## Task Overview

Create the database schema for the knowledge graph with support for:
- Entities and relationships
- Extensible user-defined types
- Temporal history tracking
- Extraction progress tracking

## Schema Design Decisions

**Reference:** `docs/plans/graphrag/ZAI-DECISIONS.md`
- AD-05: Extensible Schema for User-Defined Types
- AD-09: Temporal History Tables for Graph Evolution

## File Structure

```
src/knowledge/graph/
├── schema.ts           # Schema definition and migrations
├── types.ts            # Graph-specific types
└── migrations/
    ├── 001_initial_graph_schema.ts
    ├── 002_extensible_types.ts
    ├── 003_temporal_history.ts
    └── 004_extraction_progress.ts
```

## Core Schema

**File:** `src/knowledge/graph/schema.ts`

```typescript
/**
 * Knowledge graph schema for SQLite.
 *
 * Supports:
 * - Entities and relationships
 * - User-defined types (extensible)
 * - Temporal history tracking
 * - Vector embeddings for entity names
 */

import type { Migration } from '../datastore/interface.js';

// ============================================================================
// ENTITY TABLES
// ============================================================================

/**
 * Core entity storage.
 */
export const KG_ENTITIES_TABLE = `
CREATE TABLE IF NOT EXISTS kg_entities (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Core identity
  name TEXT NOT NULL,
  name_hash TEXT NOT NULL,  -- MD5 of normalized name (for Tier 1 dedup)
  name_embedding BLOB,      -- Vector embedding (for Tier 2 dedup)

  -- Type (extensible)
  type TEXT NOT NULL REFERENCES kg_entity_types(name),

  -- Description and metadata
  description TEXT,

  -- Temporal tracking
  first_seen INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  last_seen INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),

  -- Consolidation tracking
  canonical_id TEXT,        -- If merged, points to canonical entity
  merged_from TEXT,         -- JSON array of merged entity IDs

  -- Provenance
  source_count INTEGER DEFAULT 1,  -- Number of sources referencing this

  -- Indexes
  CONSTRAINT fk_canonical FOREIGN KEY (canonical_id) REFERENCES kg_entities(id) ON DELETE SET NULL
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_kg_entities_name ON kg_entities(name);
CREATE INDEX IF NOT EXISTS idx_kg_entities_name_hash ON kg_entities(name_hash);
CREATE INDEX IF NOT EXISTS idx_kg_entities_type ON kg_entities(type);
CREATE INDEX IF NOT EXISTS idx_kg_entities_canonical ON kg_entities(canonical_id);
CREATE INDEX IF NOT EXISTS idx_kg_entities_first_seen ON kg_entities(first_seen);
CREATE INDEX IF NOT EXISTS idx_kg_entities_last_seen ON kg_entities(last_seen);

-- Full-text search on name and description
CREATE VIRTUAL TABLE IF NOT EXISTS kg_entities_fts USING fts5(
  name,
  description,
  content=kg_entities,
  content_rowid=rowid
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS kg_entities_fts_insert AFTER INSERT ON kg_entities BEGIN
  INSERT INTO kg_entities_fts(rowid, name, description)
  VALUES (new.id, new.name, new.description);
END;

CREATE TRIGGER IF NOT EXISTS kg_entities_fts_delete AFTER DELETE ON kg_entities BEGIN
  DELETE FROM kg_entities_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS kg_entities_fts_update AFTER UPDATE OF name, description ON kg_entities BEGIN
  UPDATE kg_entities_fts SET name = new.name, description = new.description
  WHERE rowid = new.id;
END;
`;

/**
 * Relationship storage.
 */
export const KG_RELATIONSHIPS_TABLE = `
CREATE TABLE IF NOT EXISTS kg_relationships (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Entities (source -> target)
  source_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,

  -- Type (extensible)
  type TEXT NOT NULL REFERENCES kg_relationship_types(name),

  -- Relationship details
  description TEXT,
  keywords TEXT,  -- JSON array of keywords
  strength REAL NOT NULL DEFAULT 5.0,  -- 1-10 strength score

  -- Temporal tracking
  first_seen INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  last_seen INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),

  -- Provenance
  source_count INTEGER DEFAULT 1,

  -- Prevent duplicate relationships
  UNIQUE(source_id, target_id, type)
);

-- Indexes for graph traversal
CREATE INDEX IF NOT EXISTS idx_kg_relationships_source ON kg_relationships(source_id);
CREATE INDEX IF NOT EXISTS idx_kg_relationships_target ON kg_relationships(target_id);
CREATE INDEX IF NOT EXISTS idx_kg_relationships_type ON kg_relationships(type);
CREATE INDEX IF NOT EXISTS idx_kg_relationships_strength ON kg_relationships(strength);
CREATE INDEX IF NOT EXISTS idx_kg_relationships_first_seen ON kg_relationships(first_seen);

-- Full-text search on description
CREATE VIRTUAL TABLE IF NOT EXISTS kg_relationships_fts USING fts5(
  description,
  content=kg_relationships,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS kg_relationships_fts_insert AFTER INSERT ON kg_relationships BEGIN
  INSERT INTO kg_relationships_fts(rowid, description) VALUES (new.id, new.description);
END;

CREATE TRIGGER IF NOT EXISTS kg_relationships_fts_delete AFTER DELETE ON kg_relationships BEGIN
  DELETE FROM kg_relationships_fts WHERE rowid = old.id;
END;
`;

// ============================================================================
// EXTENSIBLE TYPE TABLES (AD-05)
// ============================================================================

/**
 * User-defined entity types.
 */
export const KG_ENTITY_TYPES_TABLE = `
CREATE TABLE IF NOT EXISTS kg_entity_types (
  name TEXT PRIMARY KEY,
  icon TEXT,              -- Optional icon identifier (emoji, icon name)
  color TEXT,             -- Optional hex color for UI
  parent_type TEXT,       -- Optional parent type for hierarchies
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  CONSTRAINT fk_parent FOREIGN KEY (parent_type) REFERENCES kg_entity_types(name)
);

-- Seed default entity types
INSERT OR IGNORE INTO kg_entity_types (name, icon, color) VALUES
  ('person', '👤', '#3B82F6'),
  ('org', '🏢', '#10B981'),
  ('repo', '📦', '#8B5CF6'),
  ('concept', '💡', '#F59E0B'),
  ('tool', '🔧', '#EF4444'),
  ('location', '📍', '#EC4899'),
  ('event', '📅', '#6366F1'),
  ('goal', '🎯', '#14B8A6'),
  ('task', '✅', '#84CC16'),
  ('file', '📄', '#64748B');
`;

/**
 * User-defined relationship types.
 */
export const KG_RELATIONSHIP_TYPES_TABLE = `
CREATE TABLE IF NOT EXISTS kg_relationship_types (
  name TEXT PRIMARY KEY,
  direction TEXT NOT NULL DEFAULT 'directed',  -- 'directed' | 'undirected'
  weight_range TEXT DEFAULT '1-10',  -- '1-10' | 'boolean' | custom
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Seed default relationship types
INSERT OR IGNORE INTO kg_relationship_types (name, direction, weight_range) VALUES
  ('depends_on', 'directed', '1-10'),
  ('implements', 'directed', '1-10'),
  ('located_in', 'directed', '1-10'),
  ('created_by', 'directed', '1-10'),
  ('related_to', 'undirected', '1-10'),
  ('part_of', 'directed', '1-10'),
  ('calls', 'directed', '1-10'),
  ('exposes', 'directed', '1-10'),
  ('uses', 'directed', '1-10'),
  ('precedes', 'directed', '1-10');
`;

// ============================================================================
// TEMPORAL HISTORY TABLES (AD-09)
// ============================================================================

/**
 * Entity change history for temporal queries.
 */
export const KG_ENTITY_HISTORY_TABLE = `
CREATE TABLE IF NOT EXISTS kg_entity_history (
  history_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  event TEXT NOT NULL,  -- 'created' | 'updated' | 'merged' | 'deleted'
  data TEXT,  -- JSON snapshot of entity state
  timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_kg_entity_history_entity ON kg_entity_history(entity_id);
CREATE INDEX IF NOT EXISTS idx_kg_entity_history_timestamp ON kg_entity_history(timestamp);
`;

/**
 * Relationship change history.
 */
export const KG_RELATIONSHIP_HISTORY_TABLE = `
CREATE TABLE IF NOT EXISTS kg_relationship_history (
  history_id TEXT PRIMARY KEY,
  rel_id TEXT NOT NULL REFERENCES kg_relationships(id) ON DELETE CASCADE,
  event TEXT NOT NULL,  -- 'created' | 'updated' | 'deleted'
  data TEXT,  -- JSON snapshot
  timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_kg_relationship_history_rel ON kg_relationship_history(rel_id);
CREATE INDEX IF NOT EXISTS idx_kg_relationship_history_timestamp ON kg_relationship_history(timestamp);
`;

// ============================================================================
// EXTRACTION PROGRESS TABLE (for backfill)
// ============================================================================

/**
 * Track extraction progress for backfill operations.
 */
export const KG_EXTRACTION_PROGRESS_TABLE = `
CREATE TABLE IF NOT EXISTS kg_extraction_progress (
  chunk_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,  -- 'pending' | 'processing' | 'done' | 'error'
  attempts INTEGER DEFAULT 0,
  last_attempt INTEGER,
  error_msg TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_kg_extraction_progress_status ON kg_extraction_progress(status);
`;

// ============================================================================
// CHUNK SOURCES (link entities to memory chunks)
// ============================================================================

/**
 * Link entities to the chunks they were extracted from.
 */
export const KG_ENTITY_SOURCES_TABLE = `
CREATE TABLE IF NOT EXISTS kg_entity_sources (
  entity_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL,
  source_type TEXT NOT NULL,  -- 'memory' | 'manual' | 'crawl'
  confidence REAL DEFAULT 1.0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (entity_id, chunk_id, source_type)
);

CREATE INDEX IF NOT EXISTS idx_kg_entity_sources_entity ON kg_entity_sources(entity_id);
CREATE INDEX IF NOT EXISTS idx_kg_entity_sources_chunk ON kg_entity_sources(chunk_id);
`;

/**
 * Link relationships to the chunks they were extracted from.
 */
export const KG_RELATIONSHIP_SOURCES_TABLE = `
CREATE TABLE IF NOT EXISTS kg_relationship_sources (
  rel_id TEXT NOT NULL REFERENCES kg_relationships(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (rel_id, chunk_id, source_type)
);

CREATE INDEX IF NOT EXISTS idx_kg_relationship_sources_rel ON kg_relationship_sources(rel_id);
CREATE INDEX IF NOT EXISTS idx_kg_relationship_sources_chunk ON kg_relationship_sources(chunk_id);
`;

// ============================================================================
// MIGRATIONS
// ============================================================================

export const GRAPH_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_graph_schema',
    up: KG_ENTITIES_TABLE + KG_RELATIONSHIPS_TABLE,
    down: `
      DROP TABLE IF EXISTS kg_relationships;
      DROP TABLE IF EXISTS kg_entities;
      DROP TABLE IF EXISTS kg_relationships_fts;
      DROP TABLE IF EXISTS kg_entities_fts;
    `,
  },
  {
    version: 2,
    name: 'extensible_types',
    up: KG_ENTITY_TYPES_TABLE + KG_RELATIONSHIP_TYPES_TABLE,
    down: `
      DROP TABLE IF EXISTS kg_relationship_types;
      DROP TABLE IF EXISTS kg_entity_types;
    `,
  },
  {
    version: 3,
    name: 'temporal_history',
    up: KG_ENTITY_HISTORY_TABLE + KG_RELATIONSHIP_HISTORY_TABLE,
    down: `
      DROP TABLE IF EXISTS kg_relationship_history;
      DROP TABLE IF EXISTS kg_entity_history;
    `,
  },
  {
    version: 4,
    name: 'extraction_progress',
    up: KG_EXTRACTION_PROGRESS_TABLE,
    down: `
      DROP TABLE IF EXISTS kg_extraction_progress;
    `,
  },
  {
    version: 5,
    name: 'entity_sources',
    up: KG_ENTITY_SOURCES_TABLE + KG_RELATIONSHIP_SOURCES_TABLE,
    down: `
      DROP TABLE IF EXISTS kg_relationship_sources;
      DROP TABLE IF EXISTS kg_entity_sources;
    `,
  },
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get all migrations for the knowledge graph schema.
 */
export function getGraphMigrations(): Migration[] {
  return GRAPH_MIGRATIONS;
}

/**
 * Apply graph schema migrations to a datastore.
 */
export async function migrateGraphSchema(
  datastore: import('../datastore/interface.js').RelationalDatastore
): Promise<void> {
  await datastore.migrate(getGraphMigrations());
}

/**
 * Check if graph schema is up to date.
 */
export async function isGraphSchemaCurrent(
  datastore: import('../datastore/interface.js').RelationalDatastore
): Promise<boolean> {
  const version = await datastore.getVersion();
  return version >= GRAPH_MIGRATIONS[GRAPH_MIGRATIONS.length - 1].version;
}
```

## Graph Types

**File:** `src/knowledge/graph/types.ts`

```typescript
/**
 * Knowledge graph type definitions.
 */

import { z } from 'zod';

// ============================================================================
// ENTITY TYPES
// ============================================================================

export const EntityTypeEnum = z.enum([
  'person',
  'org',
  'repo',
  'concept',
  'tool',
  'location',
  'event',
  'goal',
  'task',
  'file',
  'custom',
]);

export type EntityType = z.infer<typeof EntityTypeEnum>;

export interface Entity {
  id: string;
  name: string;
  nameHash: string;
  nameEmbedding?: number[];
  type: EntityType;
  customType?: string;  // If type === 'custom'
  description?: string;
  firstSeen: number;
  lastSeen: number;
  canonicalId?: string;  // If merged, points to canonical entity
  mergedFrom?: string[];  // IDs of entities merged into this one
  sourceCount: number;
}

export interface EntityTypeDefinition {
  name: string;
  icon?: string;
  color?: string;
  parentType?: string;
  createdAt: number;
}

// ============================================================================
// RELATIONSHIP TYPES
// ============================================================================

export interface Relationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  description?: string;
  keywords: string[];
  strength: number;  // 1-10
  firstSeen: number;
  lastSeen: number;
  sourceCount: number;
}

export interface RelationshipTypeDefinition {
  name: string;
  direction: 'directed' | 'undirected';
  weightRange: string;
  createdAt: number;
}

// ============================================================================
// HISTORY
// ============================================================================

export type EntityHistoryEvent = 'created' | 'updated' | 'merged' | 'deleted';

export interface EntityHistoryEntry {
  historyId: string;
  entityId: string;
  event: EntityHistoryEvent;
  data?: Entity;  // Snapshot of entity state
  timestamp: number;
}

export type RelationshipHistoryEvent = 'created' | 'updated' | 'deleted';

export interface RelationshipHistoryEntry {
  historyId: string;
  relId: string;
  event: RelationshipHistoryEvent;
  data?: Relationship;
  timestamp: number;
}

// ============================================================================
// EXTRACTION
// ============================================================================

export interface EntityExtraction {
  entities: Entity[];
  relationships: Relationship[];
}

// ============================================================================
// GRAPH QUERY RESULTS
// ============================================================================

export interface EntityNeighborhood {
  entity: Entity;
  relationships: Array<{
    relationship: Relationship;
    targetEntity: Entity;
  }>;
}

export interface GraphPath {
  entities: Entity[];
  relationships: Relationship[];
  totalStrength: number;
}

// ============================================================================
// ZOD SCHEMAS
// ============================================================================

export const EntitySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: EntityTypeEnum,
  customType: z.string().optional(),
  description: z.string().optional(),
  firstSeen: z.number(),
  lastSeen: z.number(),
  canonicalId: z.string().optional(),
  mergedFrom: z.array(z.string()).optional(),
  sourceCount: z.number(),
});

export const RelationshipSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  targetId: z.string(),
  type: z.string(),
  description: z.string().optional(),
  keywords: z.array(z.string()),
  strength: z.number().min(1).max(10),
  firstSeen: z.number(),
  lastSeen: z.number(),
  sourceCount: z.number(),
});

export const EntityExtractionSchema = z.object({
  entities: z.array(EntitySchema),
  relationships: z.array(RelationshipSchema),
});
```

## Integration with Memory Schema

**Modify:** `src/memory/memory-schema.ts`

```typescript
/**
 * Integrate knowledge graph tables with existing memory schema.
 *
 * Graph tables are created lazily when knowledge.enabled is true.
 */

import { migrateGraphSchema, isGraphSchemaCurrent } from '../knowledge/graph/schema.js';
import type { RelationalDatastore } from '../knowledge/datastore/interface.js';

export async function ensureMemoryIndexSchema(
  db: RelationalDatastore,
  options: { enableKnowledge?: boolean } = {}
): Promise<void> {
  // ... existing memory schema migrations ...

  // Conditionally add knowledge graph tables
  if (options.enableKnowledge) {
    if (!(await isGraphSchemaCurrent(db))) {
      await migrateGraphSchema(db);
    }
  }
}
```

## Configuration Integration

**Add to:** `src/config/types.agent-defaults.ts`

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
      editDistanceThreshold: number;
    };
    batchSize: number;
    concurrency: number;
  };

  graph: {
    backend: 'sqlite' | 'neo4j';
    // ... backend-specific config
  };
};
```

## Testing

**File:** `src/knowledge/graph/schema.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { createDatastore } from '../datastore/interface.js';
import { migrateGraphSchema, isGraphSchemaCurrent } from './schema.js';

describe('Graph Schema', () => {
  it('should apply all migrations', async () => {
    const ds = createDatastore({ type: 'sqlite', path: ':memory:' });
    await migrateGraphSchema(ds);

    const version = await ds.getVersion();
    expect(version).toBe(5);  // Latest migration version

    await ds.close();
  });

  it('should create entity types table', async () => {
    const ds = createDatastore({ type: 'sqlite', path: ':memory:' });
    await migrateGraphSchema(ds);

    const types = await ds.query<{ name: string }>(
      'SELECT name FROM kg_entity_types'
    );

    expect(types.length).toBeGreaterThan(0);
    expect(types.some(t => t.name === 'person')).toBe(true);

    await ds.close();
  });

  it('should create entities with relationships', async () => {
    const ds = createDatastore({ type: 'sqlite', path: ':memory:' });
    await migrateGraphSchema(ds);

    // Create entity
    await ds.execute(
      `INSERT INTO kg_entities (id, name, name_hash, type, description)
       VALUES ($1, $2, $3, $4, $5)`,
      ['e1', 'Test Entity', 'hash1', 'person', 'A test entity']
    );

    // Query back
    const entity = await ds.queryOne(
      'SELECT * FROM kg_entities WHERE id = $1',
      ['e1']
    );

    expect(entity).toBeDefined();
    expect(entity.name).toBe('Test Entity');

    await ds.close();
  });

  it('should enforce foreign key constraints', async () => {
    const ds = createDatastore({ type: 'sqlite', path: ':memory:' });
    await migrateGraphSchema(ds);

    // Try to create relationship with non-existent entities
    await expect(
      ds.execute(
        `INSERT INTO kg_relationships (id, source_id, target_id, type, strength)
         VALUES ($1, $2, $3, $4, $5)`,
        ['r1', 'nonexistent', 'alsofake', 'depends_on', 5]
      )
    ).rejects.toThrow();

    await ds.close();
  });

  it('should track entity history', async () => {
    const ds = createDatastore({ type: 'sqlite', path: ':memory:' });
    await migrateGraphSchema(ds);

    // Create entity
    await ds.execute(
      `INSERT INTO kg_entities (id, name, name_hash, type)
       VALUES ($1, $2, $3, $4)`,
      ['e1', 'Test', 'hash', 'concept']
    );

    // Record history
    await ds.execute(
      `INSERT INTO kg_entity_history (history_id, entity_id, event, data)
       VALUES ($1, $2, $3, $4)`,
      ['h1', 'e1', 'created', '{"id":"e1","name":"Test"}']
    );

    const history = await ds.query(
      'SELECT * FROM kg_entity_history WHERE entity_id = $1',
      ['e1']
    );

    expect(history.length).toBe(1);
    expect(history[0].event).toBe('created');

    await ds.close();
  });
});
```

## Success Criteria

- [ ] All 5 migrations defined and tested
- [ ] Entity types table seeded with 11 default types
- [ ] Relationship types table seeded with 10 default types
- [ ] Foreign key constraints enforce referential integrity
- [ ] Full-text search tables update via triggers
- [ ] Integration with memory schema working
- [ ] Configuration schema updated

## References

- Decision Records: `docs/plans/graphrag/ZAI-DECISIONS.md` AD-05, AD-09
- Schema Details: `docs/plans/graphrag/ZAI-FINAL-DECISIONS.md`
- Recursive CTEs: https://www.sqlite.org/lang_with.html

## Next Task

Proceed to `03-graph-query-engine.md` to implement graph traversal queries.
