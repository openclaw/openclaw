import { randomUUID } from "node:crypto";
import type * as LanceDB from "@lancedb/lancedb";
import type { MemoryCategory } from "./config.js";
import type { GraphDB } from "./graph.js";
import type { MemoryEntry } from "./recall.js";
import { tracer } from "./tracer.js";

// ============================================================================
// LanceDB Lazy Loader
// ============================================================================

let lancedbImportPromise: Promise<typeof import("@lancedb/lancedb")> | null = null;

const loadLanceDB = async (): Promise<typeof import("@lancedb/lancedb")> => {
  if (!lancedbImportPromise) {
    lancedbImportPromise = import("@lancedb/lancedb");
  }
  try {
    return await lancedbImportPromise;
  } catch (err) {
    throw new Error(`memory-hybrid: failed to load LanceDB. ${String(err)}`, { cause: err });
  }
};

// ============================================================================
// Memory Database (LanceDB)
// ============================================================================

export type MemorySearchResult = {
  entry: MemoryEntry;
  score: number;
};

const TABLE_NAME = "memories";

/** Validate that an ID is a proper UUID to prevent SQL injection */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateId(id: string): string {
  if (!UUID_REGEX.test(id)) throw new Error(`Invalid memory ID format: ${id}`);
  return id;
}

export class MemoryDB {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Set of column names that actually exist in the DB.
   * Populated during init to guard against schema mismatches with older DBs.
   */
  private availableColumns: Set<string> = new Set();

