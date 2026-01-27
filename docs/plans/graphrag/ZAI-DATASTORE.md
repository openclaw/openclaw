# Pluggable Relational Datastore Architecture

**Date:** 2026-01-26
**Purpose:** Design pluggable datastore abstraction for SQLite and PostgreSQL
**Status:** Design Document

---

## Executive Summary

**Problem:** Current design hardcodes SQLite, making migration to PostgreSQL difficult.

**Solution:** Introduce a `RelationalDatastore` interface that abstracts database operations, allowing implementations to swap seamlessly.

**Impact:**
- Zero breaking changes to existing repositories/services
- Supports both SQLite (development/local) and PostgreSQL (production/Scale)
- Enables future database backends (MySQL, SQL Server, etc.)
- Maintains SQLite simplicity for local development

**Required Changes:**
1. New `src/datastore/` module with interface and implementations
2. Update existing memory manager to use datastore interface
3. Configuration-driven datastore selection
4. Updated migration path

---

## Part 1: Architecture Overview

### 1.1 Layer Structure

```
┌─────────────────────────────────────────────────────────────────┐
│                     Application Layer                          │
│  (Repositories, Services, CLI, Agents, Knowledge Graph)         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ uses
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Datastore Interface                          │
│                                                               │
│  interface RelationalDatastore {                              │
│    // Query operations                                        │
│    query<T>(sql: string, params?: any[]): Promise<T[]>        │
│    queryOne<T>(sql: string, params?: any[]): Promise<T | null> │
│                                                                 │
│    // Mutation operations                                      │
│    execute(sql: string, params?: any[]): Promise<RunResult>    │
│    batch(statements: BatchStatement[]): Promise<RunResult[]>   │
│                                                                 │
│    // Transaction operations                                   │
│    transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> │
│                                                                 │
│    // Schema operations                                        │
│    migrate(migrations: Migration[]): Promise<void>             │
│    getSchema(): Promise<DatabaseSchema>                       │
│                                                                 │
│    // Vector operations (optional)                             │
│    vectorSearch?(...): Promise<VectorResult[]>                 │
│                                                                 │
│    // Lifecycle                                                │
│    close(): Promise<void>                                      │
│  }                                                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ implements
                              ▼
┌──────────────────────┬──────────────────────┬──────────────────────┐
│   SQLiteDatastore    │  PostgreSQLDatastore │  FutureDatastore...  │
│   (better-sqlite3)   │   (pg / node-postgres)│                      │
└──────────────────────┴──────────────────────┴──────────────────────┘
```

### 1.2 Design Principles

1. **Interface-First** - All code depends on `RelationalDatastore`, never concrete implementations
2. **Capability-Based** - Optional features (vector search, full-text) exposed via optional methods
3. **SQL-Native** - Pass-through SQL queries, no ORM abstractions
4. **Type-Safe** - Full TypeScript generics for query results
5. **Connection Pooling** - Built-in connection management
6. **Transaction Support** - Automatic and manual transaction modes
7. **Migration Awareness** - Schema versioning built into interface

---

## Part 2: Datastore Interface

### 2.1 Core Interface

**Location:** `src/datastore/relational-datastore.interface.ts`

