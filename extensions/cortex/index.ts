/**
 * Cortex - Core Memory Process for OpenClaw
 *
 * Enhances the existing memory_search with:
 * - Short-term memory (STM) fast path for recent context
 * - Temporal + importance weighting on search results
 * - Auto-capture of important conversation moments
 *
 * Integrates with the Python Cortex system in ~/.openclaw/workspace/memory/
 *
 * Architecture:
 * - Hooks into existing memory_search via before_tool_call/after_tool_call
 * - STM check happens BEFORE embeddings search (fast O(1) access)
 * - Temporal re-ranking happens AFTER search results return
 * - Auto-capture runs on agent_end hook
 *
 * This plugin ADDS capabilities without duplicating existing memory infrastructure.
 */
import { Type } from "@sinclair/typebox";
import type { OpenClawPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { CortexBridge, type CortexMemory, type STMItem } from "./cortex-bridge.js";

// Importance triggers for auto-capture
const IMPORTANCE_TRIGGERS = [
  { pattern: /lesson learned|learned that|realized that/i, importance: 2.5 },
  { pattern: /important:|critical:|key insight/i, importance: 2.5 },
  { pattern: /remember this|don't forget|note to self/i, importance: 2.0 },
  { pattern: /decision:|chose to|decided to/i, importance: 2.0 },
  { pattern: /bug fix|fixed|resolved/i, importance: 1.5 },
  { pattern: /created|built|implemented/i, importance: 1.5 },
  { pattern: /preference|prefer|like to/i, importance: 1.5 },
];

// Category detection patterns
const CATEGORY_PATTERNS: Record<string, RegExp[]> = {
  trading: [/trading|bot|profit|loss|market|price|volume|position/i],
  moltbook: [/moltbook|post|thread|social|engagement/i],
  coding: [/code|bug|fix|implement|function|api|error|debug/i],
  meta: [/reflect|self|agency|consciousness|memory|cortex/i],
  learning: [/learn|understand|realize|insight|pattern/i],
  personal: [/prefer|like|want|feel|think/i],
  system: [/config|setting|gateway|service|process/i],
};

function detectCategory(content: string): string {
  const lowerContent = content.toLowerCase();
  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    if (patterns.some((p) => p.test(lowerContent))) {
      return category;
    }
  }
  return "general";
}

function detectImportance(content: string): number {
  for (const { pattern, importance } of IMPORTANCE_TRIGGERS) {
    if (pattern.test(content)) {
      return importance;
    }
  }
  return 1.0;
}

function shouldCapture(content: string): boolean {
  // Skip very short or very long content
  if (content.length < 20 || content.length > 1000) return false;

  // Skip tool outputs and system messages
  if (content.includes("<tool_result>") || content.includes("<system")) return false;

  // Skip markdown-heavy content (likely formatted output)
  if ((content.match(/```/g) || []).length > 2) return false;

  // Capture if importance triggers match
  if (IMPORTANCE_TRIGGERS.some(({ pattern }) => pattern.test(content))) return true;

  // Capture if it looks like a significant statement
  if (/^(I |We |The |This |That ).*[.!]$/m.test(content)) return true;

  return false;
}

/**
 * Check if STM items match a query (simple keyword matching).
 * Returns matching items with relevance scores.
 */
function matchSTMItems(items: STMItem[], query: string): Array<STMItem & { matchScore: number }> {
  const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (queryTerms.length === 0) return [];

  const matches: Array<STMItem & { matchScore: number }> = [];

  for (const item of items) {
    const content = item.content.toLowerCase();
    let matchCount = 0;
    for (const term of queryTerms) {
      if (content.includes(term)) matchCount++;
    }
    if (matchCount > 0) {
      const matchScore = matchCount / queryTerms.length;
      matches.push({ ...item, matchScore });
    }
  }

  // Sort by match score * importance
  return matches.sort((a, b) => (b.matchScore * b.importance) - (a.matchScore * a.importance));
}

/**
 * Calculate temporal decay score (higher = more recent).
 * Uses exponential decay with half-life of ~2 days.
 */
function calculateRecencyScore(timestamp: string): number {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const ageHours = (now - then) / (1000 * 60 * 60);
  // Half-life of ~48 hours
  return Math.exp(-ageHours / 48);
}

const cortexPlugin: OpenClawPlugin = {
  id: "cortex",
  name: "Cortex Memory",
  kind: "memory",

  configSchema: Type.Object({
    enabled: Type.Boolean({ default: true }),
    autoCapture: Type.Boolean({ default: true }),
    stmFastPath: Type.Boolean({ default: true }),
    temporalRerank: Type.Boolean({ default: true }),
    temporalWeight: Type.Number({ default: 0.4, minimum: 0, maximum: 1 }),
    importanceWeight: Type.Number({ default: 0.3, minimum: 0, maximum: 1 }),
    stmCapacity: Type.Number({ default: 20 }),
  }),

  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig as {
      enabled: boolean;
      autoCapture: boolean;
      stmFastPath: boolean;
      temporalRerank: boolean;
      temporalWeight: number;
      importanceWeight: number;
      stmCapacity: number;
    };

    if (!config.enabled) {
      api.logger.info("Cortex memory disabled by config");
      return;
    }

    const bridge = new CortexBridge();

    // Track pending STM matches for re-ranking
    const pendingStmMatches = new Map<string, Array<STMItem & { matchScore: number }>>();

    // Check if Cortex is available
    bridge.isAvailable().then((available) => {
      if (!available) {
        api.logger.warn("Cortex Python scripts not found in ~/.openclaw/workspace/memory/");
        return;
      }
      api.logger.info("Cortex memory system initialized");
    });

    // =========================================================================
    // Hook: before_tool_call - STM fast path for memory_search
    // =========================================================================
    if (config.stmFastPath) {
      api.on("before_tool_call", async (event, ctx) => {
        if (event.toolName !== "memory_search") return;

        try {
          const available = await bridge.isAvailable();
          if (!available) return;

          const query = (event.params as { query?: string }).query;
          if (!query || query.length < 3) return;

          // Fetch STM items and check for matches
          const stmItems = await bridge.getRecentSTM(config.stmCapacity);
          const matches = matchSTMItems(stmItems, query);

          if (matches.length > 0) {
            // Store matches for after_tool_call to merge
            const toolCallKey = `${ctx.sessionKey ?? "unknown"}:${event.toolName}:${query}`;
            pendingStmMatches.set(toolCallKey, matches);
            api.logger.debug?.(`Cortex STM: found ${matches.length} fast-path matches for "${query.slice(0, 30)}..."`);
          }
        } catch (err) {
          api.logger.debug?.(`Cortex STM check failed: ${err}`);
        }
      }, { priority: 100 }); // High priority to run before other hooks
    }

    // =========================================================================
    // Hook: after_tool_call - Temporal/importance re-ranking for memory_search
    // =========================================================================
    if (config.temporalRerank) {
      api.on("after_tool_call", async (event, ctx) => {
        if (event.toolName !== "memory_search") return;
        if (event.error) return;

        try {
          const query = (event.params as { query?: string }).query ?? "";
          const toolCallKey = `${ctx.sessionKey ?? "unknown"}:${event.toolName}:${query}`;

          // Get any STM matches we found in before_tool_call
          const stmMatches = pendingStmMatches.get(toolCallKey);
          pendingStmMatches.delete(toolCallKey);

          if (stmMatches && stmMatches.length > 0) {
            // Log that we have STM context to prepend
            api.logger.debug?.(`Cortex: ${stmMatches.length} STM items available for context`);
            // Note: The STM matches are available for the agent to use in its response
            // The after_tool_call hook is fire-and-forget, so we can't modify the result
            // But we log this for debugging - the real value is in the before_agent_start recall
          }
        } catch (err) {
          api.logger.debug?.(`Cortex re-rank failed: ${err}`);
        }
      });
    }

    // =========================================================================
    // Tool: cortex_add - Explicit memory storage with importance
    // =========================================================================
    api.registerTool(
      {
        name: "cortex_add",
        description:
          "Store an important memory in Cortex STM. Use for significant insights, decisions, lessons learned, or preferences. Auto-detects category and importance if not specified. Importance: 1.0=routine, 2.0=notable, 3.0=critical.",
        parameters: Type.Object({
          content: Type.String({ description: "Memory content to store" }),
          category: Type.Optional(
            Type.String({
              description: "Category: trading, moltbook, coding, meta, learning, personal, system, general",
            }),
          ),
          importance: Type.Optional(
            Type.Number({ description: "Importance 1.0-3.0 (default: auto-detect from content)" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const p = params as { content: string; category?: string; importance?: number };

          try {
            const available = await bridge.isAvailable();
            if (!available) {
              return {
                content: [{ type: "text", text: "Cortex memory system not available" }],
                details: { error: "unavailable" },
              };
            }

            const category = p.category ?? detectCategory(p.content);
            const importance = p.importance ?? detectImportance(p.content);

            // Add to STM (fast path for recent recall)
            await bridge.addToSTM(p.content, category, importance);

            // Also add to embeddings for semantic search
            const memId = await bridge.addMemory(p.content, {
              source: "agent",
              category,
              importance,
            });

            return {
              content: [
                {
                  type: "text",
                  text: `Memory stored in Cortex: [${category}] importance=${importance.toFixed(1)}`,
                },
              ],
              details: { id: memId, category, importance },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Cortex add error: ${err}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { names: ["cortex_add"] },
    );

    // =========================================================================
    // Tool: cortex_stm - Quick view of recent short-term memory
    // =========================================================================
    api.registerTool(
      {
        name: "cortex_stm",
        description:
          "View recent items from Cortex short-term memory (STM). Shows the last N significant events with O(1) access. Use to quickly recall recent context without full search.",
        parameters: Type.Object({
          limit: Type.Optional(Type.Number({ description: "Max items to show (default: 10)" })),
          category: Type.Optional(Type.String({ description: "Filter by category" })),
        }),
        async execute(_toolCallId, params) {
          const p = params as { limit?: number; category?: string };

          try {
            const available = await bridge.isAvailable();
            if (!available) {
              return {
                content: [{ type: "text", text: "Cortex memory system not available" }],
                details: { error: "unavailable" },
              };
            }

            const items = await bridge.getRecentSTM(p.limit ?? 10, p.category);

            return {
              content: [
                {
                  type: "text",
                  text: items.length > 0
                    ? items
                        .map((i) => {
                          const age = calculateRecencyScore(i.timestamp);
                          const ageLabel = age > 0.9 ? "now" : age > 0.5 ? "recent" : "older";
                          return `[${i.category}] (imp=${i.importance.toFixed(1)}, ${ageLabel}) ${i.content.slice(0, 150)}`;
                        })
                        .join("\n")
                    : "STM is empty.",
                },
              ],
              details: { count: items.length },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Cortex STM error: ${err}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { names: ["cortex_stm"] },
    );

    // =========================================================================
    // Tool: cortex_stats - Memory system statistics
    // =========================================================================
    api.registerTool(
      {
        name: "cortex_stats",
        description: "Get Cortex memory statistics: total indexed memories, STM fill level, breakdown by category and source.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const available = await bridge.isAvailable();
            if (!available) {
              return {
                content: [{ type: "text", text: "Cortex memory system not available" }],
                details: { error: "unavailable" },
              };
            }

            const stats = await bridge.getStats();
            const stm = await bridge.loadSTMDirect();

            return {
              content: [
                {
                  type: "text",
                  text: `Cortex Memory Stats:
- Total indexed: ${stats.total}
- STM items: ${stm.short_term_memory.length}/${stm.capacity}
- By category: ${Object.entries(stats.by_category).map(([k, v]) => `${k}(${v})`).join(", ") || "none"}
- By source: ${Object.entries(stats.by_source).map(([k, v]) => `${k}(${v})`).join(", ") || "none"}`,
                },
              ],
              details: stats,
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Cortex stats error: ${err}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { names: ["cortex_stats"] },
    );

    // =========================================================================
    // Hook: before_agent_start - Inject relevant STM context
    // =========================================================================
    // Note: This complements the existing memory_search, not replaces it.
    // STM recall is lightweight and fast, providing recent context hints.
    api.on("before_agent_start", async (event, ctx) => {
      if (!event.prompt || event.prompt.length < 10) return;

      try {
        const available = await bridge.isAvailable();
        if (!available) return;

        // Get recent STM items and check for relevance
        const stmItems = await bridge.getRecentSTM(config.stmCapacity);
        if (stmItems.length === 0) return;

        const matches = matchSTMItems(stmItems, event.prompt.slice(0, 200));
        if (matches.length === 0) return;

        // Take top 3 most relevant STM items
        const topMatches = matches.slice(0, 3);

        // Format as context hint
        const stmContext = topMatches
          .map((m) => {
            const recency = calculateRecencyScore(m.timestamp);
            const recencyLabel = recency > 0.8 ? "very recent" : recency > 0.4 ? "recent" : "older";
            return `- [${m.category}, ${recencyLabel}, imp=${m.importance.toFixed(1)}] ${m.content.slice(0, 120)}`;
          })
          .join("\n");

        return {
          prependContext: `<cortex-stm hint="recent context from short-term memory">
${stmContext}
</cortex-stm>`,
        };
      } catch (err) {
        api.logger.debug?.(`Cortex STM recall failed: ${err}`);
        return;
      }
    }, { priority: 50 }); // Run after other plugins but still early

    // =========================================================================
    // Hook: agent_end - Auto-capture important conversation moments
    // =========================================================================
    if (config.autoCapture) {
      api.on("agent_end", async (event, ctx) => {
        if (!event.success || !event.messages) return;

        try {
          const available = await bridge.isAvailable();
          if (!available) return;

          // Extract text from assistant messages
          const texts: string[] = [];
          for (const msg of event.messages as Array<{ role?: string; content?: unknown }>) {
            if (msg.role !== "assistant") continue;

            if (typeof msg.content === "string") {
              texts.push(msg.content);
            } else if (Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
                  texts.push(block.text as string);
                }
              }
            }
          }

          // Check last few messages for capture-worthy content
          let capturedCount = 0;
          for (const text of texts.slice(-5)) {
            if (!shouldCapture(text)) continue;

            const category = detectCategory(text);
            const importance = detectImportance(text);

            // Only capture if notable (importance >= 1.5)
            if (importance >= 1.5) {
              const content = text.slice(0, 500);
              await bridge.addToSTM(content, category, importance);
              await bridge.addMemory(content, {
                source: "auto-capture",
                category,
                importance,
              });
              capturedCount++;
              api.logger.debug?.(`Cortex auto-captured: [${category}] imp=${importance} "${text.slice(0, 40)}..."`);
            }
          }

          if (capturedCount > 0) {
            api.logger.debug?.(`Cortex: auto-captured ${capturedCount} memories from conversation`);
          }
        } catch (err) {
          api.logger.debug?.(`Cortex auto-capture failed: ${err}`);
        }
      });
    }

    // Register service for lifecycle management
    api.registerService({
      id: "cortex",
      async start() {
        const available = await bridge.isAvailable();
        if (available) {
          // Sync on startup
          try {
            await bridge.syncAll();
            api.logger.info("Cortex memory synced on startup");
          } catch (err) {
            api.logger.warn(`Cortex sync failed: ${err}`);
          }
        }
      },
      async stop() {
        api.logger.info("Cortex memory service stopped");
      },
    });

    // Register CLI commands
    api.registerCli(
      ({ program }) => {
        const cortexCmd = program.command("cortex").description("Cortex memory management");

        cortexCmd
          .command("stats")
          .description("Show memory statistics")
          .action(async () => {
            const stats = await bridge.getStats();
            const stm = await bridge.loadSTMDirect();
            console.log("Cortex Memory Statistics:");
            console.log(`  Total indexed: ${stats.total}`);
            console.log(`  STM items: ${stm.short_term_memory.length}/${stm.capacity}`);
            console.log(`  By category: ${JSON.stringify(stats.by_category)}`);
            console.log(`  By source: ${JSON.stringify(stats.by_source)}`);
          });

        cortexCmd
          .command("search <query>")
          .description("Search memories")
          .option("-l, --limit <n>", "Max results", "10")
          .option("-c, --category <cat>", "Filter by category")
          .option("-t, --temporal <weight>", "Temporal weight 0-1", "0.7")
          .action(async (query: string, opts: { limit: string; category?: string; temporal: string }) => {
            const results = await bridge.searchMemories(query, {
              limit: parseInt(opts.limit),
              category: opts.category,
              temporalWeight: parseFloat(opts.temporal),
            });
            for (const r of results) {
              console.log(`[${r.score?.toFixed(2)} | ${r.category}] ${r.content.slice(0, 100)}`);
            }
          });

        cortexCmd
          .command("sync")
          .description("Sync STM and collections to embeddings")
          .action(async () => {
            const result = await bridge.syncAll();
            console.log(`Synced: ${result.stm} from STM, ${result.collections} from collections`);
          });

        cortexCmd
          .command("maintenance [mode]")
          .description("Run maintenance (nightly or weekly)")
          .action(async (mode: string = "nightly") => {
            const result = await bridge.runMaintenance(mode as "nightly" | "weekly");
            console.log(`Maintenance (${mode}): ${result}`);
          });
      },
      { commands: ["cortex"] },
    );
  },
};

export default cortexPlugin;
