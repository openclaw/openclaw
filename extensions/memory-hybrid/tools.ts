import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  escapeMemoryForPrompt,
  formatRadarContext,
  generateMemorySummary,
  extractGraphFromText,
} from "./capture.js";
import type { ChatModel } from "./chat.js";
import { MEMORY_CATEGORIES, type MemoryCategory } from "./config.js";
import { MemoryDB } from "./database.js";
import type { Embeddings } from "./embeddings.js";
import type { GraphDB } from "./graph.js";
import { hybridScore, getGraphEnrichment } from "./recall.js";
import { generateReflection } from "./reflection.js";
import { tracer } from "./tracer.js";

export interface ToolDeps {
  db: MemoryDB;
  embeddings: Embeddings;
  chatModel: ChatModel;
  graphDB: GraphDB;
  cfg: any;
}

export function registerTools(api: OpenClawPluginApi, deps: ToolDeps) {
  const { db, embeddings, chatModel, graphDB, cfg } = deps;

  // ======================================================================
  // Tool: memory_recall (Sonar — Stage 1)
  // ======================================================================
  api.registerTool(
    {
      name: "memory_recall",
      label: "Memory Recall (Hybrid Search)",
      description:
        "Search long-term memory for relevant facts, preferences, and past events. Uses hybrid semantic search + knowledge graph to provide high-context results.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        limit: Type.Optional(
          Type.Integer({
            description: "Max results to return (1-10)",
            default: 5,
            minimum: 1,
            maximum: 10,
          }),
        ),
        useGraph: Type.Optional(
          Type.Boolean({ description: "Include multi-hop graph connections", default: true }),
        ),
      }),
      async execute(_toolCallId, params) {
        const {
          query,
          limit = 5,
          useGraph = true,
        } = params as { query: string; limit?: number; useGraph?: boolean };

        const vector = await embeddings.embed(query);
        const searchResults = useGraph
          ? await db.searchWithAMHR(vector, limit, graphDB)
          : await db.search(vector, limit);

        const scored = await hybridScore(searchResults, graphDB);
        const finalResults = scored.slice(0, limit);

        db.incrementRecallCount(finalResults.map((r) => r.entry.id));

        const graphEnrichment = useGraph ? await getGraphEnrichment(finalResults, graphDB) : "";

        const text =
          finalResults.length > 0
            ? finalResults
                .map(
                  (r) =>
                    `[${r.entry.id}] [${r.entry.category}] <untrusted-memory>${escapeMemoryForPrompt(r.entry.text)}</untrusted-memory> (Score: ${r.finalScore.toFixed(2)})`,
                )
                .join("\n") + graphEnrichment
            : "No relevant long-term memories found matching the query.";

        tracer.traceRecall(
          query,
          finalResults.map((r) => ({ id: r.entry.id, text: r.entry.text, score: r.finalScore })),
        );

        return {
          content: [{ type: "text", text: `Recalled ${finalResults.length} memories:\n\n${text}` }],
          details: { count: finalResults.length, ids: finalResults.map((r) => r.entry.id) },
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
        const existing = await db.search(vector, 3, 0.7);

        let actionmsg = "created";
        let replacedId: string | undefined;

        if (existing.length > 0) {
          const topMatch = existing[0];
          if (topMatch.score > 0.98) {
            return {
              content: [{ type: "text", text: `Memory already exists: "${topMatch.entry.text}"` }],
              details: { action: "duplicate", existingId: topMatch.entry.id },
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
              await db.delete(topMatch.entry.id);
              replacedId = topMatch.entry.id;
              actionmsg = "updated";
            }
          } catch (err) {
            api.logger.warn(`memory-hybrid: contradiction check failed: ${String(err)}`);
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

        tracer.traceStore(text, category, entry.id);

        extractGraphFromText(text, chatModel)
          .then(async (graph) => {
            if (graph.nodes.length > 0 || graph.edges.length > 0) {
              await graphDB.modify(() => {
                for (const node of graph.nodes) graphDB.addNode(node);
                for (const edge of graph.edges) graphDB.addEdge(edge);
              });
            }
          })
          .catch((err) =>
            api.logger.warn(`memory-hybrid: graph extraction failed: ${String(err)}`),
          );

        return {
          content: [
            {
              type: "text",
              text:
                actionmsg === "updated"
                  ? `Updated memory: "${text.slice(0, 100)}..." (replaced old info)`
                  : `Stored: "${text.slice(0, 100)}..."`,
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
        const { query, memoryId } = params as { query?: string; memoryId?: string };

        if (memoryId) {
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

          const list = results
            .map(
              (r) =>
                `- [${r.entry.id.slice(0, 8)}] ${escapeMemoryForPrompt(r.entry.text.slice(0, 60))}...`,
            )
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text: `Found ${results.length} candidates. Specify memoryId:\n${list}`,
              },
            ],
            details: { action: "candidates", ids: results.map((r) => r.entry.id) },
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

  // ======================================================================
  // Tool: memory_reflect (Mirror — Stage 2)
  // ======================================================================
  api.registerTool(
    {
      name: "memory_reflect",
      label: "Memory Reflection (Profile)",
      description:
        "Generate a high-level user profile and pattern analysis based on available memories. Use this when you need to understand the user's personality or communication style rather than specific facts.",
      parameters: Type.Object({}),
      async execute() {
        const allMetadata = await db.listMetadata();
        if (allMetadata.length === 0) {
          return {
            content: [{ type: "text", text: "Long-term memory is currently empty." }],
            details: { memoriesAnalyzed: 0 },
          };
        }

        const result = await generateReflection(
          allMetadata.map((m) => ({
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
        "Fetch the FULL text of specific memories by their IDs. Use this when you need the complete original memory text for a thorough response.",
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

        const limitedIds = ids.slice(0, 5);
        const memories = await db.getByIds(limitedIds);
        if (memories.length === 0) {
          return {
            content: [{ type: "text", text: "No memories found." }],
            details: { found: 0 },
          };
        }

        const text = memories
          .map(
            (m) =>
              `[${m.id}] [${m.category}] <untrusted-memory>${escapeMemoryForPrompt(m.text)}</untrusted-memory>`,
          )
          .join("\n\n");

        return {
          content: [
            { type: "text", text: `Full details for ${memories.length} memories:\n\n${text}` },
          ],
          details: { found: memories.length, ids: memories.map((m) => m.id) },
        };
      },
    },
    { name: "memory_fetch_details" },
  );
}
