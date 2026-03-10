/**
 * OpenClaw Memory (Mem0) Plugin
 *
 * Long-term semantic memory via a self-hosted Mem0 REST API.
 * Provides tools for recall, store, list, and forget operations,
 * plus auto-recall/capture via lifecycle hooks.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/memory-mem0";

// ============================================================================
// Types
// ============================================================================

interface Mem0Config {
  baseUrl: string;
  userId: string;
  autoCapture: boolean;
  autoRecall: boolean;
  recallLimit: number;
  recallThreshold: number;
}

interface Memory {
  id: string;
  memory: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

interface AddResponse {
  success: boolean;
  result: {
    results: Array<{
      id: string;
      memory: string;
      event: string;
    }>;
  };
}

interface HealthCheckResult {
  healthy: boolean;
  status?: string;
  error?: string;
}

// ============================================================================
// Config Schema
// ============================================================================

const configSchema = {
  parse(value: unknown): Mem0Config {
    const v = (value as Record<string, unknown>) || {};
    return {
      baseUrl: (v.baseUrl as string) || "http://127.0.0.1:8420",
      userId: (v.userId as string) || "openclaw",
      autoCapture: v.autoCapture !== false,
      autoRecall: v.autoRecall !== false,
      recallLimit: (v.recallLimit as number) || 5,
      recallThreshold: (v.recallThreshold as number) || 0.4,
    };
  },
};

// ============================================================================
// Secret Detection
// ============================================================================

/** Patterns that indicate a message contains secrets or credentials. */
const SECRET_PATTERNS = [
  /\bAPI_KEY\s*[=:]/i,
  /\bTOKEN\s*[=:]/i,
  /\bPASSWORD\s*[=:]/i,
  /\bSECRET\s*[=:]/i,
  /\bACCESS_KEY\s*[=:]/i,
  /\bPRIVATE_KEY\s*[=:]/i,
  /\bAUTH_TOKEN\s*[=:]/i,
  /\bDATABASE_URL\s*[=:]/i,
  /\bCONNECTION_STRING\s*[=:]/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bghp_[A-Za-z0-9]{36,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
];

/**
 * Check whether a text contains likely secrets or credentials.
 * Used to prevent auto-capture of sensitive content.
 */
export function containsSecrets(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

// ============================================================================
// Mem0 Client
// ============================================================================

class Mem0Client {
  private config: Mem0Config;
  private healthChecked = false;
  private lastHealthResult: HealthCheckResult | null = null;
  private logger: PluginLogger;

  constructor(config: Mem0Config, logger: PluginLogger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Check Mem0 server health. Caches result after first successful check.
   * Exposed publicly so external consumers (e.g. a /memory dashboard) can query health.
   */
  async checkHealth(): Promise<HealthCheckResult> {
    try {
      const response = await fetch(`${this.config.baseUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        const result: HealthCheckResult = {
          healthy: false,
          error: `HTTP ${response.status}`,
        };
        this.lastHealthResult = result;
        return result;
      }

      const data = (await response.json()) as Record<string, unknown>;
      const result: HealthCheckResult = {
        healthy: true,
        status: (data.status as string) ?? "ok",
      };
      this.healthChecked = true;
      this.lastHealthResult = result;
      return result;
    } catch (error) {
      const result: HealthCheckResult = {
        healthy: false,
        error: String(error),
      };
      this.lastHealthResult = result;
      return result;
    }
  }

  /** Returns the last cached health result, or null if never checked. */
  getLastHealthResult(): HealthCheckResult | null {
    return this.lastHealthResult;
  }

  private async ensureHealthy(): Promise<void> {
    if (this.healthChecked) return;

    const result = await this.checkHealth();
    if (result.healthy) {
      this.logger.info(`memory-mem0: connected to Mem0 server: ${result.status}`);
    } else {
      this.logger.warn(`memory-mem0: could not connect to Mem0 server: ${result.error}`);
    }
  }

  async search(query: string, userId?: string, limit?: number): Promise<Memory[]> {
    await this.ensureHealthy();

    const maxResults = limit || this.config.recallLimit;

    try {
      const response = await fetch(`${this.config.baseUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          user_id: userId || this.config.userId,
        }),
      });

      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const data = (await response.json()) as { results?: Memory[]; memories?: Memory[] };
      const memories = data.results || data.memories || [];
      return memories.slice(0, maxResults);
    } catch (error) {
      this.logger.error(`memory-mem0: search error: ${String(error)}`);
      return [];
    }
  }

  async add(content: string, userId?: string, agentId?: string): Promise<AddResponse | null> {
    await this.ensureHealthy();

    // Mem0 expects { messages: [{role, content}], user_id, agent_id? }
    const body: Record<string, unknown> = {
      messages: [{ role: "user", content }],
      user_id: userId || this.config.userId,
    };
    if (agentId) {
      body.agent_id = agentId;
    }

    try {
      const response = await fetch(`${this.config.baseUrl}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Add failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      this.logger.error(`memory-mem0: add error: ${String(error)}`);
      return null;
    }
  }

  async list(userId?: string, limit?: number): Promise<Memory[]> {
    await this.ensureHealthy();

    const params = new URLSearchParams({
      user_id: userId || this.config.userId,
    });
    if (limit) {
      params.set("limit", String(limit));
    }

    try {
      const response = await fetch(`${this.config.baseUrl}/memories?${params}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        throw new Error(`List failed: ${response.statusText}`);
      }

      const data = (await response.json()) as { results?: Memory[]; memories?: Memory[] };
      return data.results || data.memories || [];
    } catch (error) {
      this.logger.error(`memory-mem0: list error: ${String(error)}`);
      return [];
    }
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureHealthy();

    try {
      const response = await fetch(`${this.config.baseUrl}/memories/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        throw new Error(`Delete failed: ${response.statusText}`);
      }

      return true;
    } catch (error) {
      this.logger.error(`memory-mem0: delete error: ${String(error)}`);
      return false;
    }
  }
}

// ============================================================================
// userId Resolution
// ============================================================================

/**
 * Resolve the effective userId from hook context, falling back to config default.
 * Uses sessionKey as a stable per-user identifier when available.
 */
function resolveUserId(
  ctx: { sessionKey?: string; agentId?: string },
  configUserId: string,
): string {
  // sessionKey is the most stable per-conversation identifier available in hook context
  return ctx.sessionKey || configUserId;
}

// ============================================================================
// Plugin Definition
// ============================================================================

export default {
  id: "memory-mem0",
  name: "Mem0 Memory",
  description: "Long-term semantic memory via a self-hosted Mem0 REST API",
  kind: "memory" as const,
  configSchema,

  register(api: OpenClawPluginApi) {
    const config = configSchema.parse(api.pluginConfig);
    const client = new Mem0Client(config, api.logger);

    // ========================================================================
    // Tools
    // ========================================================================

    // Tool: memory_recall
    api.registerTool(
      {
        name: "memory_recall",
        label: "Recall Memory",
        description: "Search long-term memory for relevant facts and context",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(
            Type.Number({
              description: "Maximum number of results (default 5)",
              minimum: 1,
              maximum: 20,
            }),
          ),
        }),
        async execute(
          _toolCallId: string,
          params: { query: string; limit?: number },
        ) {
          const memories = await client.search(params.query, undefined, params.limit);

          if (memories.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `No relevant memories found for: "${params.query}"`,
                },
              ],
            };
          }

          const formatted = memories
            .map((m, i) => {
              const score =
                m.score !== undefined ? ` (relevance: ${m.score.toFixed(2)})` : "";
              return `${i + 1}. ${m.memory}${score}`;
            })
            .join("\n");

          return {
            content: [
              {
                type: "text" as const,
                text: `Found ${memories.length} relevant memories:\n\n${formatted}`,
              },
            ],
          };
        },
      },
      { name: "memory_recall" },
    );

    // Tool: memory_store
    api.registerTool(
      {
        name: "memory_store",
        label: "Store Memory",
        description: "Store a new fact or context in long-term memory",
        parameters: Type.Object({
          content: Type.String({
            description: "Fact or context to remember",
          }),
          agent_id: Type.Optional(
            Type.String({ description: "Agent ID for metadata (optional)" }),
          ),
        }),
        async execute(
          _toolCallId: string,
          params: { content: string; agent_id?: string },
        ) {
          const result = await client.add(params.content, undefined, params.agent_id);

          if (!result || !result.success) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Failed to store memory.",
                },
              ],
            };
          }

          const stored = result.result.results.map((r) => r.memory).join(", ");
          return {
            content: [
              {
                type: "text" as const,
                text: `Stored in memory: ${stored}`,
              },
            ],
          };
        },
      },
      { name: "memory_store" },
    );

    // Tool: memory_list
    api.registerTool(
      {
        name: "memory_list",
        label: "List Memories",
        description: "List all stored long-term memories for the current user",
        parameters: Type.Object({
          limit: Type.Optional(
            Type.Number({
              description: "Max results",
              minimum: 1,
              maximum: 100,
            }),
          ),
        }),
        async execute(
          _toolCallId: string,
          params: { limit?: number },
        ) {
          const memories = await client.list(undefined, params.limit);

          if (memories.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "No memories stored yet.",
                },
              ],
            };
          }

          const formatted = memories
            .map((m, i) => `${i + 1}. [${m.id}] ${m.memory}`)
            .join("\n");

          return {
            content: [
              {
                type: "text" as const,
                text: `Total memories: ${memories.length}\n\n${formatted}`,
              },
            ],
          };
        },
      },
      { name: "memory_list" },
    );

    // Tool: memory_forget
    api.registerTool(
      {
        name: "memory_forget",
        label: "Forget Memory",
        description: "Delete a specific memory by ID",
        parameters: Type.Object({
          id: Type.String({ description: "Memory ID to delete" }),
        }),
        async execute(_toolCallId: string, params: { id: string }) {
          const success = await client.delete(params.id);

          // Audit log for deletion
          const timestamp = new Date().toISOString();
          if (success) {
            api.logger.info(
              `memory-mem0: deleted memory id=${params.id} at=${timestamp}`,
            );
          } else {
            api.logger.warn(
              `memory-mem0: failed to delete memory id=${params.id} at=${timestamp}`,
            );
          }

          return {
            content: [
              {
                type: "text" as const,
                text: success
                  ? `Deleted memory: ${params.id}`
                  : `Failed to delete memory: ${params.id}`,
              },
            ],
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
        const mem0 = program
          .command("mem0")
          .description("Mem0 memory plugin commands");

        mem0
          .command("search")
          .description("Search long-term memory")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "5")
          .action(async (query: string, opts: { limit: string }) => {
            const memories = await client.search(query, undefined, parseInt(opts.limit));
            if (memories.length === 0) {
              console.log(`No memories found for: "${query}"`);
              return;
            }
            console.log(`\nFound ${memories.length} memories:\n`);
            for (const [i, m] of memories.entries()) {
              const score =
                m.score !== undefined ? ` [${m.score.toFixed(2)}]` : "";
              console.log(`${i + 1}. ${m.memory}${score}`);
              console.log(`   ID: ${m.id}\n`);
            }
          });

        mem0
          .command("list")
          .description("List all stored memories")
          .action(async () => {
            const memories = await client.list();
            if (memories.length === 0) {
              console.log("No memories stored yet.");
              return;
            }
            console.log(`\nTotal memories: ${memories.length}\n`);
            for (const [i, m] of memories.entries()) {
              console.log(`${i + 1}. ${m.memory}`);
              console.log(`   ID: ${m.id}\n`);
            }
          });

        mem0
          .command("forget")
          .description("Delete a memory by ID")
          .argument("<id>", "Memory ID to delete")
          .action(async (id: string) => {
            const success = await client.delete(id);
            console.log(
              success ? `Deleted: ${id}` : `Failed to delete: ${id}`,
            );
          });

        mem0
          .command("health")
          .description("Check Mem0 server health")
          .action(async () => {
            const result = await client.checkHealth();
            if (result.healthy) {
              console.log(`Mem0 server healthy: ${result.status}`);
            } else {
              console.log(`Mem0 server unhealthy: ${result.error}`);
            }
          });
      },
      { commands: ["mem0"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Auto-recall: inject relevant memories before agent starts
    if (config.autoRecall) {
      api.on("before_agent_start", async (event, ctx) => {
        const prompt = event.prompt || "";
        if (!prompt.trim()) return;

        const userId = resolveUserId(ctx, config.userId);
        const memories = await client.search(prompt, userId, config.recallLimit);
        const relevant = memories.filter(
          (m) => (m.score || 0) >= config.recallThreshold,
        );

        if (relevant.length === 0) return;

        const formatted = relevant
          .map((m) => `- ${m.memory} [score: ${m.score?.toFixed(2)}]`)
          .join("\n");

        return {
          prependContext: `<relevant-memories>\nRelevant facts from long-term memory:\n${formatted}\n</relevant-memories>`,
        };
      });
    }

    // Auto-capture: store key facts after agent completes
    if (config.autoCapture) {
      api.on("agent_end", async (event, ctx) => {
        const messages = event.messages || [];
        const userId = resolveUserId(ctx, config.userId);

        // Collect user/assistant message pairs for Mem0 batch add
        const pairs: Array<{ role: string; content: string }> = [];

        for (const msg of messages) {
          if (!msg || typeof msg !== "object") continue;
          const msgObj = msg as Record<string, unknown>;

          if (msgObj.role !== "user" && msgObj.role !== "assistant") continue;

          // Extract text: string for user messages, array of TextContent for assistant
          let text: string;
          if (typeof msgObj.content === "string") {
            text = msgObj.content;
          } else if (Array.isArray(msgObj.content)) {
            text = (msgObj.content as Array<Record<string, unknown>>)
              .filter((c) => c.type === "text")
              .map((c) => String(c.text ?? ""))
              .join("\n");
          } else {
            continue;
          }

          // Skip recalled memory context to prevent feedback loops
          if (text.includes("<relevant-memories>")) continue;

          // Only capture substantial messages
          if (text.trim().length < 50) continue;

          // Skip messages containing secrets/credentials
          if (containsSecrets(text)) {
            api.logger.debug?.(`memory-mem0: skipped auto-capture (secrets detected)`);
            continue;
          }

          pairs.push({ role: String(msgObj.role), content: text });
        }

        if (pairs.length === 0) return;

        // Send as a conversation to Mem0 so it can extract facts from context
        try {
          const body: Record<string, unknown> = {
            messages: pairs,
            user_id: userId,
          };
          if (ctx.agentId) {
            body.agent_id = ctx.agentId;
          }
          const response = await fetch(`${config.baseUrl}/memories`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!response.ok) {
            api.logger.warn(`memory-mem0: auto-capture failed: ${response.statusText}`);
          }
        } catch (err) {
          api.logger.warn(`memory-mem0: auto-capture error: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-mem0",
      start: () => {
        api.logger.info(
          `memory-mem0: plugin registered (autoRecall=${config.autoRecall}, autoCapture=${config.autoCapture})`,
        );
      },
      stop: () => {
        api.logger.info("memory-mem0: stopped");
      },
    });
  },
};
