/**
 * OpenClaw Memory (Hybrid) Plugin
 *
 * Enhanced long-term memory with:
 * - Vector search via LanceDB
 * - Knowledge Graph for entity relationships
 * - Hybrid recall scoring (vector + recency + importance + graph)
 * - Smart Capture via LLM (extracts individual facts, not whole messages)
 * - OpenAI + Google Gemini support (Gemini is FREE!)
 * - Prompt injection protection
 * - GDPR-compliant forget
 */

import { randomUUID } from "node:crypto";
import type * as LanceDB from "@lancedb/lancedb";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { WorkingMemoryBuffer } from "./buffer.js";
import {
  shouldCapture,
  detectCategory,
  smartCapture,
  formatRelevantMemoriesContext,
  formatRadarContext,
  generateMemorySummary,
} from "./capture.js";
import { ChatModel } from "./chat.js";
import { MEMORY_CATEGORIES, type MemoryCategory, memoryConfigSchema } from "./config.js";
import { clusterBySimilarity, mergeFacts } from "./consolidate.js";
import { DreamService } from "./dream.js";
import { Embeddings, vectorDimsForModel } from "./embeddings.js";
import { GraphDB, extractGraphFromText } from "./graph.js";
import { hybridScore, getGraphEnrichment, type MemoryEntry } from "./recall.js";
import { generateReflection } from "./reflection.js";
import { ConversationStack } from "./stack.js";
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