```typescript
/**
 * Result of a database mutation (INSERT, UPDATE, DELETE)
 */
export interface RunResult {
  /** Number of rows affected */
  changes: number;
  /** Last inserted row ID (for auto-increment columns) */
  lastInsertRowid?: number | bigint;
}

/**
 * Batch statement for transactional batch operations
 */
export interface BatchStatement {
  sql: string;
  params?: any[];
}

/**
 * Transaction interface for scoped operations
 */
export interface Transaction {
  /** Execute a query within the transaction */
  query<T>(sql: string, params?: any[]): Promise<T[]>;
  /** Execute a mutation within the transaction */
  execute(sql: string, params?: any[]): Promise<RunResult>;
  /** Commit the transaction */
  commit(): Promise<void>;
  /** Rollback the transaction */
  rollback(): Promise<void>;
}

/**
 * Database schema information
 */
export interface DatabaseSchema {
  /** List of tables in the database */
  tables: string[];
  /** List of indexes */
  indexes: string[];
  /** Schema version (from migrations table) */
  version: number;
  /** Database-specific metadata */
  metadata: Record<string, any>;
}

/**
 * Migration definition for schema evolution
 */
export interface Migration {
  /** Unique migration identifier (e.g., "001_initial_schema") */
  id: string;
  /** Schema version number */
  version: number;
  /** Human-readable description */
  description: string;
  /** SQL statements to apply the migration (may be database-specific) */
  up: {
    sqlite?: string;
    postgresql?: string;
    // Future: mysql, mssql, etc.
  };
  /** SQL statements to rollback the migration */
  down?: {
    sqlite?: string;
    postgresql?: string;
  };
}

/**
 * Vector search result for semantic search
 */
export interface VectorResult {
  /** ID of the matching row */
  id: string;
  /** Similarity score (0-1, higher is better) */
  score: number;
  /** Associated row data */
  row?: Record<string, any>;
}

/**
 * Core relational datastore interface
 *
 * All database operations MUST go through this interface.
 * Repositories and services should NEVER import concrete implementations directly.
 */
export interface RelationalDatastore {
  /** Human-readable identifier for logging */
  readonly displayName: string;

  /** Database type identifier */
  readonly type: 'sqlite' | 'postgresql' | string;

  // ===== Query Operations =====

  /**
   * Execute a SELECT query and return all matching rows
   * @param sql SQL query with placeholders (? for SQLite, $1, $2 for PostgreSQL)
   * @param params Parameter values for placeholders
   * @returns Array of rows matching the query result type
   */
  query<T extends Record<string, any> = any>(
    sql: string,
    params?: any[]
  ): Promise<T[]>;

  /**
   * Execute a SELECT query and return the first row or null
   * @param sql SQL query with placeholders
   * @param params Parameter values for placeholders
   * @returns First matching row or null if no results
   */
  queryOne<T extends Record<string, any> = any>(
    sql: string,
    params?: any[]
  ): Promise<T | null>;

  // ===== Mutation Operations =====

  /**
   * Execute a mutation (INSERT, UPDATE, DELETE)
   * @param sql SQL statement with placeholders
   * @param params Parameter values for placeholders
   * @returns Result metadata including affected rows
   */
  execute(sql: string, params?: any[]): Promise<RunResult>;

  /**
   * Execute multiple statements in a single transaction
   * @param statements Array of SQL statements to execute
   * @returns Array of results for each statement
   */
  batch(statements: BatchStatement[]): Promise<RunResult[]>;

  // ===== Transaction Operations =====

  /**
   * Execute a function within a transaction
   * - If the function returns successfully, the transaction commits
   * - If the function throws, the transaction rolls back
   * @param fn Function to execute within transaction
   * @returns Return value of the function
   */
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;

  // ===== Schema Operations =====

  /**
   * Run database migrations to bring schema to current version
   * - Tracks applied migrations in a migrations table
   * - Only runs migrations that haven't been applied yet
   * @param migrations Array of migrations to apply
   */
  migrate(migrations: Migration[]): Promise<void>;

  /**
   * Get current database schema information
   * @returns Schema metadata including tables, indexes, version
   */
  getSchema(): Promise<DatabaseSchema>;

  // ===== Vector Operations (Optional) =====

  /**
   * Perform vector similarity search (if supported)
   * - Uses sqlite-vec for SQLite
   * - Uses pgvector for PostgreSQL
   * @param table Table containing vector column
   * @param column Name of the vector column
   * @param query Query embedding vector
   * @param limit Maximum number of results
   * @param filter Optional WHERE clause conditions
   * @returns Array of similar rows with scores
   */
  vectorSearch?(
    table: string,
    column: string,
    query: number[],
    limit: number,
    filter?: string
  ): Promise<VectorResult[]>;

  // ===== Full-Text Search (Optional) =====

  /**
   * Perform full-text search (if supported)
   * - Uses FTS5 for SQLite
   * - Uses GIN indexes for PostgreSQL
   * @param table Table to search
   * @param columns Columns to search
   * @param query Search query
   * @param limit Maximum number of results
   * @returns Array of matching rows with relevance scores
   */
  fullTextSearch?(
    table: string,
    columns: string[],
    query: string,
    limit: number
  ): Promise<VectorResult[]>;

  // ===== Lifecycle =====

  /**
   * Close database connections and cleanup resources
   */
  close(): Promise<void>;
}

/**
 * Datastore factory configuration
 */
export interface DatastoreConfig {
  /** Datastore type identifier */
  type: 'sqlite' | 'postgresql';

  /** SQLite-specific configuration */
  sqlite?: {
    /** Path to SQLite database file */
    path: string;
    /** Enable WAL mode for better concurrency */
    wal?: boolean;
    /** Maximum number of connections in pool */
    poolSize?: number;
  };

  /** PostgreSQL-specific configuration */
  postgresql?: {
    /** Connection string or connection parameters */
    connectionString?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    /** Maximum number of connections in pool */
    poolSize?: number;
    /** Connection timeout in milliseconds */
    timeout?: number;
  };

  /** Enable query logging (development only) */
  logging?: boolean;
}

/**
 * Datastore factory function
 * Creates appropriate datastore implementation based on configuration
 */
export interface DatastoreFactory {
  create(config: DatastoreConfig): Promise<RelationalDatastore>;
}
```

### 2.2 SQL Dialect Handling

**Challenge:** SQLite uses `?` placeholders, PostgreSQL uses `$1, $2, ...`

**Solution:** Abstract SQL building behind query builders or normalize at runtime.

**Option A: Runtime Placeholder Normalization**

```typescript
// datastore/sql-normalizer.ts
export function normalizeSQL(
  sql: string,
  params: any[],
  dialect: 'sqlite' | 'postgresql'
): { sql: string; params: any[] } {
  if (dialect === 'postgresql') {
    // Convert ? placeholders to $1, $2, ...
    let paramIndex = 0;
    const normalizedSQL = sql.replace(/\?/g, () => `$${++paramIndex}`);
    return { sql: normalizedSQL, params };
  }
  return { sql, params };
}
```

**Option B: Query Builder (Preferred for Complex Queries)**

```typescript
// datastore/query-builder.ts
export class QueryBuilder {
  private conditions: string[] = [];
  private params: any[] = [];

  select(columns: string): this {
    this.query = `SELECT ${columns}`;
    return this;
  }

  from(table: string): this {
    this.query += ` FROM ${table}`;
    return this;
  }

  where(column: string, operator: string, value: any): this {
    this.conditions.push(`${column} ${operator} ?`);
    this.params.push(value);
    return this;
  }

  build(): { sql: string; params: any[] } {
    if (this.conditions.length) {
      this.query += ` WHERE ${this.conditions.join(' AND ')}`;
    }
    return { sql: this.query, params: this.params };
  }
}

// Usage:
const builder = new QueryBuilder()
  .select('*')
  .from('chunks')
  .where('entity_id', '=', entityId)
  .where('created_at', '>', startDate);

const { sql, params } = builder.build();
// SQL dialect normalization happens in datastore implementation
```

---

## Part 3: SQLite Implementation

### 3.1 SQLite Datastore

**Location:** `src/datastore/implementations/sqlite-datastore.ts`

