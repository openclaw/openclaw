/**
 * Moltbot Memory (PowerMem) Plugin
 *
 * Long-term memory via PowerMem HTTP API: intelligent extraction,
 * Ebbinghaus forgetting curve, multi-agent isolation. Requires a running
 * PowerMem server (e.g. powermem-server --port 8000).
 */

import { Type } from "@sinclair/typebox";
import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";

import {
  powerMemConfigSchema,
  resolveUserId,
  resolveAgentId,
  type PowerMemConfig,
} from "./config.js";
import { PowerMemClient } from "./client.js";

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryPlugin = {
  id: "memory-powermem",
  name: "Memory (PowerMem)",
  description:
    "PowerMem-backed long-term memory (intelligent extraction, forgetting curve). Requires PowerMem server.",
  kind: "memory" as const,
  configSchema: powerMemConfigSchema,

  register(api: MoltbotPluginApi) {
    const cfg = powerMemConfigSchema.parse(api.pluginConfig) as PowerMemConfig;
    const userId = resolveUserId(cfg);
    const agentId = resolveAgentId(cfg);
    const client = PowerMemClient.fromConfig(cfg, userId, agentId);

    api.logger.info?.(
      `memory-powermem: plugin registered (baseUrl: ${cfg.baseUrl}, user: ${userId}, agent: ${agentId})`,
    );

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

          try {
            const results = await client.search(query, limit);

            if (results.length === 0) {
              return {
                content: [{ type: "text", text: "No relevant memories found." }],
                details: { count: 0 },
              };
            }

            const text = results
              .map(
                (r, i) =>
                  `${i + 1}. ${r.content} (${((r.score ?? 0) * 100).toFixed(0)}%)`,
              )
              .join("\n");

            const sanitizedResults = results.map((r) => ({
              id: String(r.memory_id),
              text: r.content,
              score: r.score,
            }));

            return {
              content: [
                { type: "text", text: `Found ${results.length} memories:\n\n${text}` },
              ],
              details: { count: results.length, memories: sanitizedResults },
            };
          } catch (err) {
            api.logger.warn?.(`memory-powermem: recall failed: ${String(err)}`);
            return {
              content: [
                {
                  type: "text",
                  text: `Memory search failed: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              details: { error: String(err) },
            };
          }
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
          importance: Type.Optional(
            Type.Number({ description: "Importance 0-1 (default: 0.7)" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { text, importance = 0.7 } = params as {
            text: string;
            importance?: number;
          };

          try {
            const created = await client.add(text, {
              infer: cfg.inferOnAdd,
              metadata: { importance },
            });

            if (created.length === 0) {
              return {
                content: [{ type: "text", text: "Stored (no inferred items)." }],
                details: { action: "created" },
              };
            }

            const summary =
              created.length === 1
                ? created[0].content.slice(0, 80)
                : `${created.length} items stored`;
            return {
              content: [
                { type: "text", text: `Stored: ${summary}${summary.length >= 80 ? "..." : ""}` },
              ],
              details: {
                action: "created",
                count: created.length,
                ids: created.map((c) => String(c.memory_id)),
              },
            };
          } catch (err) {
            api.logger.warn?.(`memory-powermem: store failed: ${String(err)}`);
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to store memory: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              details: { error: String(err) },
            };
          }
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

          try {
            if (memoryId) {
              await client.delete(memoryId);
              return {
                content: [{ type: "text", text: `Memory ${memoryId} forgotten.` }],
                details: { action: "deleted", id: memoryId },
              };
            }

            if (query) {
              const results = await client.search(query, 5);
              if (results.length === 0) {
                return {
                  content: [{ type: "text", text: "No matching memories found." }],
                  details: { found: 0 },
                };
              }
              if (results.length === 1 && (results[0].score ?? 0) > 0.9) {
                await client.delete(results[0].memory_id);
                return {
                  content: [
                    {
                      type: "text",
                      text: `Forgotten: "${results[0].content.slice(0, 60)}..."`,
                    },
                  ],
                  details: { action: "deleted", id: String(results[0].memory_id) },
                };
              }
              const list = results
                .map(
                  (r) =>
                    `- [${String(r.memory_id).slice(0, 8)}] ${r.content.slice(0, 60)}...`,
                )
                .join("\n");
              return {
                content: [
                  {
                    type: "text",
                    text: `Found ${results.length} candidates. Specify memoryId:\n${list}`,
                  },
                ],
                details: {
                  action: "candidates",
                  candidates: results.map((r) => ({
                    id: String(r.memory_id),
                    text: r.content,
                    score: r.score,
                  })),
                },
              };
            }

            return {
              content: [{ type: "text", text: "Provide query or memoryId." }],
              details: { error: "missing_param" },
            };
          } catch (err) {
            api.logger.warn?.(`memory-powermem: forget failed: ${String(err)}`);
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to forget: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_forget" },
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const ltm = program
          .command("ltm")
          .description("PowerMem long-term memory plugin commands");

        ltm
          .command("search")
          .description("Search memories")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "5")
          .action(async (query: string, opts: { limit?: string }) => {
            const limit = parseInt(opts.limit ?? "5", 10);
            const results = await client.search(query, limit);
            console.log(JSON.stringify(results, null, 2));
          });

        ltm
          .command("health")
          .description("Check PowerMem server health")
          .action(async () => {
            try {
              const h = await client.health();
              console.log("PowerMem:", h.status);
            } catch (err) {
              console.error("PowerMem health check failed:", err);
              process.exitCode = 1;
            }
          });

        ltm
          .command("add")
          .description("Manually add a memory (for testing or one-off storage)")
          .argument("<text>", "Content to store")
          .action(async (text: string) => {
            try {
              const created = await client.add(text.trim(), { infer: cfg.inferOnAdd });
              if (created.length === 0) {
                console.log("Stored (no inferred items).");
              } else {
                console.log(`Stored ${created.length} item(s):`, created.map((c) => c.memory_id));
              }
            } catch (err) {
              console.error("PowerMem add failed:", err);
              process.exitCode = 1;
            }
          });
      },
      { commands: ["ltm"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event) => {
        if (!event.prompt || event.prompt.length < 5) return;

        try {
          const results = await client.search(event.prompt, 3);
          if (results.length === 0) return;

          const memoryContext = results.map((r) => `- ${r.content}`).join("\n");
          api.logger.info?.(
            `memory-powermem: injecting ${results.length} memories into context`,
          );
          return {
            prependContext: `<relevant-memories>\nThe following memories may be relevant to this conversation:\n${memoryContext}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn?.(`memory-powermem: recall failed: ${String(err)}`);
        }
      });
    }

    if (cfg.autoCapture) {
      api.on("agent_end", async (event) => {
        if (!event.success || !event.messages || event.messages.length === 0) {
          return;
        }

        try {
          const texts: string[] = [];
          for (const msg of event.messages) {
            if (!msg || typeof msg !== "object") continue;
            const msgObj = msg as Record<string, unknown>;
            const role = msgObj.role;
            if (role !== "user" && role !== "assistant") continue;
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

          // Use all conversation content; PowerMem infers memories (no trigger-phrase filter)
          const MIN_LEN = 10;
          const MAX_CHUNK_LEN = 6000;
          const MAX_CHUNKS_PER_SESSION = 3;
          const sanitized = texts
            .filter((t): t is string => typeof t === "string" && t.trim().length >= MIN_LEN)
            .map((t) => t.trim())
            .filter(
              (t) =>
                !t.includes("<relevant-memories>") &&
                !(t.startsWith("<") && t.includes("</")),
            );
          if (sanitized.length === 0) return;

          const combined = sanitized.join("\n\n");
          const chunks: string[] = [];
          for (let i = 0; i < combined.length; i += MAX_CHUNK_LEN) {
            if (chunks.length >= MAX_CHUNKS_PER_SESSION) break;
            chunks.push(combined.slice(i, i + MAX_CHUNK_LEN));
          }

          let stored = 0;
          for (const chunk of chunks) {
            const created = await client.add(chunk, { infer: cfg.inferOnAdd });
            stored += created.length;
          }
          if (stored > 0) {
            api.logger.info?.(`memory-powermem: auto-captured ${stored} memories from conversation`);
          }
        } catch (err) {
          api.logger.warn?.(`memory-powermem: capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-powermem",
      start: async () => {
        try {
          const h = await client.health();
          api.logger.info?.(
            `memory-powermem: initialized (${cfg.baseUrl}, health: ${h.status})`,
          );
        } catch (err) {
          api.logger.warn?.(
            `memory-powermem: health check failed (is PowerMem server running?): ${String(err)}`,
          );
        }
      },
      stop: () => {
        api.logger.info?.("memory-powermem: stopped");
      },
    });
  },
};

export default memoryPlugin;
