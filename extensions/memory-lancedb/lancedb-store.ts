import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type * as LanceDB from "@lancedb/lancedb";
import type * as Arrow from "apache-arrow";
import type { FileLockHandle } from "openclaw/plugin-sdk/file-lock";
import type { MemoryCategory } from "./config.js";
import { acquireMemoryTableUsage, withExclusiveMemoryTable } from "./lancedb-custody.js";
import { loadLanceDbModule } from "./lancedb-runtime.js";
import {
  hasAgentScopeColumn,
  legacyMemorySchemaError,
  memoryAgentPredicate,
  MEMORY_TABLE_NAME,
  quoteLanceSqlString,
} from "./lancedb-schema.js";

// LanceDB's CJS serializer needs Arrow datatypes from the same module instance.
const { Field, FixedSizeList, Float32, Float64, Schema, Utf8 }: typeof Arrow = createRequire(
  import.meta.url,
)("apache-arrow");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MemoryEntry = {
  id: string;
  text: string;
  vector: number[];
  importance: number;
  category: MemoryCategory;
  createdAt: number;
};

type MemoryListEntry = Omit<MemoryEntry, "vector">;

type MemoryListOptions = {
  orderByCreatedAt?: boolean;
};

export type MemorySearchResult = {
  entry: MemoryEntry;
  score: number;
};

export const MEMORY_QUERY_COLUMNS = ["id", "text", "importance", "category", "createdAt"] as const;
export type MemoryQueryColumn = (typeof MEMORY_QUERY_COLUMNS)[number];
export type MemoryQueryFilter = {
  column: MemoryQueryColumn;
  operator: "=" | "!=" | "<>" | "<" | "<=" | ">" | ">=" | "LIKE";
  value: string | number;
};

type MemoryQueryOptions = {
  columns: MemoryQueryColumn[];
  filter?: MemoryQueryFilter;
  limit?: number;
};

type StoredMemoryRow = MemoryEntry & {
  agentId: string;
};

function createMemoryTableSchema(vectorDim: number): Arrow.Schema {
  return new Schema([
    new Field("id", new Utf8(), true),
    new Field("text", new Utf8(), true),
    new Field("vector", new FixedSizeList(vectorDim, new Field("item", new Float32(), true)), true),
    new Field("importance", new Float64(), true),
    new Field("category", new Utf8(), true),
    new Field("createdAt", new Float64(), true),
    new Field("agentId", new Utf8(), true),
  ]);
}

function formatQueryFilter(filter: MemoryQueryFilter): string {
  const value =
    typeof filter.value === "string" ? quoteLanceSqlString(filter.value) : String(filter.value);
  return `${filter.column} ${filter.operator} ${value}`;
}

function scopedPredicate(agentId: string, filter?: MemoryQueryFilter): string {
  const scope = memoryAgentPredicate(agentId);
  return filter ? `(${scope}) AND (${formatQueryFilter(filter)})` : scope;
}