```typescript
import Database from 'better-sqlite3';
import { open } from 'sqlite';
import type {
  RelationalDatastore,
  DatastoreConfig,
  RunResult,
  BatchStatement,
  Transaction,
  Migration,
} from '../relational-datastore.interface.js';

/**
 * SQLite implementation of RelationalDatastore
 * Uses better-sqlite3 for synchronous operations with async wrapper
 */
export class SQLiteDatastore implements RelationalDatastore {
  readonly displayName = 'SQLite';
  readonly type = 'sqlite' as const;

  private db: Database.Database | null = null;
  private config: DatastoreConfig['sqlite'];

  constructor(config: DatastoreConfig['sqlite']) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    this.db = await open({
      filename: this.config.path,
      driver: Database,
    });

    // Enable WAL mode for better concurrency
    if (this.config.wal !== false) {
      await this.db.exec('PRAGMA journal_mode = WAL');
      await this.db.exec('PRAGMA synchronous = NORMAL');
    }

    // Performance optimizations
    await this.db.exec('PRAGMA foreign_keys = ON');
    await this.db.exec('PRAGMA temp_store = MEMORY');
  }

  async query<T>(sql: string, params?: any[]): Promise<T[]> {
    this.ensureInitialized();
    const stmt = this.db!.prepare(sql);
    return stmt.all(...(params || [])) as T[];
  }

  async queryOne<T>(sql: string, params?: any[]): Promise<T | null> {
    this.ensureInitialized();
    const stmt = this.db!.prepare(sql);
    return stmt.get(...(params || [])) as T || null;
  }

  async execute(sql: string, params?: any[]): Promise<RunResult> {
    this.ensureInitialized();
    const stmt = this.db!.prepare(sql);
    const result = stmt.run(...(params || []));
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  async batch(statements: BatchStatement[]): Promise<RunResult[]> {
    return this.transaction(async (tx) => {
      const results: RunResult[] = [];
      for (const stmt of statements) {
        const result = await tx.execute(stmt.sql, stmt.params);
        results.push(result);
      }
      return results;
    });
  }

  async transaction<T>(
    fn: (tx: Transaction) => Promise<T>
  ): Promise<T> {
    this.ensureInitialized();
    const txImpl = this.db!.transaction((txFn: any) => {
      const txWrapper: Transaction = {
        query: async (sql: string, params?: any[]) => {
          const stmt = this.db!.prepare(sql);
          return stmt.all(...(params || []));
        },
        execute: async (sql: string, params?: any[]) => {
          const result = this.db!.prepare(sql).run(...(params || []));
          return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
        },
        commit: async () => {}, // No-op for SQLite (auto-commit on success)
        rollback: async () => { throw new Error('Transaction failed'); },
      };
      return txFn(txWrapper);
    });

    return txImpl(fn);
  }

  async migrate(migrations: Migration[]): Promise<void> {
    this.ensureInitialized();

    // Create migrations tracking table
    await this.db!.exec(`
      CREATE TABLE IF NOT EXISTS _datastore_migrations (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        applied_at INTEGER NOT NULL
      )
    `);

    // Get current version
    const current = await this.queryOne<{ version: number }>(
      'SELECT MAX(version) as version FROM _datastore_migrations'
    );
    const currentVersion = current?.version || 0;

    // Apply pending migrations
    for (const migration of migrations) {
      if (migration.version <= currentVersion) continue;

      const sql = migration.up.sqlite || migration.up.postgresql;
      if (!sql) {
        throw new Error(`Migration ${migration.id} has no SQLite SQL`);
      }

      await this.db!.exec('BEGIN');
      try {
        await this.db!.exec(sql);
        await this.db!.run(
          'INSERT INTO _datastore_migrations (id, version, applied_at) VALUES (?, ?, ?)',
          [migration.id, migration.version, Date.now()]
        );
        await this.db!.exec('COMMIT');
      } catch (error) {
        await this.db!.exec('ROLLBACK');
        throw error;
      }
    }
  }

  async getSchema(): Promise<DatabaseSchema> {
    this.ensureInitialized();

    const tables = await this.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    );

    return {
      tables: tables.map(t => t.name),
      indexes: [], // TODO: Query sqlite_master for indexes
      version: await this.getSchemaVersion(),
      metadata: {
        path: this.config.path,
        wal: this.config.wal !== false,
      },
    };
  }

  async vectorSearch(
    table: string,
    column: string,
    query: number[],
    limit: number,
    filter?: string
  ): Promise<VectorResult[]> {
    // Requires sqlite-vec extension
    const whereClause = filter ? `WHERE ${filter}` : '';
    const sql = `
      SELECT
        id,
        distance,
        rowid as id
      FROM ${table}_vec
      WHERE v_id MATCH ?
        AND ${whereClause}
      ORDER BY distance
      LIMIT ${limit}
    `;

    // Convert query vector to sqlite-vec format
    const vecParam = new Float32Array(query).buffer;

    const results = await this.query<any>(sql, [vecParam]);
    return results.map(r => ({
      id: r.id,
      score: 1 - r.distance, // Convert distance to similarity
      row: r,
    }));
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  private ensureInitialized(): asserts this is { db: Database.Database } {
    if (!this.db) {
      throw new Error('SQLiteDatastore not initialized. Call initialize() first.');
    }
  }

  private async getSchemaVersion(): Promise<number> {
    const result = await this.queryOne<{ version: number }>(
      'SELECT MAX(version) as version FROM _datastore_migrations'
    );
    return result?.version || 0;
  }
}
```

### 3.2 SQLite-Specific Features

**Full-Text Search (FTS5):**

```typescript
// Datastore method for FTS5
async fullTextSearch(
  table: string,
  columns: string[],
  query: string,
  limit: number
): Promise<VectorResult[]> {
  const ftsTable = `${table}_fts`;
  const sql = `
    SELECT
      rowid,
      bm25(${ftsTable}) as score
    FROM ${ftsTable}
    WHERE ${ftsTable} MATCH ?
    ORDER BY score
    LIMIT ?
  `;

  const results = await this.query<any>(sql, [query, limit]);
  return results.map(r => ({
    id: r.rowid,
    score: 1 / (1 + r.score), // Convert BM25 to similarity
  }));
}
```

**Recursive CTEs (for Graph Queries):**