type MemorySearchResult = {
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
    // Avoid loading entire DB to sort! Use select() and limit()
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
      .limit(200) // Fetch last 200 metadata entries to sort in memory (better than whole DB)
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
        // Approximate a mediocre distance so they don't get filtered out by minScore
        // They will shine during hybridScoring due to their recency
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

    return mapped.filter((r) => r.score >= minScore).slice(0, limit);
  }

  /**
   * Associative Multi-Hop Retrieval (AMHR)
   * 1. Performs standard hybrid search
   * 2. Traverses the knowledge graph from result entities
   * 3. Fetches connected memories that weren't in the initial results
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
    const traversal = graphDB.traverse(entities, 1, 10);

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
    // We search the DB for memories matching discovered entities
    const associativeResults: MemorySearchResult[] = [];

    // Construct a compatible WHERE clause for multiple entities
    // We strictly use discovered entities to avoid full table scans
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
        associativeResults.push({ entry, score: 0.6 }); // Associative boost
      }
    }

    return [...initialResults, ...associativeResults]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
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

  /** List all memories (for consolidation). Returns entries with vectors. */
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

  /** List all memories WITHOUT vectors (lighter on memory — for reflection/timeline). */
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

  /**
   * Increment recallCount for given memory IDs (Memory Reinforcement).
   * SAFE: Only updates in-memory delta map — no DB writes, no data loss risk.
   * Call flushRecallCounts() periodically to persist to DB.
   */
  incrementRecallCount(ids: string[]): void {
    for (const id of ids) {
      this.recallCountDeltas.set(id, (this.recallCountDeltas.get(id) ?? 0) + 1);
    }
  }

  /**
   * Flush accumulated recall count deltas to the database (batch).
   * Should be called periodically (e.g., during consolidation or pruning).
   * Uses DELETE+INSERT per entry but only when explicitly triggered, not on every recall.
   */
  async flushRecallCounts(): Promise<number> {
    if (this.recallCountDeltas.size === 0) return 0;
    await this.ensureInitialized();

    let flushed = 0;
    // Snapshot only the current keys to avoid clearing new increments that arrive during await
    const entriesToFlush = Array.from(this.recallCountDeltas.entries());

    for (const [id, flushedDelta] of entriesToFlush) {
      if (flushedDelta <= 0) {
        this.recallCountDeltas.delete(id);
        continue;
      }
      try {
        validateId(id);
        // Fetch fresh row to ensure we don't resurrect a deleted one
        const row = await this.getById(id);
        if (!row) {
          // It was deleted externally — clear the delta and skip
          this.recallCountDeltas.delete(id);
          continue;
        }

        const updatedRow = {
          ...row,
          recallCount: (row.recallCount ?? 0) + flushedDelta,
        };

        // CRITICAL: We MUST re-verify it still exists before re-inserting
        // because another delete could have happened while we were prepping updatedRow.
        // LanceDB doesn't have native atomic 'update', so we use delete(id) as a guard.
        await this.table!.delete(`id = '${id}'`);

        // If it was already deleted by someone else, delete(id) is a no-op.
        // But we just fetched 'row', so we are likely the only ones doing this flush.

        try {
          await this.safeAdd([updatedRow as unknown as Record<string, unknown>]);

          // Only subtract what we actually flushed.
          // If new increments arrived, they stay in the map.
          const currentDelta = this.recallCountDeltas.get(id) ?? 0;
          const remaining = currentDelta - flushedDelta;
          if (remaining <= 0) {
            this.recallCountDeltas.delete(id);
          } else {
            this.recallCountDeltas.set(id, remaining);
          }

          flushed++;
        } catch (addErr) {
          // Rollback plan...
          await this.safeAdd([row as unknown as Record<string, unknown>]);
          throw addErr;
        }
      } catch (error) {
        console.warn(
          `[memory-hybrid] flushRecallCounts failed for ${id}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return flushed;
  }

  /** Number of pending recall count deltas */
  get pendingRecallFlushCount(): number {
    return this.recallCountDeltas.size;
  }

  /**
   * Synaptic Pruning: Remove memories that are old and never recalled.
   * Also considers in-memory deltas (an entry with pending recalls is NOT "unused").
   * Returns count of deleted memories.
   */
  async deleteOldUnused(days: number): Promise<number> {
    await this.ensureInitialized();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const where = `recallCount = 0 AND createdAt < ${cutoff}`;

    // Get candidates, but filter out any with pending recall deltas
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

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryPlugin = {
  id: "memory-hybrid",
  name: "Memory (Hybrid)",
  description:
    "Enhanced long-term memory with Knowledge Graph, Hybrid Scoring, and Google Gemini support (free!)",
  kind: "memory" as const,
  configSchema: memoryConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = memoryConfigSchema.parse(api.pluginConfig);
    const resolvedDbPath = api.resolvePath(cfg.dbPath);
    const vectorDim = cfg.embedding.outputDimensionality ?? vectorDimsForModel(cfg.embedding.model);
    const db = new MemoryDB(resolvedDbPath, vectorDim);
    const embeddings = new Embeddings(
      cfg.embedding.apiKey,
      cfg.embedding.model,
      cfg.embedding.outputDimensionality,
    );
    const chatModel = new ChatModel(cfg.chatApiKey, cfg.chatModel, cfg.chatProvider);
    const graphDB = new GraphDB(resolvedDbPath);
    const workingMemory = new WorkingMemoryBuffer(50, 0.7, 3);
    const conversationStack = new ConversationStack(30);
    const dreamService = new DreamService(db, chatModel, embeddings, graphDB, api);
    let lastPruneTime = 0;
    const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

    // Load graph on startup (async, non-blocking)
    graphDB.load().catch((err) => {
      api.logger.warn(`memory-hybrid: graph load failed: ${String(err)}`);
    });

    api.logger.info(
      `memory-hybrid: registered (db: ${resolvedDbPath}, model: ${cfg.embedding.model}, provider: ${cfg.embedding.provider})`,
    );

    // Start Dream Mode Background Service
    dreamService.start();

    // ======================================================================
    // Tool: memory_recall
    // ======================================================================

    api.registerTool(
      {
        name: "memory_recall",
        label: "Memory Recall",
        description:
          "Search through long-term memories. Use when you need context about user preferences, past decisions, or previously discussed topics.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
        }),
        async execute(_toolCallId, params) {
          const { query, limit = 5 } = params as {
            query: string;
            limit?: number;
          };
          tracer.trace("memory_recall_start", { query, limit });

          const vector = await embeddings.embed(query);
          api.logger.info(
            `memory-hybrid: recall query="${query}" model="${cfg.embedding.model}" dim=${vector.length} expected=${vectorDim}`,
          );
          const rawResults = await db.search(vector, limit, 0.1);

          if (rawResults.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0 },
            };
          }

          // Apply hybrid scoring
          const scored = hybridScore(rawResults, graphDB);

          // Build response text
          let text = scored
            .map(
              (r, i) =>
                `${i + 1}. [${r.entry.category}] ${r.entry.text} (${(r.finalScore * 100).toFixed(0)}%)`,
            )
            .join("\n");

          // Add graph enrichment
          const graphInfo = getGraphEnrichment(scored, graphDB);
          if (graphInfo) {
            text += graphInfo;
          }

          // Strip vectors for serialization
          const sanitized = scored.map((r) => ({
            id: r.entry.id,
            text: r.entry.text,
            category: r.entry.category,
            importance: r.entry.importance,
            score: r.finalScore,
          }));

          return {
            content: [
              {
                type: "text",
                text: `Found ${scored.length} memories:\n\n${text}`,
              },
            ],
            details: { count: scored.length, memories: sanitized },
          };
        },
      },
      { name: "memory_recall" },
    );

    // ======================================================================
    // Tool: memory_store
    // ======================================================================

    api.registerTool(
      {
        name: "memory_store",
        label: "Memory Store",
        description:
          "Save important information in long-term memory. Use for preferences, facts, decisions.",
        parameters: Type.Object({
          text: Type.String({ description: "Information to remember" }),
          importance: Type.Optional(Type.Number({ description: "Importance 0-1 (default: 0.7)" })),
          category: Type.Optional(
            Type.Unsafe<MemoryCategory>({
              type: "string",
              enum: [...MEMORY_CATEGORIES],
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const {
            text,
            importance = 0.7,
            category = "other",
          } = params as {
            text: string;
            importance?: number;
            category?: MemoryCategory;
          };

          tracer.trace(
            "memory_store_start",
            { text, importance, category },
            "Agent requested memory storage",
          );

          const vector = await embeddings.embed(text);

          // 1. Check for duplicates/contradictions with broader similarity (PHOENIX logic)
          const existing = await db.search(vector, 3, 0.7);

          let actionmsg = "created";
          let replacedId: string | undefined;

          if (existing.length > 0) {
            // Check the most similar memory for contradiction
            const topMatch = existing[0];

            // Only check if it's not an exact duplicate
            if (topMatch.score > 0.98) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Memory already exists: "${topMatch.entry.text}"`,
                  },
                ],
                details: {
                  action: "duplicate",
                  existingId: topMatch.entry.id,
                },
              };
            }

            try {
              const analysis = await chatModel.checkForContradiction(topMatch.entry.text, text);

              if (analysis.action === "ignore_new") {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Memory ignored (duplicate/redundant): ${analysis.reason}`,
                    },
                  ],
                  details: { action: "ignored", reason: analysis.reason },
                };
              }

              if (analysis.action === "update") {
                // Delete the old contradictory memory
                await db.delete(topMatch.entry.id);
                replacedId = topMatch.entry.id;
                actionmsg = "updated";
                api.logger.info(
                  `memory-hybrid: updated memory ${replacedId} -> new (reason: ${analysis.reason})`,
                );
              }
              // If "keep_both", we just proceed to store
            } catch (err) {
              api.logger.warn(`memory-hybrid: contradiction check failed: ${err}`);
            }
          }

          const summary = await generateMemorySummary(text, chatModel);

          const entry = await db.store({
            text,
            vector,
            importance,
            category,
            happenedAt: null,
            validUntil: null,
            summary,
            emotionalTone: "neutral",
            emotionScore: 0,
          });

          // Knowledge Graph extraction (async, non-blocking)
          extractGraphFromText(text, chatModel)
            .then(async (graph) => {
              if (graph.nodes.length > 0 || graph.edges.length > 0) {
                try {
                  await graphDB.modify(() => {
                    for (const node of graph.nodes) graphDB.addNode(node);
                    for (const edge of graph.edges) graphDB.addEdge(edge);
                  });
                  api.logger.info(
                    `memory-hybrid: graph updated (+${graph.nodes.length} nodes, +${graph.edges.length} edges)`,
                  );
                } catch (graphErr) {
                  api.logger.warn(`memory-hybrid: graphDB.modify failed: ${String(graphErr)}`);
                }
              }
            })
            .catch((err) => {
              api.logger.warn(`memory-hybrid: graph extraction failed: ${String(err)}`);
            });

          return {
            content: [
              {
                type: "text",
                text:
                  actionmsg === "updated"
                    ? `Updated memory: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}" (replaced old info)`
                    : `Stored: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`,
              },
            ],
            details: { action: actionmsg, id: entry.id, replacedId },
          };
        },
      },
      { name: "memory_store" },
    );

    // ======================================================================
    // Tool: memory_forget
    // ======================================================================

    api.registerTool(
      {
        name: "memory_forget",
        label: "Memory Forget",
        description: "Delete specific memories. GDPR-compliant.",
        parameters: Type.Object({
          query: Type.Optional(Type.String({ description: "Search to find memory" })),
          memoryId: Type.Optional(Type.String({ description: "Specific memory ID" })),
        }),
        async execute(_toolCallId, params) {
          const { query, memoryId } = params as {
            query?: string;
            memoryId?: string;
          };

          if (memoryId) {
            // Check existence first (Homeostasis: don't lie to user)
            const exists = await db.getById(memoryId);

            if (!exists) {
              return {
                content: [{ type: "text", text: `Memory ${memoryId} not found.` }],
                details: { error: "not_found" },
              };
            }

            await db.delete(memoryId);
            return {
              content: [{ type: "text", text: `Memory ${memoryId} forgotten.` }],
              details: { action: "deleted", id: memoryId },
            };
          }

          if (query) {
            const vector = await embeddings.embed(query);
            const results = await db.search(vector, 5, 0.7);

            if (results.length === 0) {
              return {
                content: [{ type: "text", text: "No matching memories found." }],
                details: { found: 0 },
              };
            }

            // Always show candidates — never auto-delete by vector similarity alone
            const list = results
              .map((r) => `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}...`)
              .join("\n");

            const sanitized = results.map((r) => ({
              id: r.entry.id,
              text: r.entry.text,
              category: r.entry.category,
              score: r.score,
            }));

            return {
              content: [
                {
                  type: "text",
                  text: `Found ${results.length} candidates. Specify memoryId:\n${list}`,
                },
              ],
              details: { action: "candidates", candidates: sanitized },
            };
          }

          return {
            content: [{ type: "text", text: "Provide query or memoryId." }],
            details: { error: "missing_param" },
          };
        },
      },
      { name: "memory_forget" },
    );

    api.registerTool(
      {
        name: "memory_reflect",
        label: "Memory Reflect",
        description:
          "Generate a high-level profile and patterns from all stored memories. Use to understand who the user is holistically, not just individual facts. Requires at least 5 stored memories.",
        parameters: Type.Object({}),
        async execute() {
          const allMemories = await db.listMetadata();

          const result = await generateReflection(
            allMemories.map((m) => ({
              text: m.text,
              category: m.category,
              importance: m.importance,
              recallCount: m.recallCount,
              emotionalTone: m.emotionalTone,
              emotionScore: m.emotionScore,
              happenedAt: m.happenedAt,
            })),
            chatModel,
          );

          const text = [
            `**User Profile** (based on ${result.memoriesAnalyzed} memories)`,
            "",
            result.summary,
            "",
            result.patterns.length > 0
              ? "**Patterns:**\n" + result.patterns.map((p) => `- ${p}`).join("\n")
              : "",
          ]
            .filter(Boolean)
            .join("\n");

          return {
            content: [{ type: "text", text }],
            details: result,
          };
        },
      },
      { name: "memory_reflect" },
    );

    // ======================================================================
    // Tool: memory_fetch_details (Telescope — Stage 3)
    // ======================================================================

    api.registerTool(
      {
        name: "memory_fetch_details",
        label: "Memory Fetch Details",
        description:
          "Fetch the FULL text of specific memories by their IDs. Use this when the star-map summary isn't detailed enough and you need the complete original memory text for a thorough response.",
        parameters: Type.Object({
          ids: Type.Array(Type.String(), { description: "Memory IDs to fetch full text for" }),
        }),
        async execute(_toolCallId, params) {
          const { ids } = params as { ids: string[] };

          if (!ids || ids.length === 0) {
            return {
              content: [{ type: "text", text: "No memory IDs provided." }],
              details: { error: "missing_ids" },
            };
          }

          // Cap to 5 IDs to prevent context overflow
          const limitedIds = ids.slice(0, 5);
          const memories = await db.getByIds(limitedIds);

          if (memories.length === 0) {
            return {
              content: [{ type: "text", text: "No memories found for the provided IDs." }],
              details: { found: 0 },
            };
          }

          const text = memories.map((m) => `[${m.id}] [${m.category}] ${m.text}`).join("\n\n");

          return {
            content: [
              {
                type: "text",
                text: `Full details for ${memories.length} memories:\n\n${text}`,
              },
            ],
            details: { found: memories.length, ids: memories.map((m) => m.id) },
          };
        },
      },
      { name: "memory_fetch_details" },
    );

    // ======================================================================
    // CLI
    // ======================================================================

    api.registerCli(
      ({ program }) => {
        const memory = program.command("ltm").description("Hybrid memory plugin commands");

        memory
          .command("list")
          .description("Show memory count")
          .action(async () => {
            const count = await db.count();
            console.log(`Total memories: ${count}`);
          });

        memory
          .command("search")
          .description("Search memories")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "5")
          .action(async (query, opts) => {
            const vector = await embeddings.embed(query);
            const rawResults = await db.search(vector, parseInt(opts.limit), 0.3);
            const scored = hybridScore(rawResults, graphDB);
            const output = scored.map((r) => ({
              id: r.entry.id,
              text: r.entry.text,
              category: r.entry.category,
              importance: r.entry.importance,
              vectorScore: r.vectorScore,
              finalScore: r.finalScore,
            }));
            console.log(JSON.stringify(output, null, 2));
          });

        memory
          .command("graph")
          .description("Show knowledge graph stats")
          .action(async () => {
            await graphDB.load();
            console.log(`Graph: ${graphDB.nodeCount} nodes, ${graphDB.edgeCount} edges`);
            if (graphDB.nodeCount > 0) {
              console.log("\nNodes:");
              for (const node of graphDB.nodes.values()) {
                console.log(
                  `  - [${node.type}] ${node.id}${node.description ? ` (${node.description})` : ""}`,
                );
              }
            }
          });

        memory
          .command("stats")
          .description("Show memory statistics")
          .action(async () => {
            const count = await db.count();
            await graphDB.load();
            const bufStats = workingMemory.stats();
            console.log(`Memories: ${count}`);
            console.log(`Graph: ${graphDB.nodeCount} nodes, ${graphDB.edgeCount} edges`);
            console.log(
              `Working Memory Buffer: ${bufStats.total} entries (${bufStats.promoted} promoted, ${bufStats.pending} pending)`,
            );
            console.log(`Provider: ${cfg.embedding.provider}`);
            console.log(`Embedding model: ${cfg.embedding.model}`);
            console.log(`Chat model: ${cfg.chatModel}`);
          });

        memory
          .command("timeline")
          .description("Show memories sorted by event date (temporal view)")
          .option("--limit <n>", "Max results", "20")
          .action(async (opts) => {
            const allMemories = await db.listMetadata();
            const withDates = allMemories
              .filter((m) => m.happenedAt && m.happenedAt !== "")
              .sort((a, b) => {
                const dateA = Date.parse(a.happenedAt ?? "");
                const dateB = Date.parse(b.happenedAt ?? "");
                if (isNaN(dateA)) return 1;
                if (isNaN(dateB)) return -1;
                return dateB - dateA; // newest first
              })
              .slice(0, parseInt(opts.limit));

            if (withDates.length === 0) {
              console.log("No temporal memories found yet. Chat more to build your timeline! ⏳");
              return;
            }

            console.log(`📅 Memory Timeline (${withDates.length} events):\n`);
            for (const m of withDates) {
              const expired = m.validUntil && Date.parse(m.validUntil) < Date.now();
              const emoji =
                m.emotionalTone === "happy" || m.emotionalTone === "excited"
                  ? "😊"
                  : m.emotionalTone === "stressed" ||
                      m.emotionalTone === "frustrated" ||
                      m.emotionalTone === "angry"
                    ? "😤"
                    : m.emotionalTone === "sad"
                      ? "😢"
                      : m.emotionalTone === "curious"
                        ? "🤔"
                        : "📌";
              const expiryTag = expired
                ? " [EXPIRED]"
                : m.validUntil
                  ? ` [until ${m.validUntil}]`
                  : "";
              console.log(`  ${m.happenedAt} ${emoji} ${m.text}${expiryTag}`);
            }
          });

        memory
          .command("consolidate")
          .description("Merge similar memories into stronger facts (sleep mode)")
          .option("--threshold <n>", "Similarity threshold (0-1)", "0.85")
          .option("--prune <n>", "Prune unused memories older than N days (default: 90)", "90")
          .option("--dry-run", "Show what would be merged without applying")
          .action(async (opts) => {
            console.log("🧠 Memory Consolidation starting...\n");

            if (opts.prune) {
              const days = parseInt(opts.prune);
              if (days > 0) {
                if (opts.dryRun) {
                  // Just counting for dry run would be complex without modifying method, so skipping exact dry run count or adding count-only method.
                  // For simplicity:
                  console.log(`✂️ [DRY RUN] Would prune unused memories older than ${days} days.`);
                } else {
                  const deleted = await db.deleteOldUnused(days);
                  if (deleted > 0) {
                    console.log(
                      `✂️ Synaptic Pruning: Deleted ${deleted} unused memories (> ${days} days old).`,
                    );
                  }
                }
              }
            }

            const allMemories = await db.listAll();
            console.log(`Found ${allMemories.length} total memories.`);

            if (allMemories.length < 2) {
              console.log("Not enough memories to consolidate.");
              return;
            }

            const threshold = parseFloat(opts.threshold);
            const clusters = clusterBySimilarity(allMemories, threshold);

            if (clusters.length === 0) {
              console.log("No similar memory clusters found. Memory is clean! ✅");
              return;
            }

            console.log(`Found ${clusters.length} cluster(s) to merge:\n`);

            let totalMerged = 0;
            let totalCreated = 0;

            for (const cluster of clusters) {
              const texts = cluster.map((c) => c.text);
              console.log(`📦 Cluster (${cluster.length} items):`);
              for (const t of texts) {
                console.log(`   - "${t.slice(0, 80)}${t.length > 80 ? "..." : ""}"`);
              }

              if (opts.dryRun) {
                console.log("   → [DRY RUN] Would merge these.\n");
                continue;
              }

              const merged = await mergeFacts(texts, chatModel);
              if (!merged) {
                console.log("   → ⚠️ LLM merge failed, skipping.\n");
                continue;
              }

              console.log(`   → ✅ Merged into: "${merged}"`);

              // Preserve best metadata from original cluster
              const clusterEntries = await Promise.all(cluster.map((c) => db.getById(c.id)));
              const validEntries = clusterEntries.filter(
                (e): e is NonNullable<typeof e> => e != null,
              );

              // Pick highest importance, most common category, earliest happenedAt
              const bestImportance = Math.max(0.85, ...validEntries.map((e) => e.importance));
              const categories = validEntries.map((e) => e.category);
              const bestCategory =
                categories.find((c) => c === "decision") ??
                categories.find((c) => c === "preference") ??
                categories.find((c) => c === "entity") ??
                categories.find((c) => c === "fact") ??
                "fact";
              const bestHappenedAt =
                validEntries
                  .map((e) => e.happenedAt)
                  .filter((h): h is string => !!h)
                  .sort()[0] ?? null;
              const bestValidUntil =
                validEntries
                  .map((e) => e.validUntil)
                  .filter((v): v is string => !!v)
                  .sort()
                  .reverse()[0] ?? null;
              const emotionalEntries = validEntries.filter(
                (e) => e.emotionalTone && e.emotionalTone !== "neutral",
              );
              const bestEmotionalTone =
                emotionalEntries.length > 0 ? emotionalEntries[0].emotionalTone : "neutral";
              const bestEmotionScore =
                emotionalEntries.length > 0
                  ? emotionalEntries.reduce(
                      (max, e) =>
                        Math.abs(e.emotionScore ?? 0) > Math.abs(max) ? (e.emotionScore ?? 0) : max,
                      0,
                    )
                  : 0;

              // Store merged memory FIRST (safety: if embed/store fails, originals are preserved)
              const vector = await embeddings.embed(merged);
              const summary = await generateMemorySummary(merged, chatModel);

              await db.store({
                text: merged,
                vector,
                importance: bestImportance,
                category: bestCategory,
                happenedAt: bestHappenedAt,
                validUntil: bestValidUntil,
                summary,
                emotionalTone: bestEmotionalTone,
                emotionScore: bestEmotionScore,
              });

              // Delete old memories only after new one is safely stored
              for (const item of cluster) {
                await db.delete(item.id);
              }

              totalMerged += cluster.length;
              totalCreated++;
              console.log("");
            }

            if (!opts.dryRun) {
              console.log(
                `\n✅ Done! Merged ${totalMerged} memories into ${totalCreated} consolidated facts.`,
              );
            }
          });

        memory
          .command("reflect")
          .description("Generate a high-level user profile from all memories")
          .action(async () => {
            const allMemories = await db.listMetadata();
            console.log(`\n🪞 Reflecting on ${allMemories.length} memories...\n`);

            const result = await generateReflection(
              allMemories.map((m) => ({
                text: m.text,
                category: m.category,
                importance: m.importance,
                recallCount: m.recallCount,
                emotionalTone: m.emotionalTone,
                emotionScore: m.emotionScore,
                happenedAt: m.happenedAt,
              })),
              chatModel,
            );

            console.log(`📝 Summary:\n${result.summary}\n`);
            if (result.patterns.length > 0) {
              console.log("🔍 Patterns:");
              for (const p of result.patterns) {
                console.log(`   - ${p}`);
              }
            }
            console.log(`\n(Analyzed ${result.memoriesAnalyzed} memories)`);
          });
      },
      { commands: ["ltm"] },
    );

    // ======================================================================
    // Lifecycle: Auto-Recall (before_agent_start)
    // ======================================================================

    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event, ctx) => {
        if (!event.prompt || event.prompt.length < 5) return;

        // Skip memory search on system events / automated greetings.
        if (
          ctx?.trigger === "system" ||
          ctx?.trigger === "heartbeat" ||
          ctx?.trigger === "cron" ||
          ctx?.trigger === "memory"
        ) {
          return;
        }

        const nPrompt = event.prompt.trim().toLowerCase();

        // Skip semantic search for generic commands or basic greetings
        if (nPrompt.startsWith("/")) return;
        if (
          /^(hi|hello|hey|start|new chat|привіт|вітаю|почнемо|started a new chat|welcome|що нового)[\s.!?]*$/i.test(
            nPrompt,
          ) ||
          nPrompt.includes("started a new chat") ||
          nPrompt.includes("session started")
        )
          return;

        try {
          // Single embed call for both recall injection AND reinforcement
          const vector = await embeddings.embed(event.prompt);
          const rawResults = await db.searchWithAMHR(vector, 3, graphDB, 0.3);

          if (rawResults.length === 0) return;

          // Apply hybrid scoring for better ranking
          const scored = hybridScore(rawResults, graphDB);

          api.logger.info(`memory-hybrid: injecting ${scored.length} memories`);

          // Stage 3: Use Radar (Star Map) instead of full text injection
          // This sends lightweight summaries + IDs instead of heavy full texts
          const radarContext = formatRadarContext(
            scored.map((r) => ({
              id: r.entry.id,
              category: r.entry.category as MemoryCategory,
              summary: r.entry.summary,
              text: r.entry.text,
            })),
          );

          // Add graph enrichment to context
          const graphInfo = getGraphEnrichment(scored, graphDB);
          let context = radarContext;
          if (graphInfo) {
            context = context.replace("</star-map>", graphInfo + "\n</star-map>");
          }

          // Memory Reinforcement: boost recalled memories (sync, in-memory only)
          // Uses the SAME search results — no extra API call
          const ids = rawResults.map((r) => r.entry.id);
          db.incrementRecallCount(ids);

          return { prependContext: context };
        } catch (err) {
          api.logger.warn(`memory-hybrid: recall failed: ${String(err)}`);
        }
      });
    }

    // ======================================================================
    // Lifecycle: Auto-Capture (agent_end)
    // ======================================================================

    if (cfg.autoCapture) {
      api.on("agent_end", async (event) => {
        if (!event.success || !event.messages || event.messages.length === 0) {
          return;
        }

        try {
          // Extract text from messages
          const userTexts: string[] = [];
          const assistantTexts: string[] = [];

          for (const msg of event.messages) {
            if (!msg || typeof msg !== "object") continue;
            const msgObj = msg as Record<string, unknown>;
            const role = msgObj.role;
            const content = msgObj.content;

            const texts =
              role === "user" ? userTexts : role === "assistant" ? assistantTexts : null;
            if (!texts) continue;

            if (typeof content === "string") {
              texts.push(content);
              continue;
            }

            if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block &&
                  typeof block === "object" &&
                  "type" in block &&
                  (block as Record<string, unknown>).type === "text" &&
                  "text" in block &&
                  typeof (block as Record<string, unknown>).text === "string"
                ) {
                  texts.push((block as Record<string, unknown>).text as string);
                }
              }
            }
          }

          // ---- Rolling Summary Stack: compress this turn ----
          // Non-blocking: accumulate compressed turn for session context
          const lastUserMsg = userTexts.length > 0 ? userTexts[userTexts.length - 1] : "";
          const lastAssistantMsg =
            assistantTexts.length > 0 ? assistantTexts[assistantTexts.length - 1] : "";

          if (lastUserMsg.length > 10 || lastAssistantMsg.length > 10) {
            conversationStack.push(lastUserMsg, lastAssistantMsg, chatModel).catch((err) => {
              api.logger.warn(
                `memory-hybrid: stack compression failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          }

          // ---- Dream Mode Interaction Tracking ----
          dreamService.registerInteraction();

          // ---- Smart Capture (LLM-powered) ----
          // Note: Smart Capture intentionally bypasses Working Memory Buffer.
          // The LLM already decided what's worth storing — buffering would be redundant.
          if (cfg.smartCapture && userTexts.length > 0) {
            // Pre-filter: skip LLM call for trivial messages (saves API quota)
            const isTrivial =
              lastUserMsg.length < 15 ||
              /^(ok|yes|no|y|n|sure|thanks|thx|thank you|lol|haha|hmm|yep|nope|\u{1F44D}|done|got it|cool|nice|great|good|fine|agreed|alright|\u{043E}\u{043A}|\u{0442}\u{0430}\u{043A}|\u{043D}\u{0456}|\u{0434}\u{044F}\u{043A}\u{0443}\u{044E}|\u{044F}\u{0441}\u{043D}\u{043E}|\u{0434}\u{043E}\u{0431}\u{0440}\u{0435})\s*[.!?]?$/iu.test(
                lastUserMsg.trim(),
              );

            const result = isTrivial
              ? { shouldStore: false as const, facts: [] }
              : await smartCapture(lastUserMsg, lastAssistantMsg || undefined, chatModel);

            if (result.shouldStore) {
              let stored = 0;
              // Limit concurrent fact extraction/storing to avoid 429
              for (const fact of result.facts.slice(0, 5)) {
                try {
                  // Pre-check for exact duplicate to save embed API call
                  // (approx matching by text hash/prefix if we wanted to be super aggressive)

                  const vector = await embeddings.embed(fact.text);

                  // Similarity check (skip if already exists)
                  const existing = await db.search(vector, 1, 0.95);
                  if (existing.length > 0) continue;

                  const summary =
                    fact.summary || (await generateMemorySummary(fact.text, chatModel));

                  await db.store({
                    text: fact.text,
                    vector,
                    importance: fact.importance,
                    category: fact.category,
                    happenedAt: fact.happenedAt ?? null,
                    validUntil: fact.validUntil ?? null,
                    summary,
                    emotionalTone: fact.emotionalTone ?? "neutral",
                    emotionScore: fact.emotionScore ?? 0,
                  });
                  stored++;

                  // Graph extraction for each fact (THROTTLED)
                  // We don't await extractGraph to keep UX snappy, but we catch errors
                  extractGraphFromText(fact.text, chatModel)
                    .then(async (graph) => {
                      if (graph.nodes.length > 0 || graph.edges.length > 0) {
                        try {
                          await graphDB.modify(() => {
                            for (const n of graph.nodes) graphDB.addNode(n);
                            for (const e of graph.edges) graphDB.addEdge(e);
                          });
                        } catch (err) {
                          api.logger.warn(`memory-hybrid: auto-capture graph fail: ${String(err)}`);
                        }
                      }
                    })
                    .catch(() => {});

                  // Robust delay: 1s between facts.
                  // Total 5 facts = 5s background work. Safe for typical 30 RPM limits.
                  await new Promise((resolve) => setTimeout(resolve, 1500));
                } catch (err) {
                  api.logger.warn(
                    `memory-hybrid: smart-capture fact skip: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              }

              if (stored > 0) {
                api.logger.info(`memory-hybrid: smart-captured ${stored} facts`);
              }
              // continue to maintenance...
            }
          }

          if (!cfg.smartCapture || userTexts.length === 0 || lastUserMsg.length >= 15) {
            // ---- Rule-based Capture (fallback, no API calls) ----
            const toCapture = userTexts.filter(
              (text) =>
                text &&
                shouldCapture(text, {
                  maxChars: cfg.captureMaxChars,
                }),
            );

            if (toCapture.length > 0) {
              let storedRuleBased = 0;
              for (const text of toCapture.slice(0, 3)) {
                const category = detectCategory(text);
                const importance = category === "entity" || category === "decision" ? 0.85 : 0.7;

                // Working Memory Buffer filter: only promoted facts get stored
                const promotion = workingMemory.add(text, importance, category);
                if (!promotion.promoted) {
                  continue;
                }

                const vector = await embeddings.embed(text);
                const existing = await db.search(vector, 1, 0.95);
                if (existing.length > 0) continue;

                const summary = await generateMemorySummary(text, chatModel);

                await db.store({
                  text,
                  vector,
                  importance,
                  category,
                  summary,
                });
                storedRuleBased++;
              }

              if (storedRuleBased > 0) {
                api.logger.info(
                  `memory-hybrid: auto-captured ${storedRuleBased} memories (buffer: ${workingMemory.size} entries)`,
                );
              }
            }
          }
        } catch (err) {
          api.logger.warn(`memory-hybrid: capture failed: ${String(err)}`);
        }

        // Synaptic Pruning (Maintenance): run at most once every 24 hours
        if (Date.now() - lastPruneTime > PRUNE_INTERVAL_MS) {
          lastPruneTime = Date.now();
          try {
            // Flush recall count deltas before pruning
            const flushed = await db.flushRecallCounts();
            if (flushed > 0) {
              api.logger.info(`memory-hybrid: flushed ${flushed} recall count deltas`);
            }

            const deleted = await db.deleteOldUnused(90); // 90 days TTL
            if (deleted > 0) {
              api.logger.info(`memory-hybrid: auto-pruned ${deleted} unused memories (>90 days)`);
            }
          } catch (err) {
            api.logger.warn(
              `memory-hybrid: pruning/flush failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      });
    }

    // ======================================================================
    // Service
    // ======================================================================

    api.registerService({
      id: "memory-hybrid",
      start: () => {
        api.logger.info(
          `memory-hybrid: started (model: ${cfg.embedding.model}, chat: ${cfg.chatModel})`,
        );
        dreamService.start();
      },
      stop: () => {
        dreamService.stop();
        api.logger.info("memory-hybrid: stopped");
      },
    });
  },
};

// Re-export for tests
export {
  shouldCapture,
  detectCategory,
  looksLikePromptInjection,
  escapeMemoryForPrompt,
  formatRelevantMemoriesContext,
} from "./capture.js";
export { vectorDimsForModel } from "./embeddings.js";

export default memoryPlugin;
