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

import type * as LanceDB from "@lancedb/lancedb";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { WorkingMemoryBuffer } from "./buffer.js";
import {
  shouldCapture,
  detectCategory,
  smartCapture,
  formatRelevantMemoriesContext,
} from "./capture.js";
import { ChatModel } from "./chat.js";
import { MEMORY_CATEGORIES, type MemoryCategory, memoryConfigSchema } from "./config.js";
import { clusterBySimilarity, mergeFacts } from "./consolidate.js";
import { Embeddings, vectorDimsForModel } from "./embeddings.js";
import { GraphDB, extractGraphFromText } from "./graph.js";
import { hybridScore, getGraphEnrichment, type MemoryEntry } from "./recall.js";
import { generateReflection } from "./reflection.js";

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

class MemoryDB {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;

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

  private async doInitialize(): Promise<void> {
    const lancedb = await loadLanceDB();
    this.db = await lancedb.connect(this.dbPath);
    const tables = await this.db.tableNames();

    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
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
          emotionalTone: "neutral",
          emotionScore: 0,
        },
      ]);
      await this.table.delete('id = "__schema__"');
    }
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

    await this.table!.add([fullEntry as unknown as Record<string, unknown>]);
    return fullEntry;
  }

  async search(vector: number[], limit = 5, minScore = 0.5): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    const results = await this.table!.vectorSearch(vector).limit(limit).toArray();

    // LanceDB uses L2 distance; convert to similarity: sim = 1 / (1 + d)
    const mapped = results.map((row) => {
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
        },
        score,
      };
    });

    return mapped.filter((r) => r.score >= minScore);
  }

  async getById(id: string): Promise<MemoryEntry | null> {
    await this.ensureInitialized();
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
    };
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureInitialized();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }
    await this.table!.delete(`id = '${id}'`);
    // Clean up delta for deleted memory
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
    const idsToFlush = Array.from(this.recallCountDeltas.entries());

    for (const [id, delta] of idsToFlush) {
      if (delta <= 0) {
        this.recallCountDeltas.delete(id);
        continue;
      }
      try {
        const rows = await this.table!.query().where(`id = '${id}'`).toArray();
        if (rows.length === 0) {
          this.recallCountDeltas.delete(id);
          continue;
        }
        const row = rows[0];

        await this.table!.delete(`id = '${id}'`);
        await this.table!.add([
          {
            ...row,
            recallCount: ((row.recallCount as number) ?? 0) + delta,
          },
        ]);

        this.recallCountDeltas.delete(id);
        flushed++;
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
    const vectorDim = vectorDimsForModel(cfg.embedding.model);
    const db = new MemoryDB(resolvedDbPath, vectorDim);
    const embeddings = new Embeddings(
      cfg.embedding.apiKey,
      cfg.embedding.model,
      cfg.embedding.provider,
    );
    const chatModel = new ChatModel(cfg.embedding.apiKey, cfg.chatModel, cfg.embedding.provider);
    const graphDB = new GraphDB(resolvedDbPath);
    const workingMemory = new WorkingMemoryBuffer(50, 0.7, 3);

    // Load graph on startup (async, non-blocking)
    graphDB.load().catch((err) => {
      api.logger.warn(`memory-hybrid: graph load failed: ${String(err)}`);
    });

    api.logger.info(
      `memory-hybrid: registered (db: ${resolvedDbPath}, model: ${cfg.embedding.model}, provider: ${cfg.embedding.provider})`,
    );

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

          const vector = await embeddings.embed(text);

          // 1. Check for duplicates/contradictions with high similarity
          const existing = await db.search(vector, 3, 0.85);

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

          const entry = await db.store({
            text,
            vector,
            importance,
            category,
          });

          // Knowledge Graph extraction (async, non-blocking)
          extractGraphFromText(text, chatModel)
            .then(async (graph) => {
              if (graph.nodes.length > 0 || graph.edges.length > 0) {
                for (const node of graph.nodes) graphDB.addNode(node);
                for (const edge of graph.edges) graphDB.addEdge(edge);
                await graphDB.save();
                api.logger.info(
                  `memory-hybrid: graph updated (+${graph.nodes.length} nodes, +${graph.edges.length} edges)`,
                );
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
                    ? `Updated memory: "${text.slice(0, 100)}..." (replaced old info)`
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
          const allMemories = await db.listAll();

          const result = await generateReflection(
            allMemories.map((m) => ({
              text: m.text,
              category: m.category,
              importance: m.importance,
              recallCount: m.recallCount,
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
            const allMemories = await db.listAll();
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

              // Delete old memories
              for (const item of cluster) {
                await db.delete(item.id);
              }

              // Store merged memory with boosted importance
              const vector = await embeddings.embed(merged);
              await db.store({
                text: merged,
                vector,
                importance: 0.85, // consolidated memories are important
                category: "fact",
              });

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
            const allMemories = await db.listAll();
            console.log(`\n🪞 Reflecting on ${allMemories.length} memories...\n`);

            const result = await generateReflection(
              allMemories.map((m) => ({
                text: m.text,
                category: m.category,
                importance: m.importance,
                recallCount: m.recallCount,
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
      api.on("before_agent_start", async (event) => {
        if (!event.prompt || event.prompt.length < 5) return;

        try {
          // Single embed call for both recall injection AND reinforcement
          const vector = await embeddings.embed(event.prompt);
          const rawResults = await db.search(vector, 3, 0.3);

          if (rawResults.length === 0) return;

          // Apply hybrid scoring for better ranking
          const scored = hybridScore(rawResults, graphDB);

          api.logger.info(`memory-hybrid: injecting ${scored.length} memories`);

          let context = formatRelevantMemoriesContext(
            scored.map((r) => ({
              category: r.entry.category as MemoryCategory,
              text: r.entry.text,
            })),
          );

          // Add graph enrichment to context
          const graphInfo = getGraphEnrichment(scored, graphDB);
          if (graphInfo) {
            context = context.replace("</relevant-memories>", graphInfo + "\n</relevant-memories>");
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

          // ---- Smart Capture (LLM-powered) ----
          // Note: Smart Capture intentionally bypasses Working Memory Buffer.
          // The LLM already decided what's worth storing — buffering would be redundant.
          if (cfg.smartCapture && userTexts.length > 0) {
            const lastUserMsg = userTexts[userTexts.length - 1];
            const lastAssistantMsg =
              assistantTexts.length > 0 ? assistantTexts[assistantTexts.length - 1] : undefined;

            const result = await smartCapture(lastUserMsg, lastAssistantMsg, chatModel);

            if (result.shouldStore) {
              let stored = 0;
              for (const fact of result.facts.slice(0, 5)) {
                try {
                  const vector = await embeddings.embed(fact.text);

                  // Duplicate check
                  const existing = await db.search(vector, 1, 0.95);
                  if (existing.length > 0) continue;

                  await db.store({
                    text: fact.text,
                    vector,
                    importance: fact.importance,
                    category: fact.category,
                    happenedAt: fact.happenedAt ?? null,
                    validUntil: fact.validUntil ?? null,
                    emotionalTone: fact.emotionalTone ?? "neutral",
                    emotionScore: fact.emotionScore ?? 0,
                  });
                  stored++;

                  // Graph extraction for each fact (non-blocking)
                  extractGraphFromText(fact.text, chatModel)
                    .then(async (graph) => {
                      if (graph.nodes.length > 0 || graph.edges.length > 0) {
                        for (const n of graph.nodes) graphDB.addNode(n);
                        for (const e of graph.edges) graphDB.addEdge(e);
                        await graphDB.save();
                      }
                    })
                    .catch(() => {
                      /* best-effort */
                    });

                  // Delay slightly to stay under 30 RPM (2s per request)
                  // Each fact uses 1 embed + 1 graph extraction call
                  await new Promise((resolve) => setTimeout(resolve, 1000));
                } catch (err) {
                  api.logger.warn(`memory-hybrid: smart-capture fail for fact: ${err}`);
                }
              }

              if (stored > 0) {
                api.logger.info(`memory-hybrid: smart-captured ${stored} facts`);
              }
              return; // Smart capture handled it, skip rule-based
            }
          }

          // ---- Rule-based Capture (fallback, no API calls) ----
          const toCapture = userTexts.filter(
            (text) =>
              text &&
              shouldCapture(text, {
                maxChars: cfg.captureMaxChars,
              }),
          );
          if (toCapture.length === 0) return;

          let stored = 0;
          for (const text of toCapture.slice(0, 3)) {
            const category = detectCategory(text);
            const importance = category === "entity" || category === "decision" ? 0.85 : 0.7;

            // Working Memory Buffer filter: only promoted facts get stored
            const promotion = workingMemory.add(text, importance, category);
            if (!promotion.promoted) {
              api.logger.info(
                `memory-hybrid: buffered "${text.slice(0, 40)}..." (${promotion.reason})`,
              );
              continue;
            }

            const vector = await embeddings.embed(text);

            const existing = await db.search(vector, 1, 0.95);
            if (existing.length > 0) continue;

            await db.store({
              text,
              vector,
              importance,
              category,
            });
            stored++;
          }

          if (stored > 0) {
            api.logger.info(
              `memory-hybrid: auto-captured ${stored} memories (buffer: ${workingMemory.size} entries, ${workingMemory.promotedCount} promoted)`,
            );
          }
        } catch (err) {
          api.logger.warn(`memory-hybrid: capture failed: ${String(err)}`);
        }

        // Synaptic Pruning (Maintenance): 5% chance to clean up old memories
        // Like biological sleep cycles removing toxins
        if (Math.random() < 0.05) {
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
            // maintain silence on background tasks
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
      },
      stop: () => {
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