```typescript
// Already supported in SQLite 3.38+
async getEntityNeighborhood(
  entityId: string,
  maxHops: number
): Promise<GraphNeighborhood> {
  const sql = `
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
        ON r.source_entity_id = n.entity_id
        OR r.target_entity_id = n.entity_id
      WHERE n.depth < ?
    )
    SELECT DISTINCT e.*
    FROM neighborhood n
    JOIN kg_entities e ON e.entity_id = n.entity_id
    ORDER BY n.depth, e.mention_count DESC
  `;

  const entities = await this.query<Entity>(sql, [entityId, maxHops]);
  // ... fetch relationships
  return { entities, relationships };
}
```

---

## Part 4: PostgreSQL Implementation

### 4.1 PostgreSQL Datastore

**Location:** `src/datastore/implementations/postgresql-datastore.ts`

```typescript
import { Pool, PoolClient } from 'pg';
import type {
  RelationalDatastore,
  DatastoreConfig,
  RunResult,
  BatchStatement,
  Transaction,
  Migration,
} from '../relational-datastore.interface.js';

/**
 * PostgreSQL implementation of RelationalDatastore
 * Uses pg driver with connection pooling
 */
export class PostgreSQLDatastore implements RelationalDatastore {
  readonly displayName = 'PostgreSQL';
  readonly type = 'postgresql' as const;

  private pool: Pool | null = null;
  private config: DatastoreConfig['postgresql'];

  constructor(config: DatastoreConfig['postgresql']) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    this.pool = new Pool({
      connectionString: this.config.connectionString,
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      max: this.config.poolSize || 10,
      connectionTimeoutMillis: this.config.timeout || 30000,
    });

    // Test connection
    const client = await this.pool.connect();
    client.release();
  }

  async query<T>(sql: string, params?: any[]): Promise<T[]> {
    this.ensureInitialized();
    const result = await this.pool!.query(sql, params || []);
    return result.rows as T[];
  }

  async queryOne<T>(sql: string, params?: any[]): Promise<T | null> {
    this.ensureInitialized();
    const result = await this.pool!.query(sql, params || []);
    return result.rows[0] as T || null;
  }

  async execute(sql: string, params?: any[]): Promise<RunResult> {
    this.ensureInitialized();
    const result = await this.pool!.query(sql, params || []);
    return {
      changes: result.rowCount || 0,
      lastInsertRowid: undefined, // PostgreSQL uses RETURNING clause
    };
  }

  async batch(statements: BatchStatement[]): Promise<RunResult[]> {
    return this.transaction(async (tx) => {
      const results: RunResult[] = [];
      for (const stmt of statements) {
        const result = await tx.execute(stmt.sql, stmt.params);
        results.push(result);
      }
      return results;
    });
  }

  async transaction<T>(
    fn: (tx: Transaction) => Promise<T>
  ): Promise<T> {
    this.ensureInitialized();
    const client = await this.pool!.connect();

    try {
      await client.query('BEGIN');

      const txWrapper: Transaction = {
        query: async (sql: string, params?: any[]) => {
          const result = await client.query(sql, params || []);
          return result.rows;
        },
        execute: async (sql: string, params?: any[]) => {
          const result = await client.query(sql, params || []);
          return { changes: result.rowCount || 0 };
        },
        commit: async () => {
          await client.query('COMMIT');
        },
        rollback: async () => {
          await client.query('ROLLBACK');
        },
      };

      const result = await fn(txWrapper);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async migrate(migrations: Migration[]): Promise<void> {
    this.ensureInitialized();

    // Create migrations tracking table
    await this.execute(`
      CREATE TABLE IF NOT EXISTS _datastore_migrations (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        applied_at BIGINT NOT NULL
      )
    `);

    // Get current version
    const current = await this.queryOne<{ version: number }>(
      'SELECT COALESCE(MAX(version), 0) as version FROM _datastore_migrations'
    );
    const currentVersion = current?.version || 0;

    // Apply pending migrations
    for (const migration of migrations) {
      if (migration.version <= currentVersion) continue;

      const sql = migration.up.postgresql || migration.up.sqlite;
      if (!sql) {
        throw new Error(`Migration ${migration.id} has no PostgreSQL SQL`);
      }

      await this.transaction(async (tx) => {
        await tx.execute(sql);
        await tx.execute(
          'INSERT INTO _datastore_migrations (id, version, applied_at) VALUES ($1, $2, $3)',
          [migration.id, migration.version, Date.now()]
        );
      });
    }
  }

  async getSchema(): Promise<DatabaseSchema> {
    const tables = await this.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    );

    return {
      tables: tables.map(t => t.tablename),
      indexes: [], // TODO: Query pg_indexes
      version: await this.getSchemaVersion(),
      metadata: {
        host: this.config.host,
        database: this.config.database,
        poolSize: this.config.poolSize,
      },
    };
  }

  async vectorSearch(
    table: string,
    column: string,
    query: number[],
    limit: number,
    filter?: string
  ): Promise<VectorResult[]> {
    // Requires pgvector extension
    const whereClause = filter ? `AND ${filter}` : '';
    const sql = `
      SELECT
        id,
        1 - (embedding <=> $1) as score
      FROM ${table}
      WHERE 1=1 ${whereClause}
      ORDER BY embedding <=> $1
      LIMIT ${limit}
    `;

    const results = await this.query<any>(sql, [`[${query.join(',')}]`]);
    return results.map(r => ({
      id: r.id,
      score: r.score,
      row: r,
    }));
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  private ensureInitialized(): asserts this is { pool: Pool } {
    if (!this.pool) {
      throw new Error('PostgreSQLDatastore not initialized. Call initialize() first.');
    }
  }

  private async getSchemaVersion(): Promise<number> {
    const result = await this.queryOne<{ version: number }>(
      'SELECT COALESCE(MAX(version), 0) as version FROM _datastore_migrations'
    );
    return result?.version || 0;
  }
}
```

### 4.2 PostgreSQL-Specific Features

**Recursive CTEs (for Graph Queries):**

