/**
 * OpenClaw Memory (LanceDB) Plugin
 *
 * Long-term memory with vector search for AI conversations.
 * Uses LanceDB for storage with pluggable embedding providers
 * (OpenAI API or local models via node-llama-cpp).
 * Provides seamless auto-recall and auto-capture via lifecycle hooks.
 */

import type * as LanceDB from "@lancedb/lancedb";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryConfig,
  memoryConfigSchema,
  resolveEffectiveModel,
  vectorDimsForModel,
} from "./config.js";

// ============================================================================
// Errors
// ============================================================================

class DimensionMismatchError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
    public readonly dbPath: string,
  ) {
    super(
      `Vector dimension mismatch: database has ${actual}-dim vectors but current config expects ${expected}-dim. ` +
        `Run \`openclaw ltm reindex\` to re-embed all memories with the current provider.`,
    );
    this.name = "DimensionMismatchError";
  }
}

// ============================================================================
// Types
// ============================================================================

let lancedbImportPromise: Promise<typeof import("@lancedb/lancedb")> | null = null;
const loadLanceDB = async (): Promise<typeof import("@lancedb/lancedb")> => {
  if (!lancedbImportPromise) {
    lancedbImportPromise = import("@lancedb/lancedb");
  }
  try {
    return await lancedbImportPromise;
  } catch (err) {
    // Common on macOS today: upstream package may not ship darwin native bindings.
    throw new Error(`memory-lancedb: failed to load LanceDB. ${String(err)}`, { cause: err });
  }
};

type MemoryEntry = {
  id: string;
  text: string;
  vector: number[];
  importance: number;
  category: MemoryCategory;
  createdAt: number;
};

type MemorySearchResult = {
  entry: MemoryEntry;
  score: number;
};

// ============================================================================
// Embedding Provider Interface
// ============================================================================

interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

// ============================================================================
// LanceDB Provider
// ============================================================================

const TABLE_NAME = "memories";

