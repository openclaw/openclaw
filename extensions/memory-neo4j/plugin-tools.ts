/**
 * Memory tool registrations for the memory-neo4j plugin.
 *
 * Registers: memory_recall, memory_store, memory_forget
 */

import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";
import type { ExtractionConfig, MemoryNeo4jConfig } from "./config.js";
import { MEMORY_CATEGORIES } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { Logger, MemoryCategory, MemorySource } from "./schema.js";
import { hybridSearch } from "./search.js";

export function registerMemoryTools(
  api: OpenClawPluginApi,
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  cfg: MemoryNeo4jConfig,
  extractionConfig: ExtractionConfig,
  logger: Logger,
): void {
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
          includeExpired: Type.Optional(
            Type.Boolean({ description: "Include superseded/expired memories (default: false)" }),
          ),
        }),
        async execute(_toolCallId: string, params: unknown) {
          const {
            query,
            limit: rawLimit = 5,
            includeExpired = false,
          } = params as {
            query: string;
            limit?: number;
            includeExpired?: boolean;
          };
          const limit = Math.floor(Math.min(50, Math.max(1, rawLimit)));

          const results = await hybridSearch(
            db,
            embeddings,
            query,
            limit,
            agentId,
            extractionConfig.enabled,
            { graphSearchDepth: cfg.graphSearchDepth, logger, includeExpired },
          );

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0 },
            };
          }

          const text = results
            .map((r, i) => {
              const base = `${i + 1}. [${r.category}] ${r.text} (${(r.score * 100).toFixed(0)}%)`;
              if (!r.signals) return base;
              const parts: string[] = [];
              if (r.signals.vector.rank > 0) parts.push(`vec:#${r.signals.vector.rank}`);
              if (r.signals.bm25.rank > 0) parts.push(`bm25:#${r.signals.bm25.rank}`);
              if (r.signals.graph.rank > 0) parts.push(`graph:#${r.signals.graph.rank}`);
              return parts.length > 0 ? `${base} [${parts.join(" ")}]` : base;
            })
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
          taskId: Type.Optional(
            Type.String({ description: "Optional task ID to link memory to (e.g., TASK-001)" }),
          ),
        }),
        async execute(_toolCallId: string, params: unknown) {
          const {
            text,
            importance = 0.7,
            category = "other",
            taskId,
          } = params as {
            text: string;
            importance?: number;
            category?: MemoryCategory;
            taskId?: string;
          };

          // 1. Generate embedding
          const vector = await embeddings.embed(text);

          // 2. Check for duplicates (vector similarity > 0.95)
          const existing = await db.findSimilar(vector, 0.95, 1, agentId);
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
          // Core memories get importance locked at 1.0 and are immune from
          // decay and pruning (filtered by category in the sleep cycle).
          const memoryId = randomUUID();
          await db.storeMemory({
            id: memoryId,
            text,
            embedding: vector,
            importance: category === "core" ? 1.0 : Math.min(1, Math.max(0, importance)),
            category,
            source: "user" as MemorySource,
            extractionStatus: extractionConfig.enabled ? "pending" : "skipped",
            agentId,
            sessionKey,
            // Layer 3: Pass through taskId if provided by the agent
            ...(taskId ? { taskId } : {}),
          });

          // 4. Conflict detection: check if this memory supersedes existing ones
          let supersededCount = 0;
          if (cfg.conflictDetection.enabled) {
            try {
              supersededCount = await db.detectConflicts(
                memoryId,
                text,
                vector,
                agentId,
                extractionConfig,
                {
                  similarityThreshold: cfg.conflictDetection.similarityThreshold,
                  maxCandidates: cfg.conflictDetection.maxCandidates,
                },
              );
            } catch (err) {
              // Non-fatal — log but don't fail the store
              logger.warn(`memory-neo4j: conflict detection failed: ${String(err)}`);
            }
          }

          // 5. Extraction is deferred to sleep cycle (like human memory consolidation)
          // See: runSleepCycleExtraction() and `openclaw memory sleep` command

          return {
            content: [
              {
                type: "text",
                text: `Stored: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"${supersededCount > 0 ? ` (superseded ${supersededCount} older ${supersededCount === 1 ? "memory" : "memories"})` : ""}`,
              },
            ],
            details: { action: "created", id: memoryId, supersededCount },
          };
        },
      };
    },
    { name: "memory_store" },
  );

  // memory_forget — Delete with cascade
  api.registerTool(
    (ctx) => {
      const agentId = ctx.agentId || "default";
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
            const deleted = await db.deleteMemory(memoryId, agentId);
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
            const results = await db.vectorSearch(vector, 5, 0.7, agentId);

            if (results.length === 0) {
              return {
                content: [{ type: "text", text: "No matching memories found." }],
                details: { found: 0 },
              };
            }

            // Auto-delete if single high-confidence match (0.95 threshold
            // reduces false positives — 0.9 cosine similarity is not exact match)
            if (results.length === 1 && results[0].score > 0.95) {
              await db.deleteMemory(results[0].id, agentId);
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
            const list = results.map((r) => `- [${r.id}] ${r.text.slice(0, 60)}...`).join("\n");

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
}