```typescript
// PostgreSQL uses same syntax as SQLite
async getEntityNeighborhood(
  entityId: string,
  maxHops: number
): Promise<GraphNeighborhood> {
  const sql = `
    WITH RECURSIVE neighborhood(entity_id, depth) AS (
      SELECT $1::text AS entity_id, 0 AS depth
      UNION ALL
      SELECT
        CASE
          WHEN r.source_entity_id = n.entity_id THEN r.target_entity_id
          ELSE r.source_entity_id
        END,
        n.depth + 1
      FROM neighborhood n
      JOIN kg_relationships r
        ON r.source_entity_id = n.entity_id
        OR r.target_entity_id = n.entity_id
      WHERE n.depth < $2
    )
    SELECT DISTINCT e.*
    FROM neighborhood n
    JOIN kg_entities e ON e.entity_id = n.entity_id
    ORDER BY n.depth, e.mention_count DESC
  `;

  const entities = await this.query<Entity>(sql, [entityId, maxHops]);
  return { entities, relationships };
}
```

**Full-Text Search (GIN + to_tsvector):**

```typescript
async fullTextSearch(
  table: string,
  columns: string[],
  query: string,
  limit: number
): Promise<VectorResult[]> {
  const sql = `
    SELECT
      id,
      ts_rank(document, to_tsquery($1)) as score
    FROM ${table}
    WHERE document @@ to_tsquery($1)
    ORDER BY score DESC
    LIMIT $2
  `;

  const results = await this.query<any>(sql, [query, limit]);
  return results.map(r => ({
    id: r.id,
    score: r.score,
  }));
}
```

---

## Part 5: Datastore Factory & Configuration

### 5.1 Factory Implementation

**Location:** `src/datastore/datastore-factory.ts`

```typescript
import type {
  RelationalDatastore,
  DatastoreConfig,
  DatastoreFactory,
} from './relational-datastore.interface.js';
import { SQLiteDatastore } from './implementations/sqlite-datastore.js';
import { PostgreSQLDatastore } from './implementations/postgresql-datastore.js';

/**
 * Factory function to create datastore instances
 * Supports dependency injection for testing
 */
export const createDatastore: DatastoreFactory = async (
  config: DatastoreConfig
): Promise<RelationalDatastore> => {
  let datastore: RelationalDatastore;

  switch (config.type) {
    case 'sqlite':
      datastore = new SQLiteDatastore(config.sqlite || { path: ':memory:' });
      break;
    case 'postgresql':
      if (!config.postgresql) {
        throw new Error('PostgreSQL configuration required');
      }
      datastore = new PostgreSQLDatastore(config.postgresql);
      break;
    default:
      throw new Error(`Unsupported datastore type: ${config.type}`);
  }

  // Initialize the datastore
  await datastore.initialize();

  return datastore;
};

/**
 * Create datastore from environment configuration
 */
export async function createDatastoreFromEnv(): Promise<RelationalDatastore> {
  const type = (process.env.DATASTORE_TYPE || 'sqlite') as DatastoreConfig['type'];

  const config: DatastoreConfig = { type };

  if (type === 'sqlite') {
    config.sqlite = {
      path: process.env.SQLITE_PATH || '~/.clawdbot/memory.db',
      wal: process.env.SQLITE_WAL !== 'false',
    };
  } else if (type === 'postgresql') {
    config.postgresql = {
      connectionString: process.env.DATABASE_URL,
      host: process.env.PG_HOST,
      port: process.env.PG_PORT ? parseInt(process.env.PG_PORT, 10) : undefined,
      database: process.env.PG_DATABASE,
      user: process.env.PG_USER,
      password: process.env.PG_PASSWORD,
      poolSize: process.env.PG_POOL_SIZE ? parseInt(process.env.PG_POOL_SIZE, 10) : 10,
    };
  }

  config.logging = process.env.DATASTORE_LOGGING === 'true';

  return createDatastore(config);
}
```

### 5.2 Configuration Schema

**Location:** `config/types.datastore.ts`

```typescript
export type DatastoreTypeConfig = {
  // Datastore selection
  datastore?: {
    type?: 'sqlite' | 'postgresql';

    // SQLite configuration
    sqlite?: {
      path?: string;  // Default: ~/.clawdbot/memory.db
      wal?: boolean;  // Default: true
    };

    // PostgreSQL configuration
    postgresql?: {
      connectionString?: string;
      host?: string;
      port?: number;
      database?: string;
      user?: string;
      password?: string;
      poolSize?: number;  // Default: 10
    };
  };
};
```

**Example Configuration:**

```yaml
# config.yaml
datastore:
  type: sqlite  # or 'postgresql'
  sqlite:
    path: ~/.clawdbot/memory.db
    wal: true
  # postgresql:
  #   host: localhost
  #   port: 5432
  #   database: clawdbot
  #   user: clawdbot
  #   password: ${CLAWDBOT_DB_PASSWORD}
  #   poolSize: 10
```

---

## Part 6: Repository Pattern Updates

### 6.1 Existing Memory Manager Refactor

**Current:** Direct SQLite usage in `src/infra/memory-manager.ts`

**After:** Uses `RelationalDatastore` interface

```typescript
// src/infra/memory-manager.ts
import type { RelationalDatastore } from '../datastore/relational-datastore.interface.js';

export class MemoryManager {
  private datastore: RelationalDatastore;

  constructor(datastore: RelationalDatastore) {
    this.datastore = datastore;
  }

  // Example: Get chunks by file path
  async getChunksByPath(path: string): Promise<MemoryChunk[]> {
    return this.datastore.query<MemoryChunk>(
      'SELECT * FROM chunks WHERE path = ? ORDER BY start_line',
      [path]
    );
  }

  // Example: Insert new chunk
  async insertChunk(chunk: MemoryChunk): Promise<void> {
    await this.datastore.execute(
      `INSERT INTO chunks (id, path, start_line, end_line, content, embedding)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [chunk.id, chunk.path, chunk.startLine, chunk.endLine, chunk.content, chunk.embedding]
    );
  }

  // Example: Transactional batch insert
  async insertChunks(chunks: MemoryChunk[]): Promise<void> {
    await this.datastore.batch(
      chunks.map(chunk => ({
        sql: `INSERT INTO chunks (id, path, start_line, end_line, content, embedding)
              VALUES (?, ?, ?, ?, ?, ?)`,
        params: [chunk.id, chunk.path, chunk.startLine, chunk.endLine, chunk.content, chunk.embedding],
      }))
    );
  }

  // Example: Graph-aware search (uses vectorSearch if available)
  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    // Standard search using query interface
    const results = await this.datastore.query<SearchResult>(
      'SELECT * FROM search_index WHERE content MATCH ? LIMIT ?',
      [query, options.limit]
    );

    // Graph expansion if datastore supports vector search
    if (this.datastore.vectorSearch && options.useGraph) {
      const graphResults = await this.datastore.vectorSearch(
        'kg_entities',
        'name_embedding',
        options.queryEmbedding,
        options.graphMaxChunks
      );
      // Merge results...
    }

    return results;
  }
}
```

### 6.2 New Repository: Knowledge Graph

**Location:** `src/knowledge/graph.repository.ts`

```typescript
import type { RelationalDatastore } from '../datastore/relational-datastore.interface.js';

