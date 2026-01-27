# Phase 1, Task 01: Pluggable Datastore Interface

**Phase:** 1 - Foundation (Graph Storage + Entity Extraction Core)
**Task:** Design and implement pluggable datastore abstraction layer
**Duration:** 2 days
**Complexity:** Medium
**Depends on:** Phase 0 complete

---

## Task Overview

Create a pluggable datastore interface that allows swapping between SQLite (default) and PostgreSQL (production) for graph storage. This interface will be used by all graph operations.

## Architecture Decision

**Reference:** AD-01 in `docs/plans/graphrag/ZAI-DECISIONS.md`

- **Default:** SQLite with recursive CTE support
- **Optional:** PostgreSQL extension for production scale
- **Future:** Neo4j via separate extension package

## File Structure

```
src/knowledge/datastore/
├── interface.ts           # Core datastore interface
├── sqlite.ts             # SQLite implementation
├── types.ts              # Shared types
└── errors.ts             # Datastore-specific errors
```

## Core Interface

**File:** `src/knowledge/datastore/interface.ts`

```typescript
/**
 * Pluggable datastore interface for graph storage.
 * Supports SQLite (default) and PostgreSQL (production).
 *
 * Reference: docs/plans/graphrag/ZAI-DATASTORE.md
 */

import { z } from 'zod';

// ============================================================================
// TYPES
// ============================================================================

export type DatastoreType = 'sqlite' | 'postgresql';

export interface DatabaseSchema {
  tables: TableSchema[];
  indexes: IndexSchema[];
}

export interface TableSchema {
  name: string;
  columns: ColumnSchema[];
  primaryKey: string[];
  foreignKeys: ForeignKeySchema[];
}

export interface ColumnSchema {
  name: string;
  type: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'JSON';
  nullable: boolean;
  defaultValue?: any;
}

export interface IndexSchema {
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
}

export interface ForeignKeySchema {
  column: string;
  referencedTable: string;
  referencedColumn: string;
  onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT';
}

// ============================================================================
// QUERY RESULTS
// ============================================================================

export interface QueryResult<T> {
  rows: T[];
  rowsAffected: number;
  lastInsertId?: string | number;
}

export interface RunResult {
  rowsAffected: number;
  lastInsertId?: string | number;
}

// ============================================================================
// TRANSACTION
// ============================================================================

export interface Transaction {
  query<T>(sql: string, params?: any[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: any[]): Promise<T | null>;
  execute(sql: string, params?: any[]): Promise<RunResult>;
  batch(statements: BatchStatement[]): Promise<RunResult[]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface BatchStatement {
  sql: string;
  params?: any[];
}

// ============================================================================
// MIGRATIONS
// ============================================================================

export interface Migration {
  version: number;
  name: string;
  up: string;  // SQL to apply migration
  down: string;  // SQL to rollback migration
}

export interface MigrationResult {
  applied: boolean;
  version: number;
  duration: number;
}

// ============================================================================
// VECTOR SEARCH (Optional)
// ============================================================================

export interface VectorResult {
  id: string;
  score: number;
  metadata?: Record<string, any>;
}

// ============================================================================
// CORE INTERFACE
// ============================================================================

/**
 * Relational datastore abstraction for graph persistence.
 *
 * Implementations must support:
 * - Parameterized queries (SQL injection safe)
 * - Transactions with rollback
 * - Schema migrations
 * - Optional vector similarity search
 */
export interface RelationalDatastore {
  /** Human-readable display name */
  readonly displayName: string;

  /** Datastore type */
  readonly type: DatastoreType;

  /** Current schema information */
  getSchema(): Promise<DatabaseSchema>;

  // ------------------------------------------------------------------------
  // QUERIES
  // ------------------------------------------------------------------------

  /**
   * Execute a query and return all rows.
   * @param sql SQL query with placeholders ($1, $2, etc.)
   * @param params Parameter values
   * @returns Array of rows
   */
  query<T>(sql: string, params?: any[]): Promise<T[]>;

  /**
   * Execute a query and return the first row or null.
   */
  queryOne<T>(sql: string, params?: any[]): Promise<T | null>;

  /**
   * Execute a statement (INSERT, UPDATE, DELETE, etc.).
   * @returns Result with rows affected and last insert ID
   */
  execute(sql: string, params?: any[]): Promise<RunResult>;

  /**
   * Execute multiple statements in a single batch.
   * More efficient than individual executes.
   */
  batch(statements: BatchStatement[]): Promise<RunResult[]>;

  // ------------------------------------------------------------------------
  // TRANSACTIONS
  // ------------------------------------------------------------------------

  /**
   * Execute a function within a transaction.
   * Automatically commits on success, rolls back on error.
   */
  transaction<T>(
    fn: (tx: Transaction) => Promise<T>
  ): Promise<T>;

  /**
   * Begin a new transaction manually.
   * Caller must call commit() or rollback().
   */
  beginTransaction(): Promise<Transaction>;

  // ------------------------------------------------------------------------
  // MIGRATIONS
  // ------------------------------------------------------------------------

  /**
   * Apply pending migrations to bring schema to latest version.
   * @param migrations Migrations to apply (must be ordered by version)
   */
  migrate(migrations: Migration[]): Promise<MigrationResult[]>;

  /**
   * Get current schema version.
   */
  getVersion(): Promise<number>;

  // ------------------------------------------------------------------------
  // VECTOR SEARCH (Optional)
  // ------------------------------------------------------------------------

  /**
   * Vector similarity search (if supported).
   * Used for entity name embedding deduplication.
   *
   * @param table Table containing vector column
   * @param column Column containing vectors (BLOB or special type)
   * @param query Query vector
   * @param limit Maximum results to return
   * @param threshold Minimum similarity score (0-1)
   * @returns Sorted results by score (descending)
   */
  vectorSearch?(
    table: string,
    column: string,
    query: number[],
    limit: number,
    threshold?: number
  ): Promise<VectorResult[]>;

  // ------------------------------------------------------------------------
  // LIFECYCLE
  // ------------------------------------------------------------------------

  /**
   * Close database connection and release resources.
   */
  close(): Promise<void>;

  /**
   * Check if database is healthy (connection alive).
   */
  healthCheck(): Promise<boolean>;
}

// ============================================================================
// DATASTORE CONFIG
// ============================================================================

export interface DatastoreConfig {
  type: DatastoreType;
}

export interface SQLiteConfig extends DatastoreConfig {
  type: 'sqlite';
  path: string;
  wal?: boolean;  // Write-Ahead Logging (default: true)
}

export interface PostgreSQLConfig extends DatastoreConfig {
  type: 'postgresql';
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  poolSize?: number;
  connectionTimeout?: number;
}

export type DatastoreConfigWithTypes = SQLiteConfig | PostgreSQLConfig;

// ============================================================================
// FACTORY
// ============================================================================

export interface DatastoreFactory {
  create(config: DatastoreConfigWithTypes): RelationalDatastore;
}

/**
 * Create a datastore instance from configuration.
 */
export function createDatastore(
  config: DatastoreConfigWithTypes
): RelationalDatastore {
  switch (config.type) {
    case 'sqlite':
      const { createSQLiteDatastore } = require('./sqlite');
      return createSQLiteDatastore(config);
    case 'postgresql':
      const { createPostgreSQLDatastore } = require('./postgresql');
      return createPostgreSQLDatastore(config);
    default:
      throw new Error(`Unsupported datastore type: ${(config as any).type}`);
  }
}

// ============================================================================
// PLACEHOLDER STYLES
// ============================================================================

/**
 * Get the placeholder style for a datastore type.
 * SQLite: $1, $2, $3
 * PostgreSQL: $1, $2, $3
 * MySQL: ?, ?, ?
 */
export function getPlaceholderStyle(type: DatastoreType): '$' | '?' {
  switch (type) {
    case 'sqlite':
    case 'postgresql':
      return '$';
    default:
      return '$';
  }
}

/**
 * Convert ? placeholders to $1, $2 style for compatible databases.
 */
export function normalizePlaceholders(
  sql: string,
  from: '?' | '$',
  to: '?' | '$'
): string {
  if (from === to) return sql;

  if (to === '$') {
    let count = 0;
    return sql.replace(/\?/g, () => `$${++count}`);
  } else {
    return sql.replace(/\$\d+/g, '?');
  }
}
```