class MemoryDB {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
  ) {}

  private async ensureInitialized(): Promise<void> {
    if (this.table) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize().catch((err) => {
      // Clear so subsequent calls re-attempt (or re-throw) rather than
      // returning a stale rejected promise.
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const lancedb = await loadLanceDB();
    this.db = await lancedb.connect(this.dbPath);
    const tables = await this.db.tableNames();

    if (tables.includes(TABLE_NAME)) {
      const existing = await this.db.openTable(TABLE_NAME);
      // Validate dimensions BEFORE setting this.table so a mismatch
      // doesn't leave the instance in a half-initialized state.
      await this.validateVectorDimension(existing);
      this.table = existing;
    } else {
      this.table = await this.db.createTable(TABLE_NAME, [
        {
          id: "__schema__",
          text: "",
          vector: Array.from({ length: this.vectorDim }).fill(0),
          importance: 0,
          category: "other",
          createdAt: 0,
        },
      ]);
      await this.table.delete('id = "__schema__"');
    }
  }

  /** Check that the existing table's vector column matches the configured dimension. */
  private async validateVectorDimension(table: LanceDB.Table): Promise<void> {
    const schema = await table.schema();
    // Use loop instead of .find() — Arrow Schema.fields may not be a standard Array
    let storedDim: number | undefined;
    for (const field of schema.fields) {
      if (field.name === "vector") {
        const t = field.type as Record<string, unknown>;
        if (typeof t.listSize === "number") {
          storedDim = t.listSize;
        } else {
          // Fallback: parse from string representation e.g. "FixedSizeList[1536]<Float32>"
          const match = String(field.type).match(/\[(\d+)\]/);
          if (match) {
            storedDim = parseInt(match[1], 10);
          }
        }
        break;
      }
    }
    if (storedDim !== undefined && storedDim !== this.vectorDim) {
      throw new DimensionMismatchError(this.vectorDim, storedDim, this.dbPath);
    }
  }

  /** Initialize without dimension validation (used by reindex to access mismatched tables). */
  async initializeUnchecked(): Promise<void> {
    const lancedb = await loadLanceDB();
    this.db = await lancedb.connect(this.dbPath);
    const tables = await this.db.tableNames();
    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    }
  }

  /** List all entries (for reindexing). Returns entries without vector data. */
  async listAll(): Promise<
    { id: string; text: string; importance: number; category: string; createdAt: number }[]
  > {
    if (!this.table) {
      return [];
    }
    const rows = await this.table
      .query()
      .select(["id", "text", "importance", "category", "createdAt"])
      .toArray();
    return rows.map((row) => ({
      id: row.id as string,
      text: row.text as string,
      importance: row.importance as number,
      category: row.category as string,
      createdAt: row.createdAt as number,
    }));
  }

  /** Drop and recreate the table with new vector dimensions. */
  async recreateTable(): Promise<void> {
    if (!this.db) {
      return;
    }
    const tables = await this.db.tableNames();
    if (tables.includes(TABLE_NAME)) {
      await this.db.dropTable(TABLE_NAME);
    }
    this.table = await this.db.createTable(TABLE_NAME, [
      {
        id: "__schema__",
        text: "",
        vector: Array.from({ length: this.vectorDim }).fill(0),
        importance: 0,
        category: "other",
        createdAt: 0,
      },
    ]);
    await this.table.delete('id = "__schema__"');
  }

  async store(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry> {
    await this.ensureInitialized();

    const fullEntry: MemoryEntry = {
      ...entry,
      id: randomUUID(),
      createdAt: Date.now(),
    };

    await this.table!.add([fullEntry]);
    return fullEntry;
  }

  async search(vector: number[], limit = 5, minScore = 0.5): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    const results = await this.table!.vectorSearch(vector).limit(limit).toArray();

    // LanceDB uses L2 distance by default; convert to similarity score
    const mapped = results.map((row) => {
      const distance = row._distance ?? 0;
      // Use inverse for a 0-1 range: sim = 1 / (1 + d)
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

    return mapped.filter((r) => r.score >= minScore);
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureInitialized();
    // Validate UUID format to prevent injection
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }
    await this.table!.delete(`id = '${id}'`);
    return true;
  }

  async count(): Promise<number> {
    await this.ensureInitialized();
    return this.table!.countRows();
  }
}

// ============================================================================
// OpenAI Embedding Provider
// ============================================================================

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;

  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    return response.data[0].embedding;
  }
}

// ============================================================================
// Local Embedding Provider (node-llama-cpp)
// ============================================================================

class LocalEmbeddingProvider implements EmbeddingProvider {
  private embeddingContext: unknown = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private modelPath: string,
    private modelCacheDir?: string,
  ) {}

  private async ensureInitialized(): Promise<void> {
    if (this.embeddingContext) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    try {
      const nodeLlamaCpp = await import("node-llama-cpp");
      const llama = await nodeLlamaCpp.getLlama({ logLevel: nodeLlamaCpp.LlamaLogLevel.error });
      const resolved = await nodeLlamaCpp.resolveModelFile(this.modelPath, this.modelCacheDir);
      const model = await llama.loadModel({ modelPath: resolved });
      this.embeddingContext = await model.createEmbeddingContext();
    } catch (err) {
      throw new Error(
        `Failed to initialize local embedding model: ${String(err)}. ` +
          `Ensure node-llama-cpp is installed (npm install node-llama-cpp).`,
        { cause: err },
      );
    }
  }

  async embed(text: string): Promise<number[]> {
    await this.ensureInitialized();
    // node-llama-cpp's EmbeddingContext has getEmbeddingFor()
    const ctx = this.embeddingContext as {
      getEmbeddingFor(text: string): Promise<{ vector: Float32Array }>;
    };
    const result = await ctx.getEmbeddingFor(text);
    const vector = Array.from(result.vector);
    return this.normalize(vector);
  }

  private normalize(vec: number[]): number[] {
    const sanitized = vec.map((v) => (Number.isFinite(v) ? v : 0));
    const magnitude = Math.sqrt(sanitized.reduce((sum, v) => sum + v * v, 0));
    if (magnitude < 1e-10) {
      return sanitized;
    }
    return sanitized.map((v) => v / magnitude);
  }
}