export class GraphRepository {
  constructor(private datastore: RelationalDatastore) {}

  async insertEntity(entity: Entity): Promise<void> {
    await this.datastore.execute(
      `INSERT INTO kg_entities (entity_id, name, type, description, mention_count)
       VALUES (?, ?, ?, ?, ?)`,
      [entity.id, entity.name, entity.type, entity.description, entity.mentionCount]
    );
  }

  async getEntityNeighborhood(
    entityId: string,
    maxHops: number
  ): Promise<GraphNeighborhood> {
    // Recursive CTE - same SQL works for both SQLite and PostgreSQL
    const entities = await this.datastore.query<Entity>(
      this.getNeighborhoodSQL(),
      [entityId, maxHops]
    );

    // Fetch relationships
    const relationships = await this.datastore.query<Relationship>(
      `SELECT * FROM kg_relationships
       WHERE source_entity_id = ? OR target_entity_id = ?`,
      [entityId, entityId]
    );

    return { entities, relationships };
  }

  private getNeighborhoodSQL(): string {
    return `
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
          ON r.source_entity_id = n.entity_id
          OR r.target_entity_id = n.entity_id
        WHERE n.depth < ?
      )
      SELECT DISTINCT e.*
      FROM neighborhood n
      JOIN kg_entities e ON e.entity_id = n.entity_id
      ORDER BY n.depth, e.mention_count DESC
    `;
  }
}
```

### 6.3 Migration Repository

**Location:** `src/datastore/migration.repository.ts`

```typescript
import type { RelationalDatastore, Migration } from './relational-datastore.interface.js';

/**
 * Centralized migration definitions
 * All schema changes MUST be added here
 */
export const MIGRATIONS: Migration[] = [
  {
    id: '001_initial_memory_schema',
    version: 1,
    description: 'Initial memory schema with chunks and embeddings',
    up: {
      sqlite: `
        CREATE TABLE IF NOT EXISTS chunks (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          content TEXT NOT NULL,
          embedding BLOB,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
      `,
      postgresql: `
        CREATE TABLE IF NOT EXISTS chunks (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          content TEXT NOT NULL,
          embedding VECTOR(1536),
          created_at BIGINT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
      `,
    },
    down: {
      sqlite: 'DROP TABLE IF EXISTS chunks;',
      postgresql: 'DROP TABLE IF EXISTS chunks;',
    },
  },
  {
    id: '002_knowledge_graph_schema',
    version: 2,
    description: 'Knowledge graph entities and relationships',
    up: {
      sqlite: `
        -- Tables from ZAI-DESIGN.md
        CREATE TABLE IF NOT EXISTS kg_entities (
          entity_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          description TEXT,
          mention_count INTEGER DEFAULT 1,
          first_seen INTEGER NOT NULL,
          last_seen INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS kg_relationships (
          relationship_id TEXT PRIMARY KEY,
          source_entity_id TEXT NOT NULL REFERENCES kg_entities(entity_id),
          target_entity_id TEXT NOT NULL REFERENCES kg_entities(entity_id),
          type TEXT NOT NULL,
          description TEXT,
          keywords TEXT,
          strength INTEGER DEFAULT 5,
          UNIQUE(source_entity_id, target_entity_id, type)
        );

        CREATE INDEX IF NOT EXISTS idx_relationships_source
          ON kg_relationships(source_entity_id);
        CREATE INDEX IF NOT EXISTS idx_relationships_target
          ON kg_relationships(target_entity_id);
      `,
      postgresql: `
        -- Same structure with PostgreSQL types
        CREATE TABLE IF NOT EXISTS kg_entities (
          entity_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          description TEXT,
          mention_count INTEGER DEFAULT 1,
          first_seen BIGINT NOT NULL,
          last_seen BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS kg_relationships (
          relationship_id TEXT PRIMARY KEY,
          source_entity_id TEXT NOT NULL REFERENCES kg_entities(entity_id),
          target_entity_id TEXT NOT NULL REFERENCES kg_entities(entity_id),
          type TEXT NOT NULL,
          description TEXT,
          keywords TEXT[],
          strength INTEGER DEFAULT 5,
          UNIQUE(source_entity_id, target_entity_id, type)
        );

        CREATE INDEX IF NOT EXISTS idx_relationships_source
          ON kg_relationships(source_entity_id);
        CREATE INDEX IF NOT EXISTS idx_relationships_target
          ON kg_relationships(target_entity_id);
      `,
    },
  },
  {
    id: '003_vector_search_extensions',
    version: 3,
    description: 'Add vector search support (sqlite-vec or pgvector)',
    up: {
      sqlite: `
        -- Load sqlite-vec extension
        -- Requires: .load ./vec0

        CREATE VIRTUAL TABLE IF NOT EXISTS kg_entity_names_vec
        USING vec0(
          embedding(float32)
        );

        -- Entity name embeddings for fuzzy matching
        CREATE TABLE IF NOT EXISTS kg_entity_names (
          entity_id TEXT PRIMARY KEY REFERENCES kg_entities(entity_id),
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL,
          embedding BLOB NOT NULL,
          model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
          updated_at INTEGER NOT NULL
        );
      `,
      postgresql: `
        -- Requires: CREATE EXTENSION IF NOT EXISTS vector;

        CREATE TABLE IF NOT EXISTS kg_entity_names (
          entity_id TEXT PRIMARY KEY REFERENCES kg_entities(entity_id),
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL,
          embedding vector(1536) NOT NULL,
          model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
          updated_at BIGINT NOT NULL
        );

        CREATE INDEX ON kg_entity_names
          USING ivfflat (embedding vector_cosine_ops)
          WITH (lists = 100);
      `,
    },
  },
];