  /**
   * In-memory recall count deltas.
   * Instead of doing risky DELETE+INSERT on every recall, we accumulate
   * increments here and flush them to DB periodically in batch.
   */
  private recallCountDeltas: Map<string, number> = new Map();

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
  ) {}

  private async ensureInitialized(): Promise<void> {
    if (this.table) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  /** All columns the code expects — new DBs get all of these. */
  private static readonly ALL_COLUMNS = [
    "id",
    "text",
    "importance",
    "category",
    "createdAt",
    "recallCount",
    "happenedAt",
    "validUntil",
    "summary",
    "emotionalTone",
    "emotionScore",
  ] as const;

  private async doInitialize(): Promise<void> {
    const lancedb = await loadLanceDB();
    this.db = await lancedb.connect(this.dbPath);
    const tables = await this.db.tableNames();

    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
      // Detect which columns the DB actually has (handles older schema versions)
      await this.detectColumns();
    } else {
      this.table = await this.db.createTable(TABLE_NAME, [
        {
          id: "__schema__",
          text: "",
          vector: Array.from({ length: this.vectorDim }).fill(0),
          importance: 0,
          category: "other",
          createdAt: 0,
          recallCount: 0,
          happenedAt: "",
          validUntil: "",
          summary: "",
          emotionalTone: "neutral",
          emotionScore: 0,
        },
      ]);
      await this.table.delete('id = "__schema__"');
      this.availableColumns = new Set(MemoryDB.ALL_COLUMNS);
    }
  }

  /**
   * Probe the table schema by reading one row and recording which columns exist.
   * Logs a warning if important columns are missing (older DB version).
   */
  private async detectColumns(): Promise<void> {
    if (!this.table) return;
    const probeRows = await this.table.query().limit(1).toArray();
    if (probeRows.length === 0) {
      // Empty table — assume full schema (will be created on first insert)
      this.availableColumns = new Set(MemoryDB.ALL_COLUMNS);
      return;
    }
    this.availableColumns = new Set(Object.keys(probeRows[0]));
    const missing = MemoryDB.ALL_COLUMNS.filter((c) => !this.availableColumns.has(c));
    if (missing.length > 0) {
      console.warn(
        `[memory-hybrid] DB schema is missing columns: ${missing.join(", ")}. ` +
          `Queries will skip these fields. Delete the lancedb folder to recreate with full schema.`,
      );
    }
  }

  /**
   * Return only those column names that actually exist in the DB.
   * Prevents LanceDB "No field named X" errors on older DBs.
   */
  private selectColumns(requested: string[]): string[] {
    return requested.filter((col) => this.availableColumns.has(col));
  }

  /**
   * Safely add rows to LanceDB by stripping columns that don't exist in the schema.
   * Prevents "Found field not in schema" errors on older DBs.
   */
  private async safeAdd(rows: Record<string, unknown>[]): Promise<void> {
    const sanitized = rows.map((row) => {
      const safe: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(row)) {
        if (key === "vector" || this.availableColumns.has(key)) {
          safe[key] = val;
        }
      }
      return safe;
    });
    await this.table!.add(sanitized);
  }

  /** Merge in-memory recall delta into a recallCount value */
  private mergeRecallDelta(id: string, dbRecallCount: number): number {
    const delta = this.recallCountDeltas.get(id) ?? 0;
    return dbRecallCount + delta;
  }

  async store(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry> {
    await this.ensureInitialized();

    const fullEntry: MemoryEntry = {
      ...entry,
      id: randomUUID(),
      createdAt: Date.now(),
      recallCount: 0,
    };

    await this.safeAdd([fullEntry as unknown as Record<string, unknown>]);
    return fullEntry;
  }

  /** Bulk fetch memories by their IDs */
  async getByIds(ids: string[]): Promise<MemoryEntry[]> {
    if (ids.length === 0) return [];
    await this.ensureInitialized();

    // Filter to only valid UUIDs
    const validIds = ids.filter((id) => UUID_REGEX.test(id));
    if (validIds.length === 0) return [];

    const idList = validIds.map((id) => `'${id}'`).join(", ");
    const results = await this.table!.query().where(`id IN (${idList})`).toArray();

    return results as unknown as MemoryEntry[];
  }

  /** Dream Mode Phase 1: Delete low importance noise */
  async cleanupTrash(): Promise<number> {
    await this.ensureInitialized();
    const rows = await this.table!.query().where("importance <= 0.2").toArray();
    if (rows.length === 0) return 0;

    // Extract valid UUIDs to array of strings
    const validRows = rows.filter(
      (r) => typeof r.id === "string" && UUID_REGEX.test(r.id as string),
    );
    if (validRows.length === 0) return 0;

    const ids = validRows.map((r) => `'${r.id}'`).join(", ");
    await this.table!.delete(`id IN (${ids})`);
    return validRows.length;
  }

  /** Dream Mode Phase 2: Fetch specific categories for profiling */
  async getMemoriesByCategory(categories: string[], limit: number = 50): Promise<MemoryEntry[]> {
    await this.ensureInitialized();
    if (categories.length === 0) return [];

    const cats = categories.map((c) => `'${c}'`).join(", ");
    const rows = await this.table!.query().where(`category IN (${cats})`).limit(limit).toArray();
    return rows as unknown as MemoryEntry[];
  }

  /**
   * Multi-Retrieval Search
   * 1. Fetches top N by vector similarity (semantic search)
   * 2. Fetches top M most recent memories (temporal search)
   * Combines and deduplicates them before returning.
   * This fixes the "Vector Blindspot" where recent events are ignored if completely distinct semantically.
   */
  async search(vector: number[], limit = 5, minScore = 0.5): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    // 1. Vector Search
    const vectorResults = await this.table!.vectorSearch(vector)
      .limit(Math.max(limit * 2, 50))
      .toArray();

    // 2. Temporal Search (Recent memories unconditionally)
    const recentRows = await this.table!.query()
      .select(
        this.selectColumns([
          "id",
          "text",
          "importance",
          "category",
          "createdAt",
          "recallCount",
          "happenedAt",
          "validUntil",
          "summary",
          "emotionalTone",
          "emotionScore",
        ]),
      )
      .limit(200) // Fetch last 200 metadata entries to sort in memory
      .toArray();

    recentRows.sort((a, b) => (b.createdAt as number) - (a.createdAt as number));
    const finalRecent = recentRows.slice(0, 20);

    // 3. Combine and Deduplicate
    const combinedMap = new Map<string, Record<string, unknown>>();

    for (const row of vectorResults) {
      combinedMap.set(row.id as string, row);
    }

    // Add recent rows (giving them a baseline distance if they weren't in vector results)
    for (const row of finalRecent) {
      if (!combinedMap.has(row.id as string)) {
        const rowCopy = { ...row };
        rowCopy._distance = 1.0;
        combinedMap.set(row.id as string, rowCopy);
      }
    }

    // LanceDB uses L2 distance; convert to similarity: sim = 1 / (1 + d)
    const mapped = Array.from(combinedMap.values()).map((row) => {
      const distance = (row._distance as number) ?? 0;
      const score = 1 / (1 + distance);
      const id = row.id as string;
      return {
        entry: {
          id,
          text: row.text as string,
          vector: row.vector as number[],
          importance: row.importance as number,
          category: row.category as MemoryCategory,
          createdAt: row.createdAt as number,
          recallCount: this.mergeRecallDelta(id, (row.recallCount as number) ?? 0),
          happenedAt: (row.happenedAt as string) ?? null,
          validUntil: (row.validUntil as string) ?? null,
          summary: (row.summary as string) ?? null,
          emotionalTone: (row.emotionalTone as string) ?? null,
          emotionScore: (row.emotionScore as number) ?? null,
        },
        score,
      };
    });

    return mapped.filter((r) => r.score >= minScore);
  }

  /**
   * Associative Multi-Hop Retrieval (AMHR)
   * 1. Performs standard hybrid search
   * 2. Traverses the knowledge graph from result entities
   * 3. Fetches connected memories by entity matching (LIKE)
   */
  async searchWithAMHR(
    vector: number[],
    limit = 5,
    graphDB: GraphDB,
    minScore = 0.5,
  ): Promise<MemorySearchResult[]> {
    // Phase 1: Standard Search
    const initialResults = await this.search(vector, limit, minScore);
    if (initialResults.length === 0) return [];

    // Phase 2: Graph Discovery
    // Extract entities from current results and traverse
    const entities = initialResults.map((r) => r.entry.text);
    const traversal = await graphDB.traverse(entities, 1, 10);

    const discoveredEntities = new Set<string>();
    for (const edge of traversal.edges) {
      discoveredEntities.add(edge.target);
      discoveredEntities.add(edge.source);
    }

    // Remove entities already in initial results to avoid redundancy
    for (const r of initialResults) {
      discoveredEntities.delete(r.entry.text);
    }

    if (discoveredEntities.size === 0) return initialResults;

    // Phase 3: Fetch Associative Memories
    const associativeResults: MemorySearchResult[] = [];

    // Construct a compatible WHERE clause
    const conditions = Array.from(discoveredEntities).map((e) => {
      const safeE = e.replace(/['%_]/g, "");
      return `text LIKE '%${safeE}%'`;
    });

    if (conditions.length === 0) return initialResults;

    const whereClause = conditions.join(" OR ");

    await this.ensureInitialized();
    const matchedMemories = await this.table!.query().where(whereClause).limit(10).toArray();

    for (const m of matchedMemories) {
      const entry = m as unknown as MemoryEntry;
      if (!initialResults.some((r) => r.entry.id === entry.id)) {
        associativeResults.push({ entry, score: 0.6 });
      }
    }

    return [...initialResults, ...associativeResults].sort((a, b) => b.score - a.score);
  }

  async getById(id: string): Promise<MemoryEntry | null> {
    await this.ensureInitialized();
    validateId(id);
    const rows = await this.table!.query().where(`id = '${id}'`).limit(1).toArray();
    if (rows.length === 0) return null;
    return {
      id: rows[0].id as string,
      text: rows[0].text as string,
      vector: rows[0].vector as number[],
      importance: rows[0].importance as number,
      category: rows[0].category as string,
      createdAt: rows[0].createdAt as number,
      recallCount: this.mergeRecallDelta(id, (rows[0].recallCount as number) ?? 0),
      happenedAt: (rows[0].happenedAt as string) ?? null,
      validUntil: (rows[0].validUntil as string) ?? null,
      summary: (rows[0].summary as string) ?? null,
      emotionalTone: (rows[0].emotionalTone as string) ?? null,
      emotionScore: (rows[0].emotionScore as number) ?? null,
    };
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureInitialized();
    validateId(id);
    await this.table!.delete(`id = '${id}'`);
    this.recallCountDeltas.delete(id);
    return true;
  }

  async count(): Promise<number> {
    await this.ensureInitialized();
    return this.table!.countRows();
  }

  /** List all memories (for consolidation). */
  async listAll(): Promise<MemoryEntry[]> {
    await this.ensureInitialized();
    const rows = await this.table!.query().toArray();
    return rows.map((row) => {
      const id = row.id as string;
      return {
        id,
        text: row.text as string,
        vector: row.vector as number[],
        importance: row.importance as number,
        category: row.category as string,
        createdAt: row.createdAt as number,
        recallCount: this.mergeRecallDelta(id, (row.recallCount as number) ?? 0),
        happenedAt: (row.happenedAt as string) ?? null,
        validUntil: (row.validUntil as string) ?? null,
        summary: (row.summary as string) ?? null,
        emotionalTone: (row.emotionalTone as string) ?? null,
        emotionScore: (row.emotionScore as number) ?? null,
      };
    });
  }

  /** List all memories WITHOUT vectors. */
  async listMetadata(): Promise<Omit<MemoryEntry, "vector">[]> {
    await this.ensureInitialized();
    const rows = await this.table!.query()
      .select(
        this.selectColumns([
          "id",
          "text",
          "importance",
          "category",
          "createdAt",
          "recallCount",
          "happenedAt",
          "validUntil",
          "summary",
          "emotionalTone",
          "emotionScore",
        ]),
      )
      .toArray();
    return rows.map((row) => {
      const id = row.id as string;
      return {
        id,
        text: row.text as string,
        importance: row.importance as number,
        category: row.category as string,
        createdAt: row.createdAt as number,
        recallCount: this.mergeRecallDelta(id, (row.recallCount as number) ?? 0),
        happenedAt: (row.happenedAt as string) ?? null,
        validUntil: (row.validUntil as string) ?? null,
        summary: (row.summary as string) ?? null,
        emotionalTone: (row.emotionalTone as string) ?? null,
        emotionScore: (row.emotionScore as number) ?? null,
      };
    });
  }

  /** Increment recallCount (in-memory only). */
  incrementRecallCount(ids: string[]): void {
    for (const id of ids) {
      this.recallCountDeltas.set(id, (this.recallCountDeltas.get(id) ?? 0) + 1);
    }
  }

  /** Flush recall counts to DB. */
  async flushRecallCounts(): Promise<number> {
    if (this.recallCountDeltas.size === 0) return 0;
    await this.ensureInitialized();

    const entriesToFlush = Array.from(this.recallCountDeltas.entries());
    const ids = entriesToFlush.map(([id]) => id);

    try {
      const existingRows = await this.getByIds(ids);
      if (existingRows.length === 0) {
        this.recallCountDeltas.clear();
        return 0;
      }

      const updatedRows: Record<string, unknown>[] = [];
      const successfullyFlushedIds: string[] = [];

      for (const row of existingRows) {
        const id = row.id;
        const delta = this.recallCountDeltas.get(id) ?? 0;
        if (delta <= 0) continue;

        const updatedRow = {
          ...row,
          recallCount: (row.recallCount ?? 0) + delta,
        };

        delete (updatedRow as any)._distance;
        delete (updatedRow as any)["vector.isValid"];

        updatedRows.push(updatedRow as unknown as Record<string, unknown>);
        successfullyFlushedIds.push(id);
      }

      if (updatedRows.length === 0) return 0;

      const idList = successfullyFlushedIds.map((id) => `'${id}'`).join(", ");
      await this.table!.delete(`id IN (${idList})`);
      await this.safeAdd(updatedRows);

      for (const [id, countAtStart] of entriesToFlush) {
        if (!successfullyFlushedIds.includes(id)) continue;

        const currentDelta = this.recallCountDeltas.get(id) ?? 0;
        const remaining = currentDelta - countAtStart;
        if (remaining <= 0) {
          this.recallCountDeltas.delete(id);
        } else {
          this.recallCountDeltas.set(id, remaining);
        }
      }

      tracer.trace(
        "flush_recall_counts",
        { count: updatedRows.length },
        `Persisted recall counts for ${updatedRows.length} memories.`,
      );

      return updatedRows.length;
    } catch (error) {
      console.warn(
        `[memory-hybrid] flushRecallCounts batch failed:`,
        error instanceof Error ? error.message : String(error),
      );
      return 0;
    }
  }

  get pendingRecallFlushCount(): number {
    return this.recallCountDeltas.size;
  }

  async deleteOldUnused(days: number): Promise<number> {
    await this.ensureInitialized();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const where = `recallCount = 0 AND createdAt < ${cutoff}`;

    const candidates = await this.table!.query().where(where).toArray();
    const toDelete = candidates.filter((row) => !this.recallCountDeltas.has(row.id as string));

    if (toDelete.length > 0) {
      for (const row of toDelete) {
        await this.table!.delete(`id = '${row.id}'`);
      }
    }

    return toDelete.length;
  }
}
