/**
 * OpenClaw Memory (Redis) Plugin
 *
 * Long-term memory with vector search for AI conversations.
 * Uses Redis Stack (with RediSearch) for storage.
 * Supports multiple embedding providers: openai, gemini, local (node-llama-cpp), auto.
 * Provides seamless auto-recall and auto-capture via lifecycle hooks.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { stringEnum } from "openclaw/plugin-sdk";
import { createClient, type RedisClientType } from "redis";
// Import core embedding provider (available in-process via jiti)
import { createEmbeddingProvider, type EmbeddingProvider } from "../../src/memory/embeddings.js";
import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type RedisMemoryConfig,
  getDefaultVectorDim,
  redisMemoryConfigSchema,
} from "./config.js";

// ============================================================================
// Types
// ============================================================================

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
// Redis Memory Provider
// ============================================================================

class RedisMemoryDB {
  private client: RedisClientType | null = null;
  private initPromise: Promise<void> | null = null;
  private indexCreated = false;

  constructor(
    private readonly redisUrl: string,
    private readonly redisPassword: string | undefined,
    private readonly redisTls: boolean | undefined,
    private vectorDim: number,
    private readonly indexName: string,
    private readonly keyPrefix: string,
    private readonly logger?: { info?: (msg: string) => void; warn: (msg: string) => void },
  ) {}

  setVectorDim(dim: number): void {
    this.vectorDim = dim;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.client?.isOpen) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const clientOptions: Parameters<typeof createClient>[0] = {
      url: this.redisUrl,
    };

    if (this.redisPassword) {
      clientOptions.password = this.redisPassword;
    }

    if (this.redisTls) {
      clientOptions.socket = { tls: true };
    }

    this.client = createClient(clientOptions) as RedisClientType;

    this.client.on("error", (err) => {
      this.logger?.warn(`memory-redis: Redis client error: ${String(err)}`);
    });

    await this.client.connect();
    await this.ensureIndex();
  }

  private async ensureIndex(): Promise<void> {
    if (this.indexCreated) {
      return;
    }

    try {
      // Check if index exists
      await this.client!.ft.info(this.indexName);
      this.indexCreated = true;
      this.logger?.info?.(`memory-redis: using existing index ${this.indexName}`);
    } catch {
      // Index doesn't exist, create it
      try {
        await this.client!.ft.create(
          this.indexName,
          {
            "$.id": { type: "TAG", AS: "id" },
            "$.text": { type: "TEXT", AS: "text" },
            "$.category": { type: "TAG", AS: "category" },
            "$.importance": { type: "NUMERIC", AS: "importance" },
            "$.createdAt": { type: "NUMERIC", AS: "createdAt" },
            "$.vector": {
              type: "VECTOR",
              AS: "vector",
              ALGORITHM: "HNSW",
              TYPE: "FLOAT32",
              DIM: this.vectorDim,
              DISTANCE_METRIC: "COSINE",
            },
          },
          {
            ON: "JSON",
            PREFIX: [this.keyPrefix],
          },
        );
        this.indexCreated = true;
        this.logger?.info?.(
          `memory-redis: created index ${this.indexName} (dim: ${this.vectorDim})`,
        );
      } catch (createErr) {
        this.logger?.warn(`memory-redis: failed to create index: ${String(createErr)}`);
        throw createErr;
      }
    }
  }

  async store(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry> {
    await this.ensureInitialized();

    const fullEntry: MemoryEntry = {
      ...entry,
      id: randomUUID(),
      createdAt: Date.now(),
    };

    const key = `${this.keyPrefix}:${fullEntry.id}`;
    await this.client!.json.set(
      key,
      "$",
      fullEntry as unknown as Parameters<typeof this.client.json.set>[2],
    );

    return fullEntry;
  }

  async search(vector: number[], limit = 5, minScore = 0.5): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    // Convert vector to buffer for Redis
    const vectorBuffer = Buffer.from(new Float32Array(vector).buffer);

    // KNN query with RediSearch
    const query = `*=>[KNN ${limit} @vector $BLOB AS score]`;

    const results = await this.client!.ft.search(this.indexName, query, {
      PARAMS: { BLOB: vectorBuffer },
      SORTBY: { BY: "score", DIRECTION: "ASC" }, // Lower distance = better match
      DIALECT: 2,
      RETURN: ["id", "text", "category", "importance", "createdAt", "score"],
    });

    const mapped: MemorySearchResult[] = [];

    for (const doc of results.documents) {
      const data = doc.value as Record<string, unknown>;
      // Redis returns cosine distance (0 = identical, 2 = opposite)
      // Convert to similarity score (1 = identical, 0 = opposite)
      const scoreVal =
        typeof data.score === "number"
          ? data.score
          : typeof data.score === "string"
            ? parseFloat(data.score)
            : 0;
      const distance = scoreVal;
      const score = 1 - distance / 2;

      if (score >= minScore) {
        const idVal = typeof data.id === "string" ? data.id : "";
        const textVal = typeof data.text === "string" ? data.text : "";
        const importanceVal =
          typeof data.importance === "number"
            ? data.importance
            : typeof data.importance === "string"
              ? parseFloat(data.importance)
              : 0;
        const categoryVal = typeof data.category === "string" ? data.category : "other";
        const createdAtVal =
          typeof data.createdAt === "number"
            ? data.createdAt
            : typeof data.createdAt === "string"
              ? parseInt(data.createdAt, 10)
              : 0;

        mapped.push({
          entry: {
            id: idVal,
            text: textVal,
            vector: [], // Don't return vector in search results
            importance: importanceVal,
            category: categoryVal as MemoryCategory,
            createdAt: createdAtVal,
          },
          score,
        });
      }
    }

    return mapped;
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureInitialized();

    // Validate UUID format to prevent injection
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }

    const key = `${this.keyPrefix}:${id}`;
    const deleted = await this.client!.del(key);
    return deleted > 0;
  }

  async count(): Promise<number> {
    await this.ensureInitialized();

    const info = await this.client!.ft.info(this.indexName);
    return typeof info.numDocs === "number" ? info.numDocs : 0;
  }

  async disconnect(): Promise<void> {
    if (this.client?.isOpen) {
      await this.client.quit();
    }
    this.client = null;
    this.initPromise = null;
  }
}

// ============================================================================
// Embedding Wrapper
// ============================================================================

class Embeddings {
  private provider: EmbeddingProvider | null = null;
  private initPromise: Promise<void> | null = null;
  private providerInfo: string = "initializing";

  constructor(
    private readonly cfg: RedisMemoryConfig,
    private readonly config: OpenClawPluginApi["config"],
    private readonly logger?: { info?: (msg: string) => void; warn: (msg: string) => void },
    private readonly onDimensionKnown?: (dim: number) => void,
  ) {}

  private async ensureInitialized(): Promise<void> {
    if (this.provider) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    // Build remote options if apiKey or baseUrl is provided
    const remote =
      this.cfg.embedding.apiKey || this.cfg.embedding.baseUrl
        ? {
            apiKey: this.cfg.embedding.apiKey,
            baseUrl: this.cfg.embedding.baseUrl,
          }
        : undefined;

    const result = await createEmbeddingProvider({
      config: this.config,
      provider: this.cfg.embedding.provider,
      model: this.cfg.embedding.model ?? "",
      fallback: this.cfg.embedding.fallback ?? "none",
      remote,
    });

    this.provider = result.provider;
    this.providerInfo = `${result.provider.id}/${result.provider.model}`;

    if (result.fallbackFrom) {
      this.logger?.warn?.(
        `memory-redis: fell back from ${result.fallbackFrom} to ${result.provider.id}: ${result.fallbackReason}`,
      );
    }

    this.logger?.info?.(`memory-redis: using embedding provider ${this.providerInfo}`);

    // Detect vector dimension by doing a test embedding
    const testVector = await this.provider.embedQuery("test");
    if (this.onDimensionKnown) {
      this.onDimensionKnown(testVector.length);
    }
  }

  async embed(text: string): Promise<number[]> {
    await this.ensureInitialized();
    return this.provider!.embedQuery(text);
  }

  getProviderInfo(): string {
    return this.providerInfo;
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

function shouldCapture(text: string): boolean {
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

function detectCategory(text: string): MemoryCategory {
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

const memoryRedisPlugin = {
  id: "memory-redis",
  name: "Memory (Redis)",
  description:
    "Redis-backed long-term memory with vector search (supports local/openai/gemini embeddings)",
  kind: "memory" as const,
  configSchema: redisMemoryConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = redisMemoryConfigSchema.parse(api.pluginConfig);

    // Start with default dimension, will be updated when embeddings initialize
    const db = new RedisMemoryDB(
      cfg.redis.url,
      cfg.redis.password,
      cfg.redis.tls,
      getDefaultVectorDim(),
      cfg.indexName!,
      cfg.keyPrefix!,
      api.logger,
    );

    // Create embeddings with callback to update vector dimension
    const embeddings = new Embeddings(cfg, api.config, api.logger, (dim) => {
      db.setVectorDim(dim);
      api.logger.info?.(`memory-redis: detected vector dimension: ${dim}`);
    });

    api.logger.info?.(
      `memory-redis: plugin registered (redis: ${cfg.redis.url}, provider: ${cfg.embedding.provider})`,
    );

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "memory_recall",
        label: "Memory Recall",
        description:
          "Search through long-term memories stored in Redis. Use when you need context about user preferences, past decisions, or previously discussed topics.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
        }),
        async execute(_toolCallId, params) {
          const { query, limit = 5 } = params as { query: string; limit?: number };

          const vector = await embeddings.embed(query);
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
          "Save important information in Redis long-term memory. Use for preferences, facts, decisions.",
        parameters: Type.Object({
          text: Type.String({ description: "Information to remember" }),
          importance: Type.Optional(
            Type.Number({ description: "Importance 0-1 (default: 0.7)", minimum: 0, maximum: 1 }),
          ),
          category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
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

          const vector = await embeddings.embed(text);

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
            content: [{ type: "text", text: `Stored in Redis: "${text.slice(0, 100)}..."` }],
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
        description: "Delete specific memories from Redis. GDPR-compliant.",
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
            const vector = await embeddings.embed(query);
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
        const memory = program.command("redis-memory").description("Redis memory plugin commands");

        memory
          .command("list")
          .description("List memory count")
          .action(async () => {
            const count = await db.count();
            console.log(`Total memories in Redis: ${count}`);
          });

        memory
          .command("search")
          .description("Search memories")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "5")
          .action(async (query, opts) => {
            const vector = await embeddings.embed(query);
            const results = await db.search(vector, parseInt(opts.limit), 0.3);
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
            console.log(`Redis URL: ${cfg.redis.url}`);
            console.log(`Index: ${cfg.indexName}`);
            console.log(`Key prefix: ${cfg.keyPrefix}`);
            console.log(`Embedding provider: ${embeddings.getProviderInfo()}`);
          });

        memory
          .command("delete")
          .description("Delete a memory by ID")
          .argument("<id>", "Memory UUID")
          .action(async (id) => {
            const deleted = await db.delete(id);
            if (deleted) {
              console.log(`Deleted memory: ${id}`);
            } else {
              console.log(`Memory not found: ${id}`);
            }
          });
      },
      { commands: ["redis-memory"] },
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

          api.logger.info?.(`memory-redis: injecting ${results.length} memories into context`);

          return {
            prependContext: `<relevant-memories>\nThe following memories may be relevant to this conversation:\n${memoryContext}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn(`memory-redis: recall failed: ${String(err)}`);
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
          // Extract text content from messages
          const texts: string[] = [];
          for (const msg of event.messages) {
            if (!msg || typeof msg !== "object") {
              continue;
            }
            const msgObj = msg as Record<string, unknown>;

            const role = msgObj.role;
            if (role !== "user" && role !== "assistant") {
              continue;
            }

            const content = msgObj.content;

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

            // Check for duplicates
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
            api.logger.info?.(`memory-redis: auto-captured ${stored} memories`);
          }
        } catch (err) {
          api.logger.warn(`memory-redis: capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-redis",
      start: () => {
        api.logger.info?.(
          `memory-redis: initialized (redis: ${cfg.redis.url}, embedding: ${cfg.embedding.provider})`,
        );
      },
      stop: async () => {
        await db.disconnect();
        api.logger.info?.("memory-redis: disconnected from Redis");
      },
    });
  },
};

export default memoryRedisPlugin;

// Export internals for testing
export { RedisMemoryDB, Embeddings, shouldCapture, detectCategory };
