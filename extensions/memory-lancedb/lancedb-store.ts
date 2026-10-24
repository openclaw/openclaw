import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type * as LanceDB from "@lancedb/lancedb";
import type * as Arrow from "apache-arrow";
import type { MemoryCategory } from "./config.js";
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
  private generation = 0;
  private closed = false;
  private activeOperations = 0;
  private closingPromise: Promise<void> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
    private readonly storageOptions?: Record<string, string>,
  ) {}

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("MemoryDB is closed");
    }
  }

  // Tracks an admitted operation so close() can drain it before releasing
  // native handles. Admissions are rejected once close() has published its
  // closed intent.
  private async runOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    this.activeOperations += 1;
    try {
      return await operation();
    } finally {
      this.activeOperations -= 1;
    }
  }

  private async ensureInitialized(): Promise<void> {
    this.assertOpen();
    if (this.table) {
      // Retained handles need an explicit refresh to observe external commits.
      await this.table.checkoutLatest();
      this.assertOpen();
      return;
    }
    if (this.initPromise) {
      await this.initPromise;
      this.assertOpen();
      return;
    }

    const generation = this.generation;
    this.initPromise = this.doInitialize(generation).catch((error: unknown) => {
      this.initPromise = null;
      throw error;
    });
    await this.initPromise;
    this.assertOpen();
  }

  private async doInitialize(generation: number): Promise<void> {
    const lancedb = await loadLanceDbModule();
    const connectionOptions: LanceDB.ConnectionOptions = this.storageOptions
      ? { storageOptions: this.storageOptions }
      : {};
    const db = await lancedb.connect(this.dbPath, connectionOptions);
    let table: LanceDB.Table | null = null;
    try {
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

      // The instance may have been closed while initialization was in flight.
      // Never publish handles for a stale generation; the catch below releases
      // the local handles instead.
      if (generation !== this.generation) {
        throw new Error("MemoryDB is closed during initialization");
      }
      this.db = db;
      this.table = table;
    } catch (error) {
      table?.close();
      db.close();
      throw error;
    }
  }

  async store(agentId: string, entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry> {
    return this.runOperation(async () => {
      await this.ensureInitialized();

      const fullEntry: MemoryEntry = {
        ...entry,
        id: randomUUID(),
        createdAt: Date.now(),
      };
      const storedEntry: StoredMemoryRow = { ...fullEntry, agentId };

      await this.table!.add([storedEntry]);
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
    return this.runOperation(async () => {
      await this.ensureInitialized();

      // LanceDB applies metadata predicates before vector ranking. Foreign rows
      // must never enter this agent's candidate set or top-K.
      const results = await this.table!.vectorSearch(vector)
        .where(memoryAgentPredicate(agentId))
        .limit(limit)
        .toArray(executionOptions);

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
    });
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
    return this.runOperation(async () => {
      await this.ensureInitialized();

      let query = this.table!.query()
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
    return this.runOperation(async () => {
      await this.ensureInitialized();
      if (!UUID_PATTERN.test(id)) {
        throw new Error(`Invalid memory ID format: ${id}`);
      }
      const predicate = scopedPredicate(agentId, { column: "id", operator: "=", value: id });
      const result = await this.table!.delete(predicate);
      return result.numDeletedRows > 0;
    });
  }

  // Reopens a closed instance for a new service lifecycle. Generation advances
  // so a new initializer cannot publish into the retired lifecycle.
  reopen(): void {
    this.generation += 1;
    this.closed = false;
  }

  async close(): Promise<void> {
    // Publish the closed intent synchronously: new admissions are rejected and
    // any in-flight or future initialization cannot publish handles.
    this.generation += 1;
    this.closed = true;
    if (this.closingPromise) {
      return this.closingPromise;
    }
    const closing = (async () => {
      try {
        if (this.initPromise) {
          try {
            await this.initPromise;
          } catch {
            // A failed or rejected initialization is still a settled lifecycle.
          }
        }
        // Drain operations already admitted before close published its intent;
        // releasing native handles under an in-flight add/search would corrupt
        // the operation or leak resources.
        while (this.activeOperations > 0) {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
      } finally {
        const table = this.table;
        const db = this.db;
        // Clear the instance first so a throwing native close cannot leave the
        // instance stuck on a rejected closingPromise or leaked handles.
        this.table = null;
        this.db = null;
        this.initPromise = null;
        try {
          table?.close();
        } catch {
          // Native close errors are surfaced by the next operation, not fatal here.
        }
        try {
          db?.close();
        } catch {
          // Native close errors are surfaced by the next operation, not fatal here.
        }
      }
    })();
    // Assign after creating the IIFE and clear only our own promise after it
    // settles; clearing inside the IIFE races the assignment and leaves a
    // resolved promise cached, making every later close skip handle cleanup.
    this.closingPromise = closing;
    try {
      await closing;
    } finally {
      if (this.closingPromise === closing) {
        this.closingPromise = null;
      }
    }
  }
}