/**
 * Run all pending migrations
 */
export async function runMigrations(
  datastore: RelationalDatastore
): Promise<void> {
  await datastore.migrate(MIGRATIONS);
}
```

---

## Part 7: SQL Dialect Differences

### 7.1 Placeholder Syntax

| Feature | SQLite | PostgreSQL |
|---------|--------|------------|
| Placeholders | `?` | `$1`, `$2`, `$3` |
| Example | `SELECT * FROM t WHERE id = ?` | `SELECT * FROM t WHERE id = $1` |

**Solution:** Datastore implementations normalize placeholders internally.

### 7.2 Data Types

| Concept | SQLite | PostgreSQL |
|---------|--------|------------|
| Text | `TEXT` | `TEXT`, `VARCHAR` |
| Integer | `INTEGER` | `INTEGER`, `BIGINT`, `SMALLINT` |
| Float | `REAL` | `REAL`, `DOUBLE PRECISION` |
| Boolean | `INTEGER` (0/1) | `BOOLEAN` |
| Timestamp | `INTEGER` (Unix ms) | `BIGINT` or `TIMESTAMPTZ` |
| Blob/Bytes | `BLOB` | `BYTEA` |
| Array | JSON string | `TEXT[]`, `INTEGER[]` |
| Vector | `BLOB` (sqlite-vec) | `VECTOR(n)` (pgvector) |

**Recommendation:** Use portable types in schema, let implementation handle conversion.

### 7.3 Full-Text Search

| Feature | SQLite | PostgreSQL |
|---------|--------|------------|
| Extension | FTS5 (built-in) | GIN + to_tsquery |
| Create | `CREATE VIRTUAL TABLE t_fts USING fts5(...)` | `CREATE INDEX ... USING GIN (to_tsvector('english', content))` |
| Query | `SELECT * FROM t_fts WHERE t_fts MATCH 'query'` | `SELECT * FROM t WHERE document @@ to_tsquery('query')` |
| Ranking | `bm25(t_fts)` | `ts_rank(document, query)` |

**Recommendation:** Abstract behind `fullTextSearch()` optional method.

### 7.4 Vector Search

| Feature | SQLite | PostgreSQL |
|---------|--------|------------|
| Extension | sqlite-vec | pgvector |
| Storage | `BLOB` (float32 array) | `VECTOR(n)` type |
| Index | `vec0` virtual table | `ivfflat` or `hnsw` |
| Query | `WHERE v_id MATCH ?` | `ORDER BY embedding <=> query` |
| Distance | L2 distance | Cosine, L2, inner product |

**Recommendation:** Abstract behind `vectorSearch()` optional method.

---

## Part 8: Integration Points

### 8.1 Application Initialization

**Location:** `src/index.ts` or `src/infra/index.ts`

```typescript
import { createDatastoreFromEnv } from './datastore/datastore-factory.js';
import { runMigrations } from './datastore/migration.repository.js';
import { MemoryManager } from './memory-manager.js';
import { KnowledgeGraphService } from './knowledge/graph.service.js';

// Initialize datastore
const datastore = await createDatastoreFromEnv();

// Run migrations
await runMigrations(datastore);

// Initialize services (all use datastore interface)
const memoryManager = new MemoryManager(datastore);
const graphService = new KnowledgeGraphService(datastore);
const crawler = new CrawlerService(datastore, graphService);

// Export for use in CLI, agents, etc.
export const services = {
  datastore,
  memoryManager,
  graphService,
  crawler,
};
```

### 8.2 CLI Integration

```typescript
// src/commands/memory.ts
import { services } from '../infra/index.js';

export async function searchCommand(query: string) {
  // Uses datastore through MemoryManager
  const results = await services.memoryManager.search(query, { limit: 10 });
  console.log(results);
}
```

### 8.3 Agent Tool Integration

```typescript
// src/agents/tools/knowledge-tools.ts
export const knowledgeTools = [
  {
    name: 'knowledge_search',
    description: 'Search knowledge graph',
    handler: async (query: string) => {
      // Uses datastore through GraphRepository
      return await graphRepository.search(query);
    },
  },
];
```

---

## Part 9: Testing Strategy

### 9.1 Unit Testing with Mock Datastore

```typescript
// test/memory-manager.test.ts
import { describe, it, expect } from 'vitest';
import { MemoryManager } from '../src/memory-manager.js';
import { MockDatastore } from './mocks/datastore.js';

describe('MemoryManager', () => {
  it('should get chunks by path', async () => {
    const mockDatastore = new MockDatastore();
    const manager = new MemoryManager(mockDatastore);

    mockDatastore.setQueryResult([
      { id: '1', path: 'test.ts', content: 'hello' },
    ]);

    const chunks = await manager.getChunksByPath('test.ts');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].path).toBe('test.ts');
  });
});
```

### 9.2 Integration Testing with Both Datastores

```typescript
// test/integration/datastore-compat.test.ts
import { describe, it, expect } from 'vitest';
import { SQLiteDatastore } from '../src/datastore/implementations/sqlite-datastore.js';
import { PostgreSQLDatastore } from '../src/datastore/implementations/postgresql-datastore.js';
import { MemoryManager } from '../src/memory-manager.js';