export class MemoryDB {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;
  private usage: FileLockHandle | null = null;
  private closing: Promise<void> | null = null;
  private closed = false;
  private pending = new Set<Promise<unknown>>();

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
    private readonly storageOptions?: Record<string, string>,
  ) {}

  start(): void {
    if (this.closing) {
      throw new Error("Memory database is still closing");
    }
    this.closed = false;
  }

  private async runOperation<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new Error("Memory database is closed; restart the memory service before using it.");
    }
    const operation = run();
    this.pending.add(operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(operation);
    }
  }

  private useTable<T>(run: (table: LanceDB.Table) => Promise<T>): Promise<T> {
    return this.runOperation(async () => {
      await this.ensureInitialized();
      return await run(this.table!);
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.table) {
      // Retained handles need an explicit refresh to observe external commits.
      await this.table.checkoutLatest();
      return;
    }
    if (this.initPromise) {
      return await this.initPromise;
    }

    this.initPromise = this.doInitialize().catch((error: unknown) => {
      this.initPromise = null;
      throw error;
    });
    return await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const usage = await acquireMemoryTableUsage(this.dbPath);
    let db: LanceDB.Connection | null = null;
    let table: LanceDB.Table | null = null;
    try {
      const lancedb = await loadLanceDbModule();
      db = await lancedb.connect(this.dbPath, { storageOptions: this.storageOptions });
      const tables = await db.tableNames();
      // A competing initializer may need to retry startup before its first version is readable.
      table = tables.includes(MEMORY_TABLE_NAME)
        ? await db.openTable(MEMORY_TABLE_NAME)
        : await db.createEmptyTable(MEMORY_TABLE_NAME, createMemoryTableSchema(this.vectorDim), {
            existOk: true,
          });
      if (!hasAgentScopeColumn(await table.schema())) {
        throw legacyMemorySchemaError();
      }

      this.db = db;
      this.table = table;
      this.usage = usage;
    } catch (error) {
      table?.close();
      db?.close();
      await usage?.release();
      throw error;
    }
  }

  async store(agentId: string, entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry> {
    return await this.useTable(async (table) => {
      const fullEntry: MemoryEntry = {
        ...entry,
        id: randomUUID(),
        createdAt: Date.now(),
      };
      const storedEntry: StoredMemoryRow = { ...fullEntry, agentId };
      await table.add([storedEntry]);
      return fullEntry;
    });
  }

  async search(
    agentId: string,
    vector: number[],
    limit = 5,
    minScore = 0.5,
    executionOptions?: Pick<LanceDB.QueryExecutionOptions, "timeoutMs">,
  ): Promise<MemorySearchResult[]> {
    // LanceDB applies metadata predicates before vector ranking. Foreign rows
    // must never enter this agent's candidate set or top-K.
    const results = await this.useTable((table) =>
      table
        .vectorSearch(vector)
        .where(memoryAgentPredicate(agentId))
        .limit(limit)
        .toArray(executionOptions),
    );

    const mapped = results.map((row) => {
      const distance = row["_distance"] ?? 0;
      const score = 1 / (1 + distance);
      return {
        entry: {
          id: row.id as string,
          text: row.text as string,
          vector: row.vector as number[],
          importance: row.importance as number,
          category: row.category as MemoryEntry["category"],
          createdAt: row.createdAt as number,
        },
        score,
      };
    });

    return mapped.filter((result) => result.score >= minScore);
  }

  async list(
    agentId: string,
    limit?: number,
    options: MemoryListOptions = {},
  ): Promise<MemoryListEntry[]> {
    const rows = await this.query(agentId, {
      columns: [...MEMORY_QUERY_COLUMNS],
      limit: options.orderByCreatedAt ? undefined : limit,
    });
    const entries = rows.map((row) => ({
      id: row.id as string,
      text: row.text as string,
      importance: row.importance as number,
      category: row.category as MemoryEntry["category"],
      createdAt: row.createdAt as number,
    }));
    if (options.orderByCreatedAt) {
      entries.sort((a, b) => b.createdAt - a.createdAt);
    }

    return limit === undefined ? entries : entries.slice(0, limit);
  }

  async query(agentId: string, options: MemoryQueryOptions): Promise<Record<string, unknown>[]> {
    return await this.useTable(async (table) => {
      let query = table
        .query()
        // LanceDB 0.30 replaces rather than combines repeated where() calls.
        // Scope and operator filter stay one predicate so scope cannot be lost.
        .where(scopedPredicate(agentId, options.filter))
        .select(options.columns);
      if (options.limit !== undefined) {
        query = query.limit(options.limit);
      }
      return (await query.toArray()) as Record<string, unknown>[];
    });
  }

  async delete(agentId: string, id: string): Promise<boolean> {
    if (!UUID_PATTERN.test(id)) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }
    const predicate = scopedPredicate(agentId, { column: "id", operator: "=", value: id });
    const result = await this.useTable((table) => table.delete(predicate));
    return result.numDeletedRows > 0;
  }

  async optimize(assertCurrent: () => void = () => {}): Promise<{
    before: { rows: number; fragments: number };
    after: { rows: number; fragments: number };
  }> {
    return await this.runOperation(() =>
      withExclusiveMemoryTable(this.dbPath, async () => {
        const lancedb = await loadLanceDbModule();
        const connection = await lancedb.connect(this.dbPath, {
          storageOptions: this.storageOptions,
        });
        let table: LanceDB.Table | null = null;
        try {
          assertCurrent();
          if (!(await connection.tableNames()).includes(MEMORY_TABLE_NAME)) {
            return { before: { rows: 0, fragments: 0 }, after: { rows: 0, fragments: 0 } };
          }
          table = await connection.openTable(MEMORY_TABLE_NAME);
          const before = await table.stats();
          assertCurrent();
          // The default prunes seven-day-old versions. Preserve all version history.
          await table.optimize({ cleanupOlderThan: new Date(0), deleteUnverified: false });
          const after = await table.stats();
          if (after.numRows !== before.numRows) {
            throw new Error(
              `Memory row count changed during optimization: ${before.numRows} -> ${after.numRows}`,
            );
          }
          return {
            before: { rows: before.numRows, fragments: before.fragmentStats.numFragments },
            after: { rows: after.numRows, fragments: after.fragmentStats.numFragments },
          };
        } finally {
          table?.close();
          connection.close();
        }
      }),
    );
  }

  close(): Promise<void> {
    this.closed = true;
    this.closing ??= (async () => {
      // Native calls are not cancellable; retain custody until accepted work settles.
      await Promise.allSettled(this.pending);
      this.table?.close();
      this.db?.close();
      this.table = null;
      this.db = null;
      this.initPromise = null;
      await this.usage?.release();
      this.usage = null;
    })().finally(() => {
      this.closing = null;
    });
    return this.closing;
  }
}