## SQLite Implementation

**File:** `src/knowledge/datastore/sqlite.ts`

```typescript
/**
 * SQLite implementation of RelationalDatastore.
 *
 * Features:
 * - Recursive CTE support (SQLite 3.38.0+)
 * - Write-Ahead Logging (WAL) mode for concurrency
 * - sqlite-vec extension for vector search
 * - Built-in connection pooling via better-sqlite3
 */

import Database from 'better-sqlite3';
import { open } from 'sqlite';
import type {
  RelationalDatastore,
  Transaction,
  Migration,
  DatastoreConfig,
  QueryResult,
  RunResult,
  BatchStatement,
  VectorResult,
} from './interface.js';

export interface SQLiteDatastoreConfig extends DatastoreConfig {
  type: 'sqlite';
  path: string;
  wal?: boolean;
}

/**
 * Create a SQLite datastore instance.
 */
export async function createSQLiteDatastore(
  config: SQLiteDatastoreConfig
): Promise<RelationalDatastore> {
  const db = await open({
    filename: config.path,
    driver: Database,
  });

  // Enable WAL mode for better concurrency
  if (config.wal !== false) {
    await db.exec('PRAGMA journal_mode = WAL;');
    await db.exec('PRAGMA synchronous = NORMAL;');
  }

  // Enable foreign keys
  await db.exec('PRAGMA foreign_keys = ON;');

  return new SQLiteDatastore(db, config);
}

class SQLiteDatastore implements RelationalDatastore {
  readonly displayName = 'SQLite';
  readonly type = 'sqlite' as const;

  constructor(
    private db: Database.Database,
    private config: SQLiteDatastoreConfig
  ) {}

  async getSchema() {
    // Implementation: Query sqlite_master for schema
    const tables = await this.db.all(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `);
    return { tables, indexes: [] };
  }

  query<T>(sql: string, params?: any[]): Promise<T[]> {
    return this.db.all(sql, params || []);
  }

  queryOne<T>(sql: string, params?: any[]): Promise<T | null> {
    return this.db.get(sql, params || []) as Promise<T | null>;
  }

  async execute(sql: string, params?: any[]): Promise<RunResult> {
    const result = await this.db.run(sql, params || []);
    return {
      rowsAffected: result.changes,
      lastInsertId: result.lastID,
    };
  }

  async batch(statements: BatchStatement[]): Promise<RunResult[]> {
    const results: RunResult[] = [];
    for (const stmt of statements) {
      const result = await this.execute(stmt.sql, stmt.params);
      results.push(result);
    }
    return results;
  }

  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return await this.db.transaction(async (tx) => {
      const transaction = new SQLiteTransaction(tx);
      return await fn(transaction);
    })();
  }

  async beginTransaction(): Promise<Transaction> {
    await this.db.exec('BEGIN TRANSACTION;');
    return new SQLiteTransaction(this.db);
  }

  async migrate(migrations: Migration[]): Promise<MigrationResult[]> {
    // Create migrations table if not exists
    await this.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);

    const currentVersion = await this.getVersion();
    const results: MigrationResult[] = [];

    for (const migration of migrations) {
      if (migration.version <= currentVersion) continue;

      const start = Date.now();
      await this.exec(migration.up);
      await this.run(
        'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)',
        [migration.version, migration.name, Date.now()]
      );

      results.push({
        applied: true,
        version: migration.version,
        duration: Date.now() - start,
      });
    }

    return results;
  }

  async getVersion(): Promise<number> {
    const result = await this.get(
      'SELECT MAX(version) as version FROM _migrations'
    );
    return result?.version || 0;
  }

  /**
   * Vector search using sqlite-vec extension.
   * Requires sqlite-vec to be loaded.
   */
  async vectorSearch(
    table: string,
    column: string,
    query: number[],
    limit: number,
    threshold = 0.0
  ): Promise<VectorResult[]> {
    // Check if sqlite-vec is available
    const extCheck = await this.get(
      "SELECT name FROM pragma_function_list WHERE name = 'vec_distance_cosine'"
    );

    if (!extCheck) {
      throw new Error('sqlite-vec extension not loaded');
    }

    const queryStr = `[${query.join(',')}]`;

    const sql = `
      SELECT
        id,
        1 - (vec_distance_cosine(${column}, ${queryStr})) as score
      FROM ${table}
      WHERE 1 - (vec_distance_cosine(${column}, ${queryStr})) >= ?
      ORDER BY score DESC
      LIMIT ?
    `;

    return this.query(sql, [threshold, limit]);
  }

  async close(): Promise<void> {
    await this.close();
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.get('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  // Private helpers for Database interface compatibility
  private async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  private async run(sql: string, params?: any[]) {
    return this.db.run(sql, params);
  }

  private async get(sql: string, params?: any[]) {
    return this.db.get(sql, params);
  }
}

class SQLiteTransaction implements Transaction {
  constructor(private tx: Database.Transaction) {}

  query<T>(sql: string, params?: any[]): Promise<T[]> {
    return this.tx.all(sql, params || []);
  }

  queryOne<T>(sql: string, params?: any[]): Promise<T | null> {
    return this.tx.get(sql, params || []) as Promise<T | null>;
  }

  async execute(sql: string, params?: any[]): Promise<RunResult> {
    const result = await this.tx.run(sql, params || []);
    return {
      rowsAffected: result.changes,
      lastInsertId: result.lastID,
    };
  }

  async batch(statements: BatchStatement[]): Promise<RunResult[]> {
    const results: RunResult[] = [];
    for (const stmt of statements) {
      const result = await this.execute(stmt.sql, stmt.params);
      results.push(result);
    }
    return results;
  }

  async commit(): Promise<void> {
    // Handled by Database.transaction wrapper
  }

  async rollback(): Promise<void> {
    throw new Error('Rollback handled by Database.transaction wrapper');
  }
}
```

## Dependencies

Add to `package.json`:

```json
{
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "sqlite": "^5.1.1",
    "sqlite-vec": "^0.1.7-alpha.2"
  }
}
```

## Configuration Schema

Add to `src/config/types.ts`:

```typescript
export type DatastoreConfigType = {
  datastore?: {
    type: 'sqlite' | 'postgresql';
    sqlite?: {
      path: string;
      wal?: boolean;
    };
    postgresql?: {
      connectionString?: string;
      host?: string;
      port?: number;
      database?: string;
      user?: string;
      password?: string;
      poolSize?: number;
    };
  };
};
```

## Testing

Create: `src/knowledge/datastore/interface.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { createDatastore, type RelationalDatastore } from './interface.js';

