/**
 * OpenClaw Memory (Neo4j) Plugin
 *
 * Drop-in replacement for memory-lancedb with three-signal hybrid search,
 * entity extraction, and knowledge graph capabilities.
 *
 * Provides:
 * - memory_recall: Hybrid search (vector + BM25 + graph traversal)
 * - memory_store: Store memories with background entity extraction
 * - memory_forget: Delete memories with cascade cleanup
 *
 * Architecture decisions: see docs/memory-neo4j/ARCHITECTURE.md
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { stringEnum } from "openclaw/plugin-sdk";
import type { MemoryCategory, MemorySource } from "./schema.js";
import {
  MEMORY_CATEGORIES,
  memoryNeo4jConfigSchema,
  resolveExtractionConfig,
  vectorDimsForModel,
} from "./config.js";
import { Embeddings } from "./embeddings.js";
import { evaluateAutoCapture, extractUserMessages, runBackgroundExtraction } from "./extractor.js";
import { Neo4jMemoryClient } from "./neo4j-client.js";
import { hybridSearch } from "./search.js";

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryNeo4jPlugin = {
  id: "memory-neo4j",
  name: "Memory (Neo4j)",
  description:
    "Neo4j-backed long-term memory with three-signal hybrid search, entity extraction, and knowledge graph",
  kind: "memory" as const,
  configSchema: memoryNeo4jConfigSchema,

  register(api: OpenClawPluginApi) {
    // Parse configuration
    const cfg = memoryNeo4jConfigSchema.parse(api.pluginConfig);
    const extractionConfig = resolveExtractionConfig();
    const vectorDim = vectorDimsForModel(cfg.embedding.model);

    // Create shared resources
    const db = new Neo4jMemoryClient(
      cfg.neo4j.uri,
      cfg.neo4j.username,
      cfg.neo4j.password,
      vectorDim,
      api.logger,
    );
    const embeddings = new Embeddings(cfg.embedding.apiKey, cfg.embedding.model);

    api.logger.info(
      `memory-neo4j: registered (uri: ${cfg.neo4j.uri}, model: ${cfg.embedding.model}, ` +
        `extraction: ${extractionConfig.enabled ? extractionConfig.model : "disabled"})`,
    );

    // ========================================================================
    // Tools (using factory pattern for agentId)
    // ========================================================================

    // memory_recall — Three-signal hybrid search
    api.registerTool(
      (ctx) => {
        const agentId = ctx.agentId || "default";
        return {
          name: "memory_recall",
          label: "Memory Recall",
          description:
            "Search through long-term memories. Use when you need context about user preferences, past decisions, or previously discussed topics.",
          parameters: Type.Object({
            query: Type.String({ description: "Search query" }),
            limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
          }),
          async execute(_toolCallId: string, params: unknown) {
            const { query, limit = 5 } = params as {
              query: string;
              limit?: number;
            };

            const results = await hybridSearch(
              db,
              embeddings,
              query,
              limit,
              agentId,
              extractionConfig.enabled,
            );

            if (results.length === 0) {
              return {
                content: [{ type: "text", text: "No relevant memories found." }],
                details: { count: 0 },
              };
            }

            const text = results
              .map((r, i) => `${i + 1}. [${r.category}] ${r.text} (${(r.score * 100).toFixed(0)}%)`)
              .join("\n");

            const sanitizedResults = results.map((r) => ({
              id: r.id,
              text: r.text,
              category: r.category,
              importance: r.importance,
              score: r.score,
            }));

            return {
              content: [
                {
                  type: "text",
                  text: `Found ${results.length} memories:\n\n${text}`,
                },
              ],
              details: { count: results.length, memories: sanitizedResults },
            };
          },
        };
      },
      { name: "memory_recall" },
    );

    // memory_store — Store with background entity extraction
    api.registerTool(
      (ctx) => {
        const agentId = ctx.agentId || "default";
        const sessionKey = ctx.sessionKey;
        return {
          name: "memory_store",
          label: "Memory Store",
          description:
            "Save important information in long-term memory. Use for preferences, facts, decisions.",
          parameters: Type.Object({
            text: Type.String({ description: "Information to remember" }),
            importance: Type.Optional(
              Type.Number({
                description: "Importance 0-1 (default: 0.7)",
              }),
            ),
            category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
          }),
          async execute(_toolCallId: string, params: unknown) {
            const {
              text,
              importance = 0.7,
              category = "other",
            } = params as {
              text: string;
              importance?: number;
              category?: MemoryCategory;
            };

            // 1. Generate embedding
            const vector = await embeddings.embed(text);

            // 2. Check for duplicates (vector similarity > 0.95)
            const existing = await db.findSimilar(vector, 0.95, 1);
            if (existing.length > 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Similar memory already exists: "${existing[0].text}"`,
                  },
                ],
                details: {
                  action: "duplicate",
                  existingId: existing[0].id,
                  existingText: existing[0].text,
                },
              };
            }

            // 3. Store memory immediately (fast path)
            const memoryId = randomUUID();
            await db.storeMemory({
              id: memoryId,
              text,
              embedding: vector,
              importance: Math.min(1, Math.max(0, importance)),
              category,
              source: "user" as MemorySource,
              extractionStatus: extractionConfig.enabled ? "pending" : "skipped",
              agentId,
              sessionKey,
            });

            // 4. Fire-and-forget background entity extraction
            if (extractionConfig.enabled) {
              runBackgroundExtraction(
                memoryId,
                text,
                db,
                embeddings,
                extractionConfig,
                api.logger,
              ).catch((err) => {
                api.logger.warn(`memory-neo4j: background extraction error: ${String(err)}`);
              });
            }

            return {
              content: [
                {
                  type: "text",
                  text: `Stored: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`,
                },
              ],
              details: { action: "created", id: memoryId },
            };
          },
        };
      },
      { name: "memory_store" },
    );

    // memory_forget — Delete with cascade
    api.registerTool(
      (_ctx) => {
        return {
          name: "memory_forget",
          label: "Memory Forget",
          description: "Delete specific memories. GDPR-compliant.",
          parameters: Type.Object({
            query: Type.Optional(Type.String({ description: "Search to find memory" })),
            memoryId: Type.Optional(Type.String({ description: "Specific memory ID" })),
          }),
          async execute(_toolCallId: string, params: unknown) {
            const { query, memoryId } = params as {
              query?: string;
              memoryId?: string;
            };

            // Direct delete by ID
            if (memoryId) {
              const deleted = await db.deleteMemory(memoryId);
              if (!deleted) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Memory ${memoryId} not found.`,
                    },
                  ],
                  details: { action: "not_found", id: memoryId },
                };
              }
              return {
                content: [
                  {
                    type: "text",
                    text: `Memory ${memoryId} forgotten.`,
                  },
                ],
                details: { action: "deleted", id: memoryId },
              };
            }

            // Search-based delete
            if (query) {
              const vector = await embeddings.embed(query);
              const results = await db.vectorSearch(vector, 5, 0.7);

              if (results.length === 0) {
                return {
                  content: [{ type: "text", text: "No matching memories found." }],
                  details: { found: 0 },
                };
              }

              // Auto-delete if single high-confidence match
              if (results.length === 1 && results[0].score > 0.9) {
                await db.deleteMemory(results[0].id);
                return {
                  content: [
                    {
                      type: "text",
                      text: `Forgotten: "${results[0].text}"`,
                    },
                  ],
                  details: { action: "deleted", id: results[0].id },
                };
              }

              // Multiple candidates — ask user to specify
              const list = results
                .map((r) => `- [${r.id.slice(0, 8)}] ${r.text.slice(0, 60)}...`)
                .join("\n");

              const sanitizedCandidates = results.map((r) => ({
                id: r.id,
                text: r.text,
                category: r.category,
                score: r.score,
              }));

              return {
                content: [
                  {
                    type: "text",
                    text: `Found ${results.length} candidates. Specify memoryId:\n${list}`,
                  },
                ],
                details: {
                  action: "candidates",
                  candidates: sanitizedCandidates,
                },
              };
            }

            return {
              content: [{ type: "text", text: "Provide query or memoryId." }],
              details: { error: "missing_param" },
            };
          },
        };
      },
      { name: "memory_forget" },
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const memory = program.command("neo4j-memory").description("Neo4j memory plugin commands");

        memory
          .command("list")
          .description("List memories (count)")
          .action(async () => {
            await db.ensureInitialized();
            const count = await db.countMemories();
            console.log(`Total memories: ${count}`);
          });

        memory
          .command("search")
          .description("Search memories")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "5")
          .action(async (query: string, opts: { limit: string }) => {
            const results = await hybridSearch(
              db,
              embeddings,
              query,
              parseInt(opts.limit, 10),
              "default",
              extractionConfig.enabled,
            );
            const output = results.map((r) => ({
              id: r.id,
              text: r.text,
              category: r.category,
              importance: r.importance,
              score: r.score,
            }));
            console.log(JSON.stringify(output, null, 2));
          });

        memory
          .command("stats")
          .description("Show memory statistics")
          .action(async () => {
            await db.ensureInitialized();
            const count = await db.countMemories();
            console.log(`Total memories: ${count}`);
            console.log(`Neo4j URI: ${cfg.neo4j.uri}`);
            console.log(`Embedding model: ${cfg.embedding.model}`);
            console.log(
              `Extraction: ${extractionConfig.enabled ? extractionConfig.model : "disabled"}`,
            );
          });

        memory
          .command("maintain")
          .description("Run maintenance tasks (orphan cleanup, etc.)")
          .action(async () => {
            console.log("Maintenance not yet implemented (deferred to v2).");
          });
      },
      { commands: ["neo4j-memory"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Auto-recall: inject relevant memories before agent starts
    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event, ctx) => {
        if (!event.prompt || event.prompt.length < 5) {
          return;
        }

        const agentId = ctx.agentId || "default";

        try {
          const results = await hybridSearch(
            db,
            embeddings,
            event.prompt,
            3,
            agentId,
            extractionConfig.enabled,
          );

          if (results.length === 0) {
            return;
          }

          const memoryContext = results.map((r) => `- [${r.category}] ${r.text}`).join("\n");

          api.logger.info?.(`memory-neo4j: injecting ${results.length} memories into context`);

          return {
            prependContext: `<relevant-memories>\nThe following memories may be relevant to this conversation:\n${memoryContext}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn(`memory-neo4j: auto-recall failed: ${String(err)}`);
        }
      });
    }

    // Auto-capture: LLM-based decision on what to store from conversations
    if (cfg.autoCapture) {
      api.on("agent_end", async (event, ctx) => {
        if (!event.success || !event.messages || event.messages.length === 0) {
          return;
        }

        const agentId = ctx.agentId || "default";
        const sessionKey = ctx.sessionKey;

        try {
          if (extractionConfig.enabled) {
            // LLM-based auto-capture (Decision Q8)
            const userMessages = extractUserMessages(event.messages);
            if (userMessages.length === 0) {
              return;
            }

            const items = await evaluateAutoCapture(userMessages, extractionConfig);
            if (items.length === 0) {
              return;
            }

            let stored = 0;
            for (const item of items) {
              try {
                const vector = await embeddings.embed(item.text);

                // Check for duplicates
                const existing = await db.findSimilar(vector, 0.95, 1);
                if (existing.length > 0) {
                  continue;
                }

                const memoryId = randomUUID();
                await db.storeMemory({
                  id: memoryId,
                  text: item.text,
                  embedding: vector,
                  importance: item.importance,
                  category: item.category,
                  source: "auto-capture",
                  extractionStatus: "pending",
                  agentId,
                  sessionKey,
                });

                // Background entity extraction
                runBackgroundExtraction(
                  memoryId,
                  item.text,
                  db,
                  embeddings,
                  extractionConfig,
                  api.logger,
                ).catch(() => {});

                stored++;
              } catch (err) {
                api.logger.debug?.(`memory-neo4j: auto-capture item failed: ${String(err)}`);
              }
            }

            if (stored > 0) {
              api.logger.info(`memory-neo4j: auto-captured ${stored} memories (LLM-based)`);
            }
          } else {
            // Fallback: rule-based capture (no extraction API key)
            const userMessages = extractUserMessages(event.messages);
            if (userMessages.length === 0) {
              return;
            }

            const toCapture = userMessages.filter(
              (text) => text.length >= 10 && text.length <= 500 && shouldCaptureRuleBased(text),
            );
            if (toCapture.length === 0) {
              return;
            }

            let stored = 0;
            for (const text of toCapture.slice(0, 3)) {
              const category = detectCategory(text);
              const vector = await embeddings.embed(text);

              const existing = await db.findSimilar(vector, 0.95, 1);
              if (existing.length > 0) {
                continue;
              }

              await db.storeMemory({
                id: randomUUID(),
                text,
                embedding: vector,
                importance: 0.7,
                category,
                source: "auto-capture",
                extractionStatus: "skipped",
                agentId,
                sessionKey,
              });
              stored++;
            }

            if (stored > 0) {
              api.logger.info(`memory-neo4j: auto-captured ${stored} memories (rule-based)`);
            }
          }
        } catch (err) {
          api.logger.warn(`memory-neo4j: auto-capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-neo4j",
      start: async () => {
        try {
          await db.ensureInitialized();
          api.logger.info(
            `memory-neo4j: service started (uri: ${cfg.neo4j.uri}, model: ${cfg.embedding.model})`,
          );
        } catch (err) {
          api.logger.error(
            `memory-neo4j: failed to start — ${String(err)}. Memory tools will attempt lazy initialization.`,
          );
          // Don't throw — allow graceful degradation.
          // Tools will retry initialization on first use.
        }
      },
      stop: async () => {
        await db.close();
        api.logger.info("memory-neo4j: service stopped");
      },
    });
  },
};

// ============================================================================
// Rule-based capture filter (fallback when no extraction API key)
// ============================================================================

const MEMORY_TRIGGERS = [
  /remember|zapamatuj|pamatuj/i,
  /prefer|radši|nechci|preferuji/i,
  /decided|rozhodli|budeme používat/i,
  /\+\d{10,}/,
  /[\w.-]+@[\w.-]+\.\w+/,
  /my\s+\w+\s+is|is\s+my/i,
  /i (like|prefer|hate|love|want|need)/i,
  /always|never|important/i,
];

function shouldCaptureRuleBased(text: string): boolean {
  if (text.includes("<relevant-memories>")) {
    return false;
  }
  if (text.startsWith("<") && text.includes("</")) {
    return false;
  }
  if (text.includes("**") && text.includes("\n-")) {
    return false;
  }
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
  if (/decided|rozhodli|will use|budeme/i.test(lower)) {
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
// Export
// ============================================================================

export default memoryNeo4jPlugin;