// ============================================================================
// Embedding Provider Factory
// ============================================================================

function createEmbeddingProvider(cfg: MemoryConfig): EmbeddingProvider {
  const model = resolveEffectiveModel(cfg);
  if (cfg.embedding.provider === "local") {
    return new LocalEmbeddingProvider(model, cfg.local?.modelCacheDir);
  }
  return new OpenAIEmbeddingProvider(cfg.embedding.apiKey!, model);
}

/** Wrap an embed() call with a provider-aware error message. */
async function embedWithContext(
  provider: EmbeddingProvider,
  text: string,
  cfg: MemoryConfig,
): Promise<number[]> {
  try {
    return await provider.embed(text);
  } catch (err) {
    const model = resolveEffectiveModel(cfg);
    if (cfg.embedding.provider === "local") {
      throw new Error(
        `Local embedding failed (model: ${model}): ${String(err)}. ` +
          `Check that node-llama-cpp is installed and the model path is correct.`,
        { cause: err },
      );
    }
    const message = String(err);
    if (message.includes("401") || message.includes("Unauthorized")) {
      throw new Error(
        `OpenAI embedding failed: invalid API key. Check your embedding.apiKey config.`,
        { cause: err },
      );
    }
    if (message.includes("429") || message.includes("rate")) {
      throw new Error(
        `OpenAI embedding failed: rate limit exceeded. Try again shortly or switch to a local provider.`,
        { cause: err },
      );
    }
    throw new Error(`OpenAI embedding failed (model: ${model}): ${String(err)}`, { cause: err });
  }
}

// ============================================================================
// Rule-based capture filter
// ============================================================================

const MEMORY_TRIGGERS = [
  /zapamatuj si|pamatuj|remember/i,
  /preferuji|radši|nechci|prefer/i,
  /rozhodli jsme|budeme používat/i,
  /\+\d{10,}/,
  /[\w.-]+@[\w.-]+\.\w+/,
  /můj\s+\w+\s+je|je\s+můj/i,
  /my\s+\w+\s+is|is\s+my/i,
  /i (like|prefer|hate|love|want|need)/i,
  /always|never|important/i,
];

export function shouldCapture(text: string): boolean {
  if (text.length < 10 || text.length > 500) {
    return false;
  }
  // Skip injected context from memory recall
  if (text.includes("<relevant-memories>")) {
    return false;
  }
  // Skip system-generated content
  if (text.startsWith("<") && text.includes("</")) {
    return false;
  }
  // Skip agent summary responses (contain markdown formatting)
  if (text.includes("**") && text.includes("\n-")) {
    return false;
  }
  // Skip emoji-heavy responses (likely agent output)
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) {
    return false;
  }
  return MEMORY_TRIGGERS.some((r) => r.test(text));
}