describe('RelationalDatastore Interface', () => {
  let ds: RelationalDatastore;

  it('should create SQLite datastore', async () => {
    ds = createDatastore({
      type: 'sqlite',
      path: ':memory:',
    });

    expect(ds.type).toBe('sqlite');
    expect(await ds.healthCheck()).toBe(true);
  });

  it('should execute queries', async () => {
    const result = await ds.query<{ value: number }>(
      'SELECT 1 as value'
    );
    expect(result[0].value).toBe(1);
  });

  it('should support transactions', async () => {
    await ds.execute('CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)');

    await ds.transaction(async (tx) => {
      await tx.execute('INSERT INTO test (value) VALUES (?)', ['a']);
      await tx.execute('INSERT INTO test (value) VALUES (?)', ['b']);
    });

    const rows = await ds.query<{ value: string }>('SELECT value FROM test');
    expect(rows.length).toBe(2);
  });

  it('should rollback on error', async () => {
    await ds.execute('DELETE FROM test');

    try {
      await ds.transaction(async (tx) => {
        await tx.execute('INSERT INTO test (value) VALUES (?)', ['c']);
        throw new Error('Intentional error');
      });
    } catch {}

    const rows = await ds.query('SELECT COUNT(*) as count FROM test');
    expect(rows[0].count).toBe(0);
  });

  it('should close cleanly', async () => {
    await ds.close();
    expect(await ds.healthCheck()).toBe(false);
  });
});
```

## Success Criteria

- [ ] Interface defined with all required methods
- [ ] SQLite implementation passes tests
- [ ] Transaction rollback works correctly
- [ ] Health check detects connection state
- [ ] Configuration schema added
- [ ] Tests cover: queries, transactions, migrations, errors

## References

- Decision Record: `docs/plans/graphrag/ZAI-DECISIONS.md` AD-01
- Datastore Architecture: `docs/plans/graphrag/ZAI-DATASTORE.md`
- SQLite CTE Support: https://www.sqlite.org/lang_with.html
- sqlite-vec: https://github.com/asg0f/sqlite-vec

## Next Task

Proceed to `02-sqlite-migrations.md` to define graph schema migrations.