describe('Datastore Compatibility', () => {
  const testCases = [
    { name: 'SQLite', create: () => new SQLiteDatastore({ path: ':memory:' }) },
    { name: 'PostgreSQL', create: () => new PostgreSQLDatastore({ /* test config */ }) },
  ];

  for (const { name, create } of testCases) {
    describe(name, () => {
      it('should support basic CRUD', async () => {
        const datastore = await create();
        await datastore.initialize();
        const manager = new MemoryManager(datastore);

        // Test same operations work with both datastores
        await manager.insertChunk({ /* test chunk */ });
        const chunks = await manager.getChunksByPath('test.ts');

        expect(chunks).toHaveLength(1);

        await datastore.close();
      });
    });
  }
});
```

---

## Part 10: Migration Path Updates

### Updated Phase 1: Schema & Storage (Week 1)

**Previous (ZAI-DESIGN.md):**
- Add graph tables to `ensureMemoryIndexSchema()`
- Create migration script for existing data

**Updated:**
1. **Create datastore interface** (`src/datastore/`)
   - Define `RelationalDatastore` interface
   - Implement `SQLiteDatastore`
   - Implement `PostgreSQLDatastore` (stub for now)
   - Create `createDatastore()` factory

2. **Create migration repository**
   - Move existing schema to `MIGRATIONS` array
   - Add knowledge graph migrations
   - Support dialect-specific SQL

3. **Update memory manager**
   - Accept `RelationalDatastore` in constructor
   - Replace direct SQLite calls with interface methods
   - Update all query sites to use interface

4. **Configuration**
   - Add `datastore` config type
   - Support `DATASTORE_TYPE` env var
   - Default to SQLite for local development

### Phase 1.5: PostgreSQL Implementation (Optional, Week 2)

**New Phase:** Implement full PostgreSQL support

1. Complete `PostgreSQLDatastore` implementation
2. Add pgvector support for vector search
3. Add GIN indexes for full-text search
4. Performance testing and optimization
5. Docker compose setup for local PostgreSQL

---

## Part 11: Deployment Considerations

### 11.1 Local Development (SQLite)

```yaml
# docker-compose.dev.yml
services:
  clawdbot:
    build: .
    environment:
      - DATASTORE_TYPE=sqlite
      - SQLITE_PATH=/data/memory.db
    volumes:
      - ./data:/data
```

### 11.2 Production (PostgreSQL)

```yaml
# docker-compose.prod.yml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      - POSTGRES_DB=clawdbot
      - POSTGRES_USER=clawdbot
      - POSTGRES_PASSWORD=${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data

  clawdbot:
    depends_on:
      - postgres
    environment:
      - DATASTORE_TYPE=postgresql
      - PG_HOST=postgres
      - PG_PORT=5432
      - PG_DATABASE=clawdbot
      - PG_USER=clawdbot
      - PG_PASSWORD=${DB_PASSWORD}
      - PG_POOL_SIZE=20

volumes:
  postgres_data:
```

### 11.3 Migration: SQLite → PostgreSQL

```bash
# 1. Export SQLite data
clawdbot datastore export --format jsonl > backup.jsonl

# 2. Switch to PostgreSQL
export DATASTORE_TYPE=postgresql
export DATABASE_URL="postgresql://..."

# 3. Import data
clawdbot datastore import --format jsonl < backup.jsonl
```

---

## Part 12: Checklist for Implementation

### Core Datastore Module

- [ ] Create `src/datastore/` directory
- [ ] Define `RelationalDatastore` interface
- [ ] Create `DatastoreConfig` type
- [ ] Implement `SQLiteDatastore`
- [ ] Implement `PostgreSQLDatastore`
- [ ] Create `createDatastore()` factory
- [ ] Add environment-based configuration

### Migrations

- [ ] Extract existing schema to migrations
- [ ] Add knowledge graph migrations
- [ ] Support dialect-specific SQL (`up.sqlite`, `up.postgresql`)
- [ ] Implement `migrate()` method in both datastores
- [ ] Add migration rollback support

### Repository Updates

- [ ] Update `MemoryManager` to use interface
- [ ] Create `GraphRepository`
- [ ] Update all direct SQL queries
- [ ] Add transaction support where needed

### Optional Features

- [ ] Implement `vectorSearch()` for SQLite (sqlite-vec)
- [ ] Implement `vectorSearch()` for PostgreSQL (pgvector)
- [ ] Implement `fullTextSearch()` for SQLite (FTS5)
- [ ] Implement `fullTextSearch()` for PostgreSQL (GIN)

### Testing

- [ ] Create `MockDatastore` for unit tests
- [ ] Add integration tests for both datastores
- [ ] Test migration rollback
- [ ] Performance benchmarks (SQLite vs PostgreSQL)

### Documentation

- [ ] Update ZAI-DESIGN.md with datastore interface
- [ ] Add datastore configuration docs
- [ ] Document migration path
- [ ] Add deployment guides

---

## Part 13: Key Benefits

1. **Zero Breaking Changes**
   - Existing code continues to work with SQLite
   - Gradual migration path to PostgreSQL

2. **Development Flexibility**
   - Use SQLite locally (no external dependencies)
   - Use PostgreSQL in production (better concurrency)

3. **Future-Proof**
   - Easy to add MySQL, SQL Server, etc.
   - Interface remains stable

4. **Testability**
   - Mock datastore for unit tests
   - In-memory SQLite for integration tests

5. **Performance Options**
   - SQLite for single-user scenarios
   - PostgreSQL for multi-user / high-concurrency

6. **Scalability**
   - Start with SQLite, migrate to PostgreSQL when needed
   - Same application code, different datastore

---

## Conclusion

The pluggable datastore architecture enables:

1. **SQLite-first development** - No external dependencies for local work
2. **PostgreSQL-ready production** - Drop-in replacement when scaling
3. **Interface-based design** - All code depends on abstractions
4. **Dialect-aware migrations** - SQL differences handled at schema level
5. **Optional advanced features** - Vector search, full-text exposed via optional methods

This design changes **zero** application logic - only the storage layer is abstracted.