export function detectCategory(text: string): MemoryCategory {
  const lower = text.toLowerCase();
  if (/prefer|radši|like|love|hate|want/i.test(lower)) {
    return "preference";
  }
  if (/rozhodli|decided|will use|budeme/i.test(lower)) {
    return "decision";
  }
  if (/\+\d{10,}|@[\w.-]+\.\w+|is called|jmenuje se/i.test(lower)) {
    return "entity";
  }
  if (/is|are|has|have|je|má|jsou/i.test(lower)) {
    return "fact";
  }
  return "other";
}

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryPlugin = {
  id: "memory-lancedb",
  name: "Memory (LanceDB)",
  description: "LanceDB-backed long-term memory with auto-recall/capture",
  kind: "memory" as const,
  configSchema: memoryConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = memoryConfigSchema.parse(api.pluginConfig);
    const resolvedDbPath = api.resolvePath(cfg.dbPath!);
    const vectorDim = vectorDimsForModel(resolveEffectiveModel(cfg));
    const db = new MemoryDB(resolvedDbPath, vectorDim);
    const embeddings = createEmbeddingProvider(cfg);

    api.logger.info(`memory-lancedb: plugin registered (db: ${resolvedDbPath}, lazy init)`);

    // ========================================================================
    // Tools
    // ========================================================================

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
          const { query, limit = 5 } = params as { query: string; limit?: number };

          const vector = await embedWithContext(embeddings, query, cfg);
          const results = await db.search(vector, limit, 0.1);

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0 },
            };
          }

          const text = results
            .map(
              (r, i) =>
                `${i + 1}. [${r.entry.category}] ${r.entry.text} (${(r.score * 100).toFixed(0)}%)`,
            )
            .join("\n");

          // Strip vector data for serialization (typed arrays can't be cloned)
          const sanitizedResults = results.map((r) => ({
            id: r.entry.id,
            text: r.entry.text,
            category: r.entry.category,
            importance: r.entry.importance,
            score: r.score,
          }));

          return {
            content: [{ type: "text", text: `Found ${results.length} memories:\n\n${text}` }],
            details: { count: results.length, memories: sanitizedResults },
          };
        },
      },
      { name: "memory_recall" },
    );

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
            category?: MemoryEntry["category"];
          };

          const vector = await embedWithContext(embeddings, text, cfg);

          // Check for duplicates
          const existing = await db.search(vector, 1, 0.95);
          if (existing.length > 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Similar memory already exists: "${existing[0].entry.text}"`,
                },
              ],
              details: {
                action: "duplicate",
                existingId: existing[0].entry.id,
                existingText: existing[0].entry.text,
              },
            };
          }

          const entry = await db.store({
            text,
            vector,
            importance,
            category,
          });

          return {
            content: [{ type: "text", text: `Stored: "${text.slice(0, 100)}..."` }],
            details: { action: "created", id: entry.id },
          };
        },
      },
      { name: "memory_store" },
    );

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
          const { query, memoryId } = params as { query?: string; memoryId?: string };

          if (memoryId) {
            await db.delete(memoryId);
            return {
              content: [{ type: "text", text: `Memory ${memoryId} forgotten.` }],
              details: { action: "deleted", id: memoryId },
            };
          }

          if (query) {
            const vector = await embedWithContext(embeddings, query, cfg);
            const results = await db.search(vector, 5, 0.7);

            if (results.length === 0) {
              return {
                content: [{ type: "text", text: "No matching memories found." }],
                details: { found: 0 },
              };
            }

            if (results.length === 1 && results[0].score > 0.9) {
              await db.delete(results[0].entry.id);
              return {
                content: [{ type: "text", text: `Forgotten: "${results[0].entry.text}"` }],
                details: { action: "deleted", id: results[0].entry.id },
              };
            }

            const list = results
              .map((r) => `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}...`)
              .join("\n");

            // Strip vector data for serialization
            const sanitizedCandidates = results.map((r) => ({
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
              details: { action: "candidates", candidates: sanitizedCandidates },
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

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const memory = program.command("ltm").description("LanceDB memory plugin commands");

        memory
          .command("list")
          .description("List memories")
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
            const results = await db.search(vector, parseInt(opts.limit), 0.3);
            // Strip vectors for output
            const output = results.map((r) => ({
              id: r.entry.id,
              text: r.entry.text,
              category: r.entry.category,
              importance: r.entry.importance,
              score: r.score,
            }));
            console.log(JSON.stringify(output, null, 2));
          });

        memory
          .command("stats")
          .description("Show memory statistics")
          .action(async () => {
            const count = await db.count();
            console.log(`Total memories: ${count}`);
          });

        memory
          .command("reindex")
          .description(
            "Re-embed all memories with current provider (use after switching providers)",
          )
          .action(async () => {
            // Re-read config so reindex always uses the current provider/model,
            // even if register() ran with a previous configuration.
            const currentCfg = memoryConfigSchema.parse(api.pluginConfig);
            const currentDim = vectorDimsForModel(resolveEffectiveModel(currentCfg));
            const currentEmbeddings = createEmbeddingProvider(currentCfg);

            // Open the old table without dimension validation
            const oldDb = new MemoryDB(resolvedDbPath, currentDim);
            await oldDb.initializeUnchecked();

            const entries = await oldDb.listAll();
            if (entries.length === 0) {
              console.log("No memories to reindex.");
              return;
            }

            console.log(`Reindexing ${entries.length} memories with current provider...`);

            // Recreate table with new dimensions
            const newDb = new MemoryDB(resolvedDbPath, currentDim);
            await newDb.initializeUnchecked();
            await newDb.recreateTable();

            let success = 0;
            let failed = 0;
            const failedEntries: { id: string; text: string; error: string }[] = [];
            for (const entry of entries) {
              try {
                const vector = await currentEmbeddings.embed(entry.text);
                await newDb.store({
                  text: entry.text,
                  vector,
                  importance: entry.importance,
                  category: entry.category as MemoryCategory,
                });
                success++;
                if (success % 10 === 0) {
                  console.log(`  ${success}/${entries.length} done`);
                }
              } catch (err) {
                failed++;
                failedEntries.push({
                  id: entry.id,
                  text: entry.text.slice(0, 80),
                  error: String(err),
                });
                console.error(
                  `  Failed to re-embed: ${entry.text.slice(0, 60)}... (${String(err)})`,
                );
              }
            }

            console.log(`\nReindex complete: ${success} succeeded, ${failed} failed.`);
            if (failedEntries.length > 0) {
              console.error(`\nFailed memories:`);
              for (const f of failedEntries) {
                console.error(`  [${f.id}] "${f.text}..." — ${f.error}`);
              }
              console.error(
                `\nRe-run \`openclaw ltm reindex\` to retry. Failed memories were not deleted.`,
              );
            }
          });
      },
      { commands: ["ltm"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Auto-recall: inject relevant memories before agent starts
    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event) => {
        if (!event.prompt || event.prompt.length < 5) {
          return;
        }

        try {
          const vector = await embeddings.embed(event.prompt);
          const results = await db.search(vector, 3, 0.3);

          if (results.length === 0) {
            return;
          }

          const memoryContext = results
            .map((r) => `- [${r.entry.category}] ${r.entry.text}`)
            .join("\n");

          api.logger.info?.(`memory-lancedb: injecting ${results.length} memories into context`);

          return {
            prependContext: `<relevant-memories>\nThe following memories may be relevant to this conversation:\n${memoryContext}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn(`memory-lancedb: recall failed: ${String(err)}`);
        }
      });
    }

    // Auto-capture: analyze and store important information after agent ends
    if (cfg.autoCapture) {
      api.on("agent_end", async (event) => {
        if (!event.success || !event.messages || event.messages.length === 0) {
          return;
        }

        try {
          // Extract text content from messages (handling unknown[] type)
          const texts: string[] = [];
          for (const msg of event.messages) {
            // Type guard for message object
            if (!msg || typeof msg !== "object") {
              continue;
            }
            const msgObj = msg as Record<string, unknown>;

            // Only process user and assistant messages
            const role = msgObj.role;
            if (role !== "user" && role !== "assistant") {
              continue;
            }

            const content = msgObj.content;

            // Handle string content directly
            if (typeof content === "string") {
              texts.push(content);
              continue;
            }

            // Handle array content (content blocks)
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

          // Filter for capturable content
          const toCapture = texts.filter((text) => text && shouldCapture(text));
          if (toCapture.length === 0) {
            return;
          }

          // Store each capturable piece (limit to 3 per conversation)
          let stored = 0;
          for (const text of toCapture.slice(0, 3)) {
            const category = detectCategory(text);
            const vector = await embeddings.embed(text);

            // Check for duplicates (high similarity threshold)
            const existing = await db.search(vector, 1, 0.95);
            if (existing.length > 0) {
              continue;
            }

            await db.store({
              text,
              vector,
              importance: 0.7,
              category,
            });
            stored++;
          }

          if (stored > 0) {
            api.logger.info(`memory-lancedb: auto-captured ${stored} memories`);
          }
        } catch (err) {
          api.logger.warn(`memory-lancedb: capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-lancedb",
      start: () => {
        api.logger.info(
          `memory-lancedb: initialized (db: ${resolvedDbPath}, model: ${cfg.embedding.model})`,
        );
      },
      stop: () => {
        api.logger.info("memory-lancedb: stopped");
      },
    });
  },
};

export default memoryPlugin;
export { DimensionMismatchError, MemoryDB };
