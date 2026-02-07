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
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { OpenClawPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { CortexBridge, type STMItem, estimateTokens } from "./cortex-bridge.js";

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
  if (content.length < 20 || content.length > 1000) {
    return false;
  }

  // Skip tool outputs and system messages
  if (content.includes("<tool_result>") || content.includes("<system")) {
    return false;
  }

  // Skip markdown-heavy content (likely formatted output)
  if ((content.match(/```/g) || []).length > 2) {
    return false;
  }

  // Capture if importance triggers match
  if (IMPORTANCE_TRIGGERS.some(({ pattern }) => pattern.test(content))) {
    return true;
  }

  // Capture if it looks like a significant statement
  if (/^(I |We |The |This |That ).*[.!]$/m.test(content)) {
    return true;
  }

  return false;
}

/**
 * Check if STM items match a query with improved relevance scoring.
 * Now includes: temporal decay, importance weighting, fuzzy matching, category boosting.
 */
function matchSTMItems(items: STMItem[], query: string, temporalWeight = 0.4, importanceWeight = 0.3): Array<STMItem & { matchScore: number }> {
  const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (queryTerms.length === 0) {
    return [];
  }

  // Detect query category for boosting
  const queryCategory = detectCategory(query);

  const matches: Array<STMItem & { matchScore: number }> = [];

  for (const item of items) {
    const content = item.content.toLowerCase();

    // Keyword matching (base score)
    let matchCount = 0;
    let exactPhraseBonus = 0;
    for (const term of queryTerms) {
      if (content.includes(term)) {
        matchCount++;
      }
    }

    // Bonus for exact phrase match
    const queryPhrase = queryTerms.join(" ");
    if (queryPhrase.length > 5 && content.includes(queryPhrase)) {
      exactPhraseBonus = 0.3;
    }

    if (matchCount === 0 && exactPhraseBonus === 0) {
      continue;
    }

    // Base keyword score (0-1)
    const keywordScore = matchCount / queryTerms.length + exactPhraseBonus;

    // Temporal score (0-1, higher = more recent)
    const recencyScore = calculateRecencyScore(item.timestamp);

    // Importance score (normalized to 0-1, assuming 1-3 scale)
    const normalizedImportance = (item.importance - 1) / 2;

    // Category match bonus
    const categoryBonus = item.category === queryCategory ? 0.2 : 0;

    // Combined score with weights
    const relevanceWeight = 1 - temporalWeight - importanceWeight;
    const matchScore =
      (keywordScore * relevanceWeight) +
      (recencyScore * temporalWeight) +
      (normalizedImportance * importanceWeight) +
      categoryBonus;

    matches.push({ ...item, matchScore });
  }

  // Sort by combined score (highest first) - use toSorted to avoid mutation
  return matches.toSorted((a, b) => b.matchScore - a.matchScore);
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
    temporalWeight: Type.Number({ default: 0.5, minimum: 0, maximum: 1 }),
    importanceWeight: Type.Number({ default: 0.4, minimum: 0, maximum: 1 }),
    stmCapacity: Type.Number({ default: 50 }),
    minMatchScore: Type.Number({ default: 0.3, minimum: 0, maximum: 1 }),
    episodicMemoryTurns: Type.Number({ default: 20, minimum: 5, maximum: 50 }),
    // PHASE 2: Hot Memory Tier
    hotTierSize: Type.Number({ default: 100, minimum: 10, maximum: 1000 }),
    // PHASE 2: Token Budget System
    maxContextTokens: Type.Number({ default: 2000, minimum: 500, maximum: 10000 }),
    relevanceThreshold: Type.Number({ default: 0.5, minimum: 0, maximum: 1 }),
    truncateOldMemoriesTo: Type.Number({ default: 200, minimum: 50, maximum: 500 }),
    // PHASE 2: Delta Sync & Prefetch
    deltaSyncEnabled: Type.Boolean({ default: true }),
    prefetchEnabled: Type.Boolean({ default: true }),
  }),

  register(api: OpenClawPluginApi) {
    const rawConfig = (api.pluginConfig ?? {}) as Partial<{
      enabled: boolean;
      autoCapture: boolean;
      stmFastPath: boolean;
      temporalRerank: boolean;
      temporalWeight: number;
      importanceWeight: number;
      stmCapacity: number;
      minMatchScore: number;
      episodicMemoryTurns: number;
      // PHASE 2
      hotTierSize: number;
      maxContextTokens: number;
      relevanceThreshold: number;
      truncateOldMemoriesTo: number;
      deltaSyncEnabled: boolean;
      prefetchEnabled: boolean;
    }>;

    // Apply defaults (PHASE 1 & 2: Memory expansion)
    const config = {
      enabled: rawConfig.enabled ?? true,
      autoCapture: rawConfig.autoCapture ?? true,
      stmFastPath: rawConfig.stmFastPath ?? true,
      temporalRerank: rawConfig.temporalRerank ?? true,
      temporalWeight: rawConfig.temporalWeight ?? 0.5,      // Favor recent
      importanceWeight: rawConfig.importanceWeight ?? 0.4,  // Favor important
      stmCapacity: rawConfig.stmCapacity ?? 50000,          // PHASE 1: 50K items
      minMatchScore: rawConfig.minMatchScore ?? 0.3,        // Filter low-confidence results
      episodicMemoryTurns: rawConfig.episodicMemoryTurns ?? 20, // Working memory turns to pin
      // PHASE 2: Hot Memory Tier
      hotTierSize: rawConfig.hotTierSize ?? 100,
      // PHASE 2: Token Budget System (lowered defaults to prevent context overflow)
      maxContextTokens: rawConfig.maxContextTokens ?? 500,
      relevanceThreshold: rawConfig.relevanceThreshold ?? 0.65,
      truncateOldMemoriesTo: rawConfig.truncateOldMemoriesTo ?? 120,
      // PHASE 2: Delta Sync & Prefetch
      deltaSyncEnabled: rawConfig.deltaSyncEnabled ?? true,
      prefetchEnabled: rawConfig.prefetchEnabled ?? true,
    };

    if (!config.enabled) {
      api.logger.info("Cortex memory disabled by config");
      return;
    }

    // PHASE 2: Initialize bridge with token budget config
    const bridge = new CortexBridge({
      hotTierSize: config.hotTierSize,
      tokenBudget: {
        maxContextTokens: config.maxContextTokens,
        relevanceThreshold: config.relevanceThreshold,
        truncateOldMemoriesTo: config.truncateOldMemoriesTo,
      },
    });

    // Track last detected category for predictive prefetch
    let lastDetectedCategory: string | null = null;

    // Track pending STM matches for re-ranking
    const pendingStmMatches = new Map<string, Array<STMItem & { matchScore: number }>>();

    // PHASE 1 & 2: Warm up caches on startup
    void (async () => {
      const available = await bridge.isAvailable();
      if (!available) {
        api.logger.warn("Cortex Python scripts not found in ~/.openclaw/workspace/memory/");
        return;
      }

      // Warm up all RAM caches (PHASE 2: also starts delta sync)
      const warmupResult = await bridge.warmupCaches();
      const indexStats = bridge.memoryIndex.getStats();
      api.logger.info(
        `Cortex Phase 2 initialized: ${warmupResult.stm} STM, ${warmupResult.memories} memories, ` +
        `${indexStats.hotCount} hot tier, token budget: ${config.maxContextTokens}`
      );

      // Update STM capacity in the JSON file
      await bridge.updateSTMCapacity(config.stmCapacity);

      // PHASE 2: Stop delta sync if disabled
      if (!config.deltaSyncEnabled) {
        bridge.stopDeltaSync();
      }
    })();

    // =========================================================================
    // Hook: before_tool_call - STM fast path for memory_search
    // =========================================================================
    if (config.stmFastPath) {
      api.on("before_tool_call", async (event, _ctx) => {
        if (event.toolName !== "memory_search") {
          return;
        }

        try {
          const available = await bridge.isAvailable();
          if (!available) {
            return;
          }

          const query = (event.params as { query?: string }).query;
          if (!query || query.length < 3) {
            return;
          }

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
      api.on("after_tool_call", async (event, _ctx) => {
        if (event.toolName !== "memory_search") {
          return;
        }
        if (event.error) {
          return;
        }

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
    // Tool: cortex_stats - Memory system statistics (PHASE 1: includes RAM cache info)
    // =========================================================================
    api.registerTool(
      {
        name: "cortex_stats",
        description: "Get Cortex memory statistics: RAM cache status, STM, Active Session, memory index, category breakdown.",
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

            const dbStats = await bridge.getStats();
            const extStats = bridge.getExtendedStats();
            const formatBytes = (bytes: number) => {
              if (bytes < 1024) {
                return `${bytes}B`;
              }
              if (bytes < 1024 * 1024) {
                return `${(bytes / 1024).toFixed(1)}KB`;
              }
              return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
            };

            const hotTierStats = extStats.memoryIndex.hotTierStats;
            return {
              content: [
                {
                  type: "text",
                  text: `Cortex Memory Stats (PHASE 2 - Token Budget + Hot Tier):

📊 RAM Cache Status:
- STM cached: ${extStats.stm.cached ? "YES" : "NO"} (${extStats.stm.count}/${extStats.stm.capacity} items)
- Active Session: ${extStats.activeSession.count}/${extStats.activeSession.capacity} messages (${formatBytes(extStats.activeSession.sizeBytes)})
- Memory Index: ${extStats.memoryIndex.total} items cached (${formatBytes(extStats.memoryIndex.sizeBytes)})
- Total RAM usage: ${formatBytes(extStats.totalRamUsageBytes)}

💾 Database Stats:
- Total indexed: ${dbStats.total}
- By category: ${Object.entries(dbStats.by_category).map(([k, v]) => `${k}(${v})`).join(", ") || "none"}
- By source: ${Object.entries(dbStats.by_source).map(([k, v]) => `${k}(${v})`).join(", ") || "none"}

🔥 Hot Memory Tier (PHASE 2):
- Hot tier size: ${hotTierStats.size}/${config.hotTierSize}
- Top accessed: ${hotTierStats.topAccessCounts.slice(0, 5).map(t => `${t.count.toFixed(1)}`).join(", ") || "none"}
- Categories: ${extStats.memoryIndex.byCategory ? Object.keys(extStats.memoryIndex.byCategory).length : 0}

💰 Token Budget (PHASE 2):
- Max context tokens: ${config.maxContextTokens}
- Relevance threshold: ${config.relevanceThreshold}
- Truncate old to: ${config.truncateOldMemoriesTo} chars
- Delta sync: ${config.deltaSyncEnabled ? "ON" : "OFF"}
- Prefetch: ${config.prefetchEnabled ? "ON" : "OFF"}`,
                },
              ],
              details: { dbStats, extStats, config: { maxContextTokens: config.maxContextTokens, relevanceThreshold: config.relevanceThreshold } },
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
    // Working Memory (Episodic) - Pinned items that are ALWAYS in context
    // =========================================================================
    const workingMemoryPath = join(homedir(), ".openclaw", "workspace", "memory", "working_memory.json");

    interface WorkingMemoryItem {
      content: string;
      pinnedAt: string;
      label?: string;
    }

    async function loadWorkingMemory(): Promise<WorkingMemoryItem[]> {
      try {
        const data = await readFile(workingMemoryPath, "utf-8");
        const parsed = JSON.parse(data) as { items: WorkingMemoryItem[] };
        return parsed.items || [];
      } catch {
        return [];
      }
    }

    async function saveWorkingMemory(items: WorkingMemoryItem[]): Promise<void> {
      await writeFile(workingMemoryPath, JSON.stringify({ items }, null, 2));
    }

    // =========================================================================
    // Tool: working_memory - Pin/view/clear items in working memory
    // =========================================================================
    api.registerTool(
      {
        name: "working_memory",
        description:
          "Manage working memory (episodic). Items pinned here are ALWAYS included in context and never summarized. Use 'pin' to add, 'view' to list, 'clear' to remove. Max 10 items.",
        parameters: Type.Object({
          action: Type.String({ description: "Action: 'pin', 'view', 'clear', 'unpin'" }),
          content: Type.Optional(Type.String({ description: "Content to pin (for 'pin' action)" })),
          label: Type.Optional(Type.String({ description: "Short label for the pinned item" })),
          index: Type.Optional(Type.Number({ description: "Index to unpin (for 'unpin' action, 0-based)" })),
        }),
        async execute(_toolCallId, params) {
          const p = params as { action: string; content?: string; label?: string; index?: number };
          const items = await loadWorkingMemory();

          try {
            switch (p.action) {
              case "pin": {
                if (!p.content) {
                  return { content: [{ type: "text", text: "Error: content required for pin action" }], details: { error: "missing content" } };
                }
                if (items.length >= 10) {
                  // Remove oldest item
                  items.shift();
                }
                items.push({
                  content: p.content.slice(0, 500),
                  pinnedAt: new Date().toISOString(),
                  label: p.label,
                });
                await saveWorkingMemory(items);
                return {
                  content: [{ type: "text", text: `Pinned to working memory (${items.length}/10 items)` }],
                  details: { count: items.length },
                };
              }
              case "view": {
                if (items.length === 0) {
                  return { content: [{ type: "text", text: "Working memory is empty" }], details: { count: 0 } };
                }
                const list = items.map((item, i) => {
                  const label = item.label ? `[${item.label}]` : "";
                  const age = Math.round((Date.now() - new Date(item.pinnedAt).getTime()) / 60000);
                  return `${i}. ${label} (${age}m ago) ${item.content.slice(0, 100)}...`;
                }).join("\n");
                return {
                  content: [{ type: "text", text: `Working Memory (${items.length}/10):\n${list}` }],
                  details: { count: items.length },
                };
              }
              case "unpin": {
                const idx = p.index ?? items.length - 1;
                if (idx < 0 || idx >= items.length) {
                  return { content: [{ type: "text", text: "Invalid index" }], details: { error: "invalid index" } };
                }
                const removed = items.splice(idx, 1)[0];
                await saveWorkingMemory(items);
                return {
                  content: [{ type: "text", text: `Unpinned: ${removed?.content?.slice(0, 50)}...` }],
                  details: { remaining: items.length },
                };
              }
              case "clear": {
                await saveWorkingMemory([]);
                return {
                  content: [{ type: "text", text: "Working memory cleared" }],
                  details: { count: 0 },
                };
              }
              default:
                return { content: [{ type: "text", text: `Unknown action: ${p.action}` }], details: { error: "unknown action" } };
            }
          } catch (err) {
            return { content: [{ type: "text", text: `Working memory error: ${err}` }], details: { error: String(err) } };
          }
        },
      },
      { names: ["working_memory", "wm"] },
    );

    // =========================================================================
    // Hook: message_received - Track Active Session (L2)
    // =========================================================================
    api.on("message_received", async (event, _ctx) => {
      if (!event.content) {
        return;
      }
      // Track user message in Active Session cache
      const content = typeof event.content === "string"
        ? event.content
        : JSON.stringify(event.content);
      bridge.trackMessage("user", content, event.messageId);
    });

    api.on("agent_end", async (event, _ctx) => {
      if (!event.success || !event.messages) {
        return;
      }
      // Track assistant response in Active Session cache
      const lastMessage = (event.messages as Array<{ role?: string; content?: unknown }>).slice(-1)[0];
      if (lastMessage?.role === "assistant" && lastMessage.content) {
        const content = typeof lastMessage.content === "string"
          ? lastMessage.content
          : JSON.stringify(lastMessage.content);
        bridge.trackMessage("assistant", content.slice(0, 500));
      }
    }, { priority: -10 }); // Run after other agent_end handlers

    // =========================================================================
    // Hook: before_agent_start - Inject ALL context tiers (L1-L4) with token budget
    // =========================================================================
    // PHASE 1 & 2 MEMORY TIERS (with token budget enforcement):
    // L1. Working Memory (pinned items) - ALWAYS in context (no token limit)
    // L2. Active Session (last 50 messages) - ELIMINATES "forgot 5 messages ago"
    // L3. Hot Memory Tier (top 100 most-accessed) - instant retrieval
    // L3.5. STM (keyword matching) - recent 48h context
    // L4. Semantic search - GPU-accelerated long-term knowledge
    // Results are deduplicated, token-budgeted, and filtered by relevanceThreshold.
    api.on("before_agent_start", async (event, _ctx) => {
      if (!event.prompt || event.prompt.length < 10) {
        return;
      }

      try {
        const available = await bridge.isAvailable();
        if (!available) {
          return;
        }

        const queryText = event.prompt.slice(0, 200);
        const contextParts: string[] = [];
        let usedTokens = 0;
        const tokenBudget = config.maxContextTokens;

        // PHASE 2: Predictive prefetch based on detected category
        const queryCategory = detectCategory(queryText);
        if (config.prefetchEnabled && queryCategory !== "general" && queryCategory !== lastDetectedCategory) {
          lastDetectedCategory = queryCategory;
          const prefetchCount = await bridge.prefetchCategory(queryCategory);
          if (prefetchCount > 0) {
            api.logger.debug?.(`Cortex: prefetched ${prefetchCount} memories for category "${queryCategory}"`);
          }
        }

        // L1. Working Memory (pinned items) - ALWAYS injected first (no token limit)
        const workingItems = await loadWorkingMemory();
        if (workingItems.length > 0) {
          const wmContext = workingItems.map((item, i) => {
            const label = item.label ? `[${item.label}]` : `[pinned-${i}]`;
            return `- ${label} ${item.content}`;
          }).join("\n");
          contextParts.push(`<working-memory hint="CRITICAL: pinned items - always keep in context">\n${wmContext}\n</working-memory>`);
          // Working memory doesn't count against budget (it's critical)
        }

        // L2. Active Session - Last 50 messages (PHASE 1: eliminates "forgot 5 messages ago")
        const activeSessionMessages = bridge.activeSession.search(queryText);
        if (activeSessionMessages.length > 0) {
          const sessionItems = activeSessionMessages.slice(0, 5);
          const sessionContext = sessionItems.map((m) => {
            return `- [${m.role}] ${m.content.slice(0, 150)}`;
          }).join("\n");
          const sessionTokens = estimateTokens(sessionContext);

          if (usedTokens + sessionTokens <= tokenBudget) {
            contextParts.push(`<active-session hint="recent conversation (this session)">\n${sessionContext}\n</active-session>`);
            usedTokens += sessionTokens;
          }
        }

        // L3. PHASE 2: Hot Memory Tier (most accessed memories)
        const hotMemories = bridge.getHotMemoriesTier(10);
        if (hotMemories.length > 0) {
          // Filter to relevant ones
          const queryTerms = queryText.toLowerCase().split(/\s+/).filter(t => t.length > 2);
          const relevantHot = hotMemories.filter(m => {
            const content = m.content.toLowerCase();
            return queryTerms.some(term => content.includes(term));
          }).slice(0, 3);

          if (relevantHot.length > 0) {
            const hotContext = relevantHot.map((m) => {
              const accessCount = bridge.memoryIndex.hotTier.getAccessCount(m.id);
              return `- [${m.category ?? "hot"}/access=${accessCount}] ${m.content.slice(0, config.truncateOldMemoriesTo)}`;
            }).join("\n");
            const hotTokens = estimateTokens(hotContext);

            if (usedTokens + hotTokens <= tokenBudget) {
              contextParts.push(`<hot-memory hint="frequently accessed knowledge">\n${hotContext}\n</hot-memory>`);
              usedTokens += hotTokens;

              // PHASE 2: Record co-occurrence for these memories
              if (relevantHot.length > 1) {
                bridge.memoryIndex.recordCoOccurrence(relevantHot.map(m => m.id));
              }
            }
          }
        }

        // L3.5. STM fast path (keyword matching for very recent items)
        const stmItems = await bridge.getRecentSTM(Math.min(config.stmCapacity, 100));
        const stmMatches = stmItems.length > 0
          ? matchSTMItems(stmItems, queryText, config.temporalWeight, config.importanceWeight)
              .filter(m => m.matchScore >= config.minMatchScore)
              .slice(0, 3)
          : [];

        if (stmMatches.length > 0) {
          const stmContext = stmMatches.map((m) => {
            const recency = calculateRecencyScore(m.timestamp);
            const recencyLabel = recency > 0.8 ? "now" : recency > 0.4 ? "recent" : "older";
            return `- [${m.category}/${recencyLabel}] ${m.content.slice(0, config.truncateOldMemoriesTo)}`;
          }).join("\n");
          const stmTokens = estimateTokens(stmContext);

          if (usedTokens + stmTokens <= tokenBudget) {
            contextParts.push(`<episodic-memory hint="recent events (last 48h)">\n${stmContext}\n</episodic-memory>`);
            usedTokens += stmTokens;
          }
        }

        // L4. Semantic search (GPU embeddings daemon - long-term knowledge)
        const remainingBudget = tokenBudget - usedTokens;
        if (remainingBudget > 100) { // Need at least 100 tokens for semantic results
          const daemonAvailable = await bridge.isEmbeddingsDaemonAvailable();
          if (daemonAvailable) {
            // PHASE 2: Use token-budgeted retrieval
            const budgetedResults = bridge.getContextWithinBudget(queryText, {
              maxContextTokens: remainingBudget,
              relevanceThreshold: config.relevanceThreshold,
              truncateOldMemoriesTo: config.truncateOldMemoriesTo,
            });

            // Deduplicate against STM and hot (by content substring match)
            const existingContents = new Set([
              ...stmMatches.map(m => m.content.slice(0, 50).toLowerCase()),
              ...hotMemories.slice(0, 3).map(m => m.content.slice(0, 50).toLowerCase()),
            ]);
            const uniqueResults = budgetedResults.filter(
              r => !existingContents.has(r.content.slice(0, 50).toLowerCase())
            );

            if (uniqueResults.length > 0) {
              const semanticContext = uniqueResults.map((r) => {
                return `- [${r.category ?? "general"}/tokens=${r.tokens}] ${r.finalContent}`;
              }).join("\n");
              contextParts.push(`<semantic-memory hint="related knowledge (token-budgeted)">\n${semanticContext}\n</semantic-memory>`);
              usedTokens += uniqueResults.reduce((sum, r) => sum + r.tokens, 0);
            }
          }
        }

        if (contextParts.length === 0) {
          return;
        }

        api.logger.debug?.(`Cortex: injected ${contextParts.length} tiers, ~${usedTokens}/${tokenBudget} tokens`);

        return {
          prependContext: contextParts.join("\n\n"),
        };
      } catch (err) {
        api.logger.debug?.(`Cortex context injection failed: ${err}`);
        return;
      }
    }, { priority: 50 }); // Run after other plugins but still early

    // =========================================================================
    // Hook: agent_end - Auto-capture important conversation moments
    // =========================================================================
    if (config.autoCapture) {
      api.on("agent_end", async (event, _ctx) => {
        if (!event.success || !event.messages) {
          return;
        }

        try {
          const available = await bridge.isAvailable();
          if (!available) {
            return;
          }

          // Extract text from assistant messages
          const texts: string[] = [];
          for (const msg of event.messages as Array<{ role?: string; content?: unknown }>) {
            if (msg.role !== "assistant") {
              continue;
            }

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
            if (!shouldCapture(text)) {
              continue;
            }

            const category = detectCategory(text);
            const importance = detectImportance(text);

            // Only capture if notable (importance >= 1.5)
            if (importance >= 1.5) {
              const content = text.slice(0, 500);
              await bridge.addToSTM(content, category, importance);

              // Use GPU daemon if available for fast semantic indexing
              const daemonAvailable = await bridge.isEmbeddingsDaemonAvailable();
              if (daemonAvailable) {
                await bridge.storeMemoryFast(content, { category, importance });
              } else {
                await bridge.addMemory(content, {
                  source: "auto-capture",
                  category,
                  importance,
                });
              }
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
