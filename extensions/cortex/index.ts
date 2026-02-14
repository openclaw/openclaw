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
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
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

/**
 * Category configuration loaded from categories.json
 * Fully dynamic - no hardcoded categories
 */
interface CategoryConfig {
  description: string;
  keywords: string[];
}

interface CategoriesFile {
  categories: Record<string, CategoryConfig>;
  extensible: boolean;
  note?: string;
}

/**
 * Dynamic category manager - loads from JSON, supports runtime additions
 */
class CategoryManager {
  private categories: Map<string, CategoryConfig> = new Map();
  private patterns: Map<string, RegExp> = new Map();
  private configPath: string;
  private loaded = false;

  constructor(configPath: string) {
    this.configPath = configPath;
  }

  async load(): Promise<void> {
    try {
      if (!existsSync(this.configPath)) {
        // Create default categories file if it doesn't exist
        const defaultCategories: CategoriesFile = {
          categories: {
            general: {
              description: "General uncategorized memories",
              keywords: [],
            },
          },
          extensible: true,
          note: "Categories are loaded dynamically. Add new categories here or via cortex_create_category tool.",
        };
        await writeFile(this.configPath, JSON.stringify(defaultCategories, null, 2));
      }

      const content = await readFile(this.configPath, "utf-8");
      const data: CategoriesFile = JSON.parse(content);

      this.categories.clear();
      this.patterns.clear();

      for (const [name, config] of Object.entries(data.categories)) {
        this.categories.set(name, config);
        if (config.keywords.length > 0) {
          // Build regex from keywords
          const pattern = new RegExp(config.keywords.join("|"), "i");
          this.patterns.set(name, pattern);
        }
      }

      this.loaded = true;
    } catch (err) {
      console.error("Failed to load categories:", err);
      // Fallback to minimal default
      this.categories.set("general", { description: "General", keywords: [] });
      this.loaded = true;
    }
  }

  async addCategory(name: string, description: string, keywords: string[]): Promise<{ success: boolean; message: string; existing?: boolean }> {
    if (!this.loaded) {
      await this.load();
    }

    // Normalize name to lowercase
    const normalizedName = name.toLowerCase().replace(/\s+/g, "_");

    // Check for existing category (deduplication)
    if (this.categories.has(normalizedName)) {
      const existing = this.categories.get(normalizedName)!;
      return {
        success: false,
        message: `Category "${normalizedName}" already exists: ${existing.description}. Keywords: ${existing.keywords.join(", ")}`,
        existing: true,
      };
    }

    // Check if any keywords overlap with existing categories
    const lowerKeywords = new Set(keywords.map(k => k.toLowerCase()));
    for (const [catName, config] of this.categories) {
      const overlap = config.keywords.filter(k => lowerKeywords.has(k.toLowerCase()));
      if (overlap.length > 0) {
        return {
          success: false,
          message: `Keywords [${overlap.join(", ")}] already used in category "${catName}". Use that category or choose different keywords.`,
          existing: true,
        };
      }
    }

    // Add to in-memory store
    this.categories.set(normalizedName, { description, keywords });
    if (keywords.length > 0) {
      this.patterns.set(normalizedName, new RegExp(keywords.join("|"), "i"));
    }

    // Persist to file
    try {
      const content = await readFile(this.configPath, "utf-8");
      const data: CategoriesFile = JSON.parse(content);
      data.categories[normalizedName] = { description, keywords };
      await writeFile(this.configPath, JSON.stringify(data, null, 2));
      return {
        success: true,
        message: `Created category "${normalizedName}" with keywords: ${keywords.join(", ")}`,
      };
    } catch (err) {
      console.error("Failed to save category:", err);
      return {
        success: false,
        message: `Failed to persist category: ${err}`,
      };
    }
  }

  /**
   * Detect single category (backward compat)
   */
  detectCategory(content: string): string {
    const cats = this.detectCategories(content);
    return cats[0];
  }

  /**
   * Detect multiple categories from content
   * PHASE 2B: Multi-category support
   */
  detectCategories(content: string): string[] {
    if (!this.loaded) {
      return ["general"];
    }

    const lowerContent = content.toLowerCase();
    const matched: string[] = [];

    for (const [category, pattern] of this.patterns) {
      if (pattern.test(lowerContent)) {
        matched.push(category);
      }
    }

    // Return matched categories or default to general
    return matched.length > 0 ? matched : ["general"];
  }

  getCategories(): string[] {
    return Array.from(this.categories.keys());
  }

  getCategoryInfo(name: string): CategoryConfig | undefined {
    return this.categories.get(name);
  }

  hasCategory(name: string): boolean {
    return this.categories.has(name);
  }
}

// Global category manager instance - initialized on plugin load
let categoryManager: CategoryManager | null = null;

function detectCategory(content: string): string {
  if (!categoryManager) {
    return "general";
  }
  return categoryManager.detectCategory(content);
}

/**
 * Detect multiple categories from content
 * PHASE 2B: Multi-category support
 */
function detectCategories(content: string): string[] {
  if (!categoryManager) {
    return ["general"];
  }
  return categoryManager.detectCategories(content);
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
 * PHASE 2B: Multi-category support
 */
function matchSTMItems(items: STMItem[], query: string, temporalWeight = 0.4, importanceWeight = 0.3): Array<STMItem & { matchScore: number }> {
  const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (queryTerms.length === 0) {
    return [];
  }

  // Detect query categories for boosting (multi-category support)
  const queryCategories = detectCategories(query);

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

    // Category match bonus (PHASE 2B: multi-category support)
    // Bonus scales with number of matching categories
    const itemCategories = item.categories ?? (item.category ? [item.category] : ["general"]);
    const matchingCats = queryCategories.filter(qc => itemCategories.includes(qc));
    const categoryBonus = matchingCats.length > 0 ? 0.1 + (matchingCats.length * 0.1) : 0;

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

/**
 * PHASE 2 IMPROVEMENT #5: Format time delta as human-readable string
 * e.g., "2m ago", "3h ago", "yesterday", "3d ago"
 */
function formatTimeDelta(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) {
    return "just now";
  }
  if (diffMins < 60) {
    return `${diffMins}m ago`;
  }
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  if (diffDays === 1) {
    return "yesterday";
  }
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }
  return `${Math.floor(diffDays / 7)}w ago`;
}

/**
 * PHASE 2 IMPROVEMENT #2: Deduplicate memories by content hash
 * Returns deduplicated array, keeping first occurrence
 */
function deduplicateByContent<T extends { content: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    // Use first 100 chars as hash key (fast approximation)
    const key = item.content.slice(0, 100).toLowerCase().trim();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * PHASE 2 IMPROVEMENT #3: Calculate dynamic token budget based on conversation complexity
 * Base: 1500, +500 for technical/coding, +500 for multi-topic, max: 2500
 */
function calculateDynamicTokenBudget(prompt: string, baseTokens: number): number {
  let budget = baseTokens;
  const lowerPrompt = prompt.toLowerCase();

  // +500 for technical/coding content
  const technicalPatterns = /code|function|error|bug|api|database|query|implement|debug|fix|class|method/i;
  if (technicalPatterns.test(lowerPrompt)) {
    budget += 500;
  }

  // +500 for complex multi-topic conversations (detected by question marks, multiple sentences)
  const sentences = prompt.split(/[.!?]+/).filter(s => s.trim().length > 10);
  if (sentences.length >= 3 || prompt.includes("?")) {
    budget += 300;
  }

  // Cap at 2500
  return Math.min(budget, 2500);
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
      // PHASE 2: Token Budget System (tuned based on Helios feedback)
      maxContextTokens: rawConfig.maxContextTokens ?? 1500,  // Base budget, dynamic scaling adds more
      relevanceThreshold: rawConfig.relevanceThreshold ?? 0.5,  // Relaxed from 0.65
      truncateOldMemoriesTo: rawConfig.truncateOldMemoriesTo ?? 180,  // Up from 120 to keep sentences coherent
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

    // Dedupe cache for auto-capture (prevents capturing same content multiple times)
    // Key: content hash, Value: timestamp when captured
    const recentlyCaptures = new Map<string, number>();
    const DEDUPE_WINDOW_MS = 60 * 60 * 1000; // 1 hour window
    const contentHash = (s: string) => s.slice(0, 100).toLowerCase().replace(/\s+/g, " ").trim();

    // PHASE 2B: Initialize category manager (loads from categories.json)
    const categoriesPath = join(homedir(), ".openclaw", "workspace", "memory", "categories.json");
    categoryManager = new CategoryManager(categoriesPath);

    // PHASE 1 & 2: Warm up caches on startup
    void (async () => {
      const available = await bridge.isAvailable();
      if (!available) {
        api.logger.warn("Cortex Python scripts not found in ~/.openclaw/workspace/memory/");
        return;
      }

      // PHASE 2B: Load categories from JSON
      if (categoryManager) {
        await categoryManager.load();
      }
      const categoryCount = categoryManager?.getCategories().length ?? 0;

      // Warm up all RAM caches (PHASE 2: also starts delta sync)
      const warmupResult = await bridge.warmupCaches();
      const indexStats = bridge.memoryIndex.getStats();
      api.logger.info(
        `Cortex Phase 2 initialized: ${warmupResult.stm} STM, ${warmupResult.memories} memories, ` +
        `${indexStats.hotCount} hot tier, token budget: ${config.maxContextTokens}, ${categoryCount} categories`
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
    // Tool: cortex_create_category - Dynamic category creation
    // =========================================================================
    api.registerTool(
      {
        name: "cortex_create_category",
        description:
          "Create a new memory category for organizing knowledge. Use when encountering a new topic domain that doesn't fit existing categories. Categories help with memory retrieval and context injection. Will reject if category or keywords already exist.",
        parameters: Type.Object({
          name: Type.String({ description: "Category name (lowercase, underscores for spaces)" }),
          description: Type.String({ description: "What this category covers" }),
          keywords: Type.Array(Type.String(), {
            description: "Keywords that trigger this category (used for auto-detection)",
            minItems: 1,
          }),
        }),
        async execute(_toolCallId, params) {
          const p = params as { name: string; description: string; keywords: string[] };

          if (!categoryManager) {
            return {
              content: [{ type: "text", text: "Category manager not initialized" }],
              details: { error: "not_initialized" },
            };
          }

          const result = await categoryManager.addCategory(p.name, p.description, p.keywords);

          if (result.existing) {
            return {
              content: [{ type: "text", text: result.message }],
              details: { exists: true, suggestion: "Use the existing category instead" },
            };
          }

          if (!result.success) {
            return {
              content: [{ type: "text", text: result.message }],
              details: { error: result.message },
            };
          }

          return {
            content: [{ type: "text", text: result.message }],
            details: { created: true, categories: categoryManager.getCategories() },
          };
        },
      },
      { names: ["cortex_create_category"] },
    );

    // =========================================================================
    // Tool: cortex_list_categories - View available categories
    // =========================================================================
    api.registerTool(
      {
        name: "cortex_list_categories",
        description:
          "List all available memory categories with their descriptions and keywords. Use to understand what categories exist before adding memories or creating new categories.",
        parameters: Type.Object({}),
        async execute() {
          if (!categoryManager) {
            return {
              content: [{ type: "text", text: "Category manager not initialized" }],
              details: { error: "not_initialized" },
            };
          }

          const categories = categoryManager.getCategories();
          const details: Record<string, CategoryConfig> = {};
          const lines: string[] = ["**Available Categories:**", ""];

          for (const name of categories) {
            const info = categoryManager.getCategoryInfo(name);
            if (info) {
              details[name] = info;
              lines.push(`- **${name}**: ${info.description}`);
              if (info.keywords.length > 0) {
                lines.push(`  Keywords: ${info.keywords.join(", ")}`);
              }
            }
          }

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { categories: details, count: categories.length },
          };
        },
      },
      { names: ["cortex_list_categories"] },
    );

    // =========================================================================
    // Tool: cortex_add - Explicit memory storage with importance
    // PHASE 2B: Multi-category support
    // =========================================================================
    api.registerTool(
      {
        name: "cortex_add",
        description:
          "Store an important memory in Cortex STM. Use for significant insights, decisions, lessons learned, or preferences. Auto-detects categories from content keywords. Use cortex_list_categories to see available categories. Importance: 1.0=routine, 2.0=notable, 3.0=critical. Supports multiple categories.",
        parameters: Type.Object({
          content: Type.String({ description: "Memory content to store" }),
          category: Type.Optional(
            Type.String({
              description: "Single category (deprecated, use categories array instead)",
            }),
          ),
          categories: Type.Optional(
            Type.Array(Type.String(), {
              description: "Array of categories for this memory (e.g., ['technical', 'preferences'])",
            }),
          ),
          importance: Type.Optional(
            Type.Number({ description: "Importance 1.0-3.0 (default: auto-detect from content)" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const p = params as { content: string; category?: string; categories?: string[]; importance?: number };

          try {
            const available = await bridge.isAvailable();
            if (!available) {
              return {
                content: [{ type: "text", text: "Cortex memory system not available" }],
                details: { error: "unavailable" },
              };
            }

            // PHASE 2B: Multi-category support - prefer categories array, fall back to single category, then auto-detect
            const categories = p.categories ?? (p.category ? [p.category] : detectCategories(p.content));
            const importance = p.importance ?? detectImportance(p.content);

            // Add to STM (fast path for recent recall)
            await bridge.addToSTM(p.content, categories, importance);

            // Also add to embeddings for semantic search
            const memId = await bridge.addMemory(p.content, {
              source: "agent",
              categories,
              importance,
            });

            return {
              content: [
                {
                  type: "text",
                  text: `Memory stored in Cortex: [${categories.join(", ")}] importance=${importance.toFixed(1)}`,
                },
              ],
              details: { id: memId, categories, importance },
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
    // PHASE 2B: Multi-category support
    // =========================================================================
    api.registerTool(
      {
        name: "cortex_stm",
        description:
          "View recent items from Cortex short-term memory (STM). Shows the last N significant events with O(1) access. Use to quickly recall recent context without full search. Supports filtering by multiple categories.",
        parameters: Type.Object({
          limit: Type.Optional(Type.Number({ description: "Max items to show (default: 10)" })),
          category: Type.Optional(Type.String({ description: "Filter by category (single)" })),
          categories: Type.Optional(Type.Array(Type.String(), { description: "Filter by multiple categories" })),
        }),
        async execute(_toolCallId, params) {
          const p = params as { limit?: number; category?: string; categories?: string[] };

          try {
            const available = await bridge.isAvailable();
            if (!available) {
              return {
                content: [{ type: "text", text: "Cortex memory system not available" }],
                details: { error: "unavailable" },
              };
            }

            // PHASE 2B: Support both single category and categories array
            const filterCats = p.categories ?? (p.category ? [p.category] : undefined);
            const items = await bridge.getRecentSTM(p.limit ?? 10, filterCats);

            return {
              content: [
                {
                  type: "text",
                  text: items.length > 0
                    ? items
                        .map((i) => {
                          const age = calculateRecencyScore(i.timestamp);
                          const ageLabel = age > 0.9 ? "now" : age > 0.5 ? "recent" : "older";
                          // PHASE 2B: Display all categories
                          const cats = i.categories ?? (i.category ? [i.category] : ["general"]);
                          return `[${cats.join(", ")}] (imp=${i.importance.toFixed(1)}, ${ageLabel}) ${i.content.slice(0, 150)}`;
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
    // Tool: cortex_dedupe - Deduplication (Priority 2)
    // =========================================================================
    api.registerTool(
      {
        name: "cortex_dedupe",
        description:
          "Find and handle duplicate memories in Cortex. Use 'report' to list duplicates, 'merge' to combine them (keeps newest, sums access counts), or 'delete_older' to remove older duplicates.",
        parameters: Type.Object({
          category: Type.Optional(Type.String({ description: "Limit deduplication to this category" })),
          categories: Type.Optional(Type.Array(Type.String(), { description: "Limit to multiple categories" })),
          similarity_threshold: Type.Optional(
            Type.Number({ description: "Content similarity threshold 0-1 (default: 0.95 = nearly identical)" }),
          ),
          action: Type.Union([
            Type.Literal("report"),
            Type.Literal("merge"),
            Type.Literal("delete_older"),
          ], { description: "Action: 'report', 'merge', or 'delete_older'" }),
        }),
        async execute(_toolCallId, params) {
          const p = params as {
            category?: string;
            categories?: string[];
            similarity_threshold?: number;
            action: "report" | "merge" | "delete_older";
          };

          try {
            const available = await bridge.isAvailable();
            if (!available) {
              return {
                content: [{ type: "text", text: "Cortex memory system not available" }],
                details: { error: "unavailable" },
              };
            }

            const _threshold = p.similarity_threshold ?? 0.95; // Reserved for future semantic dedup
            const filterCats = p.categories ?? (p.category ? [p.category] : undefined);

            // Get all STM items
            const stmItems = await bridge.getRecentSTM(config.stmCapacity);

            // Filter by category if specified
            const items = filterCats
              ? stmItems.filter(item => {
                  const itemCats = item.categories ?? (item.category ? [item.category] : ["general"]);
                  return filterCats.some(fc => itemCats.includes(fc));
                })
              : stmItems;

            // Find duplicates using content hash (first 100 chars lowercase)
            const groups = new Map<string, Array<STMItem & { index: number }>>();
            for (let i = 0; i < items.length; i++) {
              const key = items[i].content.slice(0, 100).toLowerCase().trim();
              if (!groups.has(key)) {
                groups.set(key, []);
              }
              groups.get(key)!.push({ ...items[i], index: i });
            }

            // Filter to only groups with duplicates
            const duplicateGroups = Array.from(groups.values()).filter(g => g.length > 1);

            if (duplicateGroups.length === 0) {
              return {
                content: [{ type: "text", text: "No duplicates found." }],
                details: { duplicates: 0 },
              };
            }

            if (p.action === "report") {
              const report = duplicateGroups.map((group, i) => {
                const cats = group[0].categories ?? (group[0].category ? [group[0].category] : ["general"]);
                return `Group ${i + 1} (${group.length} items, [${cats.join(",")}]):\n` +
                  group.map(item => `  - [${formatTimeDelta(item.timestamp)}] ${item.content.slice(0, 60)}...`).join("\n");
              }).join("\n\n");

              return {
                content: [{ type: "text", text: `Found ${duplicateGroups.length} duplicate groups:\n\n${report}` }],
                details: { groups: duplicateGroups.length, total_duplicates: duplicateGroups.reduce((s, g) => s + g.length - 1, 0) },
              };
            }

            if (p.action === "merge" || p.action === "delete_older") {
              // Collect IDs to delete from brain.db directly
              const idsToDelete: string[] = [];

              for (const group of duplicateGroups) {
                // Sort by timestamp (newest first)
                group.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
                const keeper = group[0];
                const toRemove = group.slice(1);

                if (p.action === "merge") {
                  // Update keeper with merged metadata
                  const totalAccess = group.reduce((sum, item) => sum + (item.access_count || 0), 0);
                  const maxImportance = Math.max(...group.map(item => item.importance || 1));
                  if (keeper.id) {
                    // Update keeper in brain.db
                    // Update keeper importance via cortex_update mechanism
                    await bridge.updateSTM(keeper.id, maxImportance);
                  }
                }

                // Collect IDs to remove
                for (const item of toRemove) {
                  if (item.id) {
                    idsToDelete.push(item.id);
                  }
                }
              }

              // Batch delete from brain.db
              const removed = await bridge.deleteSTMBatch(idsToDelete);

              return {
                content: [{ type: "text", text: `${p.action === "merge" ? "Merged" : "Deleted"} ${removed} duplicate memories from ${duplicateGroups.length} groups.` }],
                details: { action: p.action, removed, groups: duplicateGroups.length },
              };
            }

            // Exhaustive check - should never reach here
            const _exhaustiveCheck: never = p.action;
            return {
              content: [{ type: "text", text: `Unknown action: ${String(_exhaustiveCheck)}` }],
              details: { error: "unknown action" },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Cortex dedupe error: ${err}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { names: ["cortex_dedupe"] },
    );

    // =========================================================================
    // Tool: cortex_update - Importance adjustment (Priority 3)
    // =========================================================================
    api.registerTool(
      {
        name: "cortex_update",
        description:
          "Update a memory's importance score or categories. Use to promote important memories or reclassify them.",
        parameters: Type.Object({
          memory_id: Type.String({ description: "Memory ID (from cortex_stm or search results)" }),
          importance: Type.Optional(Type.Number({ description: "New importance score 1.0-3.0" })),
          categories: Type.Optional(Type.Array(Type.String(), { description: "New categories array" })),
        }),
        async execute(_toolCallId, params) {
          const p = params as { memory_id: string; importance?: number; categories?: string[] };

          try {
            const available = await bridge.isAvailable();
            if (!available) {
              return {
                content: [{ type: "text", text: "Cortex memory system not available" }],
                details: { error: "unavailable" },
              };
            }

            if (!p.importance && !p.categories) {
              return {
                content: [{ type: "text", text: "Must provide importance or categories to update" }],
                details: { error: "no_changes" },
              };
            }

            // Load and update STM
            const stmData = await bridge.loadSTMDirect();
            const stmItems = stmData.short_term_memory;
            let found = false;
            let updatedItem: STMItem | null = null;

            for (const item of stmItems) {
              // Match by content hash since STM doesn't have IDs
              const itemId = `stm-${item.content.slice(0, 20)}-${item.timestamp}`;
              if (p.memory_id === itemId || p.memory_id === item.timestamp || item.content.includes(p.memory_id)) {
                if (p.importance !== undefined) {
                  item.importance = p.importance;
                }
                if (p.categories) {
                  item.categories = p.categories;
                  item.category = p.categories[0];
                }
                found = true;
                updatedItem = item;
                break;
              }
            }

            if (found && updatedItem) {
              const stmPath = join(homedir(), ".openclaw", "workspace", "memory", "stm.json");
              await writeFile(stmPath, JSON.stringify(stmData, null, 2));

              const cats = updatedItem.categories ?? (updatedItem.category ? [updatedItem.category] : ["general"]);
              return {
                content: [{
                  type: "text",
                  text: `Updated memory: importance=${updatedItem.importance.toFixed(1)}, categories=[${cats.join(", ")}]`,
                }],
                details: { updated: true, importance: updatedItem.importance, categories: cats },
              };
            }

            return {
              content: [{ type: "text", text: `Memory not found: ${p.memory_id}` }],
              details: { error: "not_found" },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Cortex update error: ${err}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { names: ["cortex_update"] },
    );

    // =========================================================================
    // Tool: cortex_edit - Memory edit/append (Priority 4)
    // =========================================================================
    api.registerTool(
      {
        name: "cortex_edit",
        description:
          "Edit or append to an existing memory. Use 'append' to add to existing content, or 'replace' to overwrite entirely. Content changes trigger re-embedding.",
        parameters: Type.Object({
          memory_id: Type.String({ description: "Memory ID or content snippet to match" }),
          append: Type.Optional(Type.String({ description: "Content to append to existing memory" })),
          replace: Type.Optional(Type.String({ description: "New content to replace existing memory" })),
        }),
        async execute(_toolCallId, params) {
          const p = params as { memory_id: string; append?: string; replace?: string };

          try {
            const available = await bridge.isAvailable();
            if (!available) {
              return {
                content: [{ type: "text", text: "Cortex memory system not available" }],
                details: { error: "unavailable" },
              };
            }

            if (!p.append && !p.replace) {
              return {
                content: [{ type: "text", text: "Must provide append or replace content" }],
                details: { error: "no_changes" },
              };
            }

            // Load and update STM
            const stmData = await bridge.loadSTMDirect();
            const stmItems = stmData.short_term_memory;
            let found = false;
            let updatedItem: STMItem | null = null;

            for (const item of stmItems) {
              // Match by content snippet or timestamp
              if (p.memory_id === item.timestamp || item.content.includes(p.memory_id)) {
                const oldContent = item.content;

                if (p.replace) {
                  item.content = p.replace;
                } else if (p.append) {
                  item.content = `${item.content}\n\n[Updated ${new Date().toISOString()}]: ${p.append}`;
                }

                // Update timestamp to reflect modification
                item.timestamp = new Date().toISOString();

                found = true;
                updatedItem = item;

                // If content changed significantly, re-embed
                if (oldContent !== item.content) {
                  const daemonAvailable = await bridge.isEmbeddingsDaemonAvailable();
                  if (daemonAvailable) {
                    const cats = item.categories ?? (item.category ? [item.category] : ["general"]);
                    await bridge.storeMemoryFast(item.content, {
                      categories: cats,
                      importance: item.importance,
                    });
                  }
                }
                break;
              }
            }

            if (found && updatedItem) {
              const stmPath = join(homedir(), ".openclaw", "workspace", "memory", "stm.json");
              await writeFile(stmPath, JSON.stringify(stmData, null, 2));

              return {
                content: [{
                  type: "text",
                  text: `Memory ${p.replace ? "replaced" : "appended"}: ${updatedItem.content.slice(0, 100)}...`,
                }],
                details: { action: p.replace ? "replace" : "append", content_length: updatedItem.content.length },
              };
            }

            return {
              content: [{ type: "text", text: `Memory not found: ${p.memory_id}` }],
              details: { error: "not_found" },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Cortex edit error: ${err}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { names: ["cortex_edit"] },
    );

    // =========================================================================
    // Tool: cortex_move - Move between categories (Priority 5)
    // =========================================================================
    api.registerTool(
      {
        name: "cortex_move",
        description:
          "Move a memory to different categories. Replaces existing categories with new ones. No re-embedding needed.",
        parameters: Type.Object({
          memory_id: Type.String({ description: "Memory ID or content snippet to match" }),
          to_categories: Type.Array(Type.String(), { description: "New categories to assign" }),
        }),
        async execute(_toolCallId, params) {
          const p = params as { memory_id: string; to_categories: string[] };

          try {
            const available = await bridge.isAvailable();
            if (!available) {
              return {
                content: [{ type: "text", text: "Cortex memory system not available" }],
                details: { error: "unavailable" },
              };
            }

            if (!p.to_categories || p.to_categories.length === 0) {
              return {
                content: [{ type: "text", text: "Must provide at least one category" }],
                details: { error: "no_categories" },
              };
            }

            // Load and update STM
            const stmData = await bridge.loadSTMDirect();
            const stmItems = stmData.short_term_memory;
            let found = false;
            let oldCategories: string[] = [];

            for (const item of stmItems) {
              // Match by content snippet or timestamp
              if (p.memory_id === item.timestamp || item.content.includes(p.memory_id)) {
                oldCategories = item.categories ?? (item.category ? [item.category] : ["general"]);
                item.categories = p.to_categories;
                item.category = p.to_categories[0];
                found = true;
                break;
              }
            }

            if (found) {
              const stmPath = join(homedir(), ".openclaw", "workspace", "memory", "stm.json");
              await writeFile(stmPath, JSON.stringify(stmData, null, 2));

              return {
                content: [{
                  type: "text",
                  text: `Moved memory from [${oldCategories.join(", ")}] to [${p.to_categories.join(", ")}]`,
                }],
                details: { from_categories: oldCategories, to_categories: p.to_categories },
              };
            }

            return {
              content: [{ type: "text", text: `Memory not found: ${p.memory_id}` }],
              details: { error: "not_found" },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Cortex move error: ${err}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { names: ["cortex_move"] },
    );

    // =========================================================================
    // PHASE 3: ATOMIC KNOWLEDGE TOOLS
    // =========================================================================

    // =========================================================================
    // Tool: atom_create - Create atomic knowledge unit
    // =========================================================================
    api.registerTool(
      {
        name: "atom_create",
        description:
          "PHASE 3: Create an atomic knowledge unit - the irreducible unit of causal understanding. " +
          "Structure: {subject} {action} {outcome} {consequences}. " +
          "Example: 'whale wallet' 'accumulates token X' 'concentration pattern visible' 'precedes price movement by 4h'",
        parameters: Type.Object({
          subject: Type.String({ description: "WHO or WHAT acts (e.g., 'whale wallet', 'market maker', 'Peter')" }),
          action: Type.String({ description: "WHAT they do (e.g., 'accumulates token X', 'places large order')" }),
          outcome: Type.String({ description: "WHAT results (e.g., 'pattern becomes visible', 'price moves 2%')" }),
          consequences: Type.String({ description: "WHAT follows (e.g., 'precedes price movement by 4h', 'triggers retail FOMO')" }),
          confidence: Type.Optional(Type.Number({ description: "Confidence in this knowledge 0-1 (default: 1.0)" })),
          source: Type.Optional(Type.String({ description: "Source of this knowledge (default: 'agent')" })),
        }),
        async execute(_toolCallId, params) {
          const p = params as {
            subject: string;
            action: string;
            outcome: string;
            consequences: string;
            confidence?: number;
            source?: string;
          };

          try {
            const available = await bridge.isAvailable();
            if (!available) {
              return {
                content: [{ type: "text", text: "Cortex memory system not available" }],
                details: { error: "unavailable" },
              };
            }

            const atomId = await bridge.createAtom(
              p.subject,
              p.action,
              p.outcome,
              p.consequences,
              {
                source: p.source ?? "agent",
                confidence: p.confidence ?? 1.0,
              }
            );

            return {
              content: [{
                type: "text",
                text: `Created atom ${atomId}:\n` +
                      `  Subject: ${p.subject}\n` +
                      `  Action: ${p.action}\n` +
                      `  Outcome: ${p.outcome}\n` +
                      `  Consequences: ${p.consequences}`,
              }],
              details: { id: atomId, subject: p.subject, action: p.action },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Atom creation error: ${err}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { names: ["atom_create"] },
    );

    // =========================================================================
    // Tool: atom_search - Search atoms by field similarity
    // =========================================================================
    api.registerTool(
      {
        name: "atom_search",
        description:
          "PHASE 3: Search atomic knowledge by a specific field (subject, action, outcome, consequences). " +
          "This enables powerful queries like 'find all entities that cause price movement' or 'what actions lead to FOMO'.",
        parameters: Type.Object({
          field: Type.String({
            description: "Field to search: 'subject' (who), 'action' (what they do), 'outcome' (what results), 'consequences' (what follows)",
          }),
          query: Type.String({ description: "Search query for semantic similarity" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
          threshold: Type.Optional(Type.Number({ description: "Minimum similarity 0-1 (default: 0.5)" })),
        }),
        async execute(_toolCallId, params) {
          const p = params as {
            field: string;
            query: string;
            limit?: number;
            threshold?: number;
          };

          try {
            const available = await bridge.isAvailable();
            if (!available) {
              return {
                content: [{ type: "text", text: "Cortex memory system not available" }],
                details: { error: "unavailable" },
              };
            }

            if (!["subject", "action", "outcome", "consequences"].includes(p.field)) {
              return {
                content: [{ type: "text", text: "Invalid field. Must be: subject, action, outcome, or consequences" }],
                details: { error: "invalid_field" },
              };
            }

            const results = await bridge.searchAtomsByField(
              p.field as "subject" | "action" | "outcome" | "consequences",
              p.query,
              { limit: p.limit ?? 10, threshold: p.threshold ?? 0.5 }
            );

            // Defensive: ensure results is an array
            const safeResults = Array.isArray(results) ? results : [];

            if (safeResults.length === 0) {
              return {
                content: [{ type: "text", text: `No atoms found matching "${p.query}" in ${p.field} field` }],
                details: { count: 0 },
              };
            }

            const formatted = safeResults.map((a, i) =>
              `${i + 1}. [${((a.similarity ?? 0) * 100).toFixed(0)}%] {${a.subject ?? "?"}} {${a.action ?? "?"}} → {${a.outcome ?? "?"}} → {${(a.consequences ?? "").slice(0, 50)}...}`
            ).join("\n");

            return {
              content: [{
                type: "text",
                text: `Found ${results.length} atoms matching "${p.query}" in ${p.field}:\n${formatted}`,
              }],
              details: { count: results.length, results },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Atom search error: ${err}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { names: ["atom_search"] },
    );

    // =========================================================================
    // Tool: atom_find_causes - Find root causes (causal traversal)
    // =========================================================================
    api.registerTool(
      {
        name: "atom_find_causes",
        description:
          "PHASE 3: Traverse backward through causal chains to find root causes. " +
          "This is the 'keep going until the answer is no' capability - finds the novel indicators that others miss.",
        parameters: Type.Object({
          atom_id: Type.Optional(Type.String({ description: "Start from this atom ID" })),
          outcome: Type.Optional(Type.String({ description: "Find causes of this outcome (searches first, then traverses)" })),
          max_depth: Type.Optional(Type.Number({ description: "Max depth to traverse (default: 10)" })),
        }),
        async execute(_toolCallId, params) {
          const p = params as {
            atom_id?: string;
            outcome?: string;
            max_depth?: number;
          };

          try {
            const available = await bridge.isAvailable();
            if (!available) {
              return {
                content: [{ type: "text", text: "Cortex memory system not available" }],
                details: { error: "unavailable" },
              };
            }

            if (!p.atom_id && !p.outcome) {
              return {
                content: [{ type: "text", text: "Must provide atom_id or outcome to find causes for" }],
                details: { error: "missing_input" },
              };
            }

            let roots;
            if (p.outcome) {
              // Find all causal paths to this outcome
              roots = await bridge.findPathsToOutcome(p.outcome, p.max_depth ?? 10);
            } else if (p.atom_id) {
              // Find root causes of specific atom
              roots = await bridge.findRootCauses(p.atom_id, p.max_depth ?? 10);
            } else {
              roots = [];
            }

            if (roots.length === 0) {
              return {
                content: [{
                  type: "text",
                  text: p.outcome
                    ? `No causal chains found for outcome "${p.outcome}". This may be a root cause itself.`
                    : `No antecedent causes found. This atom appears to be at an epistemic limit.`,
                }],
                details: { count: 0, epistemic_limit: true },
              };
            }

            const formatted = roots.map((a, i) =>
              `${i + 1}. [depth=${a.depth ?? "?"}] {${a.subject}} {${a.action}}\n` +
              `    → {${a.outcome}}\n` +
              `    → {${a.consequences.slice(0, 80)}...}`
            ).join("\n\n");

            return {
              content: [{
                type: "text",
                text: `Found ${roots.length} root cause(s):\n\n${formatted}\n\n` +
                      `These are the deepest causal factors found - the "novel indicators" others miss.`,
              }],
              details: { count: roots.length, roots },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Causal traversal error: ${err}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { names: ["atom_find_causes", "find_causes"] },
    );

    // =========================================================================
    // Tool: atom_link - Create causal links between atoms
    // =========================================================================
    api.registerTool(
      {
        name: "atom_link",
        description:
          "PHASE 3: Create or strengthen a causal link between two atoms. " +
          "Types: 'causes' (A directly causes B), 'enables' (A makes B possible), " +
          "'precedes' (A happens before B), 'correlates' (A and B occur together).",
        parameters: Type.Object({
          from_atom_id: Type.String({ description: "Source atom ID" }),
          to_atom_id: Type.String({ description: "Target atom ID" }),
          link_type: Type.Optional(Type.String({ description: "causes, enables, precedes, or correlates (default: causes)" })),
          strength: Type.Optional(Type.Number({ description: "Confidence in link 0-1 (default: 0.5)" })),
        }),
        async execute(_toolCallId, params) {
          const p = params as {
            from_atom_id: string;
            to_atom_id: string;
            link_type?: string;
            strength?: number;
          };

          try {
            const available = await bridge.isAvailable();
            if (!available) {
              return {
                content: [{ type: "text", text: "Cortex memory system not available" }],
                details: { error: "unavailable" },
              };
            }

            const linkType = (p.link_type ?? "causes") as "causes" | "enables" | "precedes" | "correlates";
            if (!["causes", "enables", "precedes", "correlates"].includes(linkType)) {
              return {
                content: [{ type: "text", text: "Invalid link_type. Must be: causes, enables, precedes, or correlates" }],
                details: { error: "invalid_type" },
              };
            }

            const linkId = await bridge.createCausalLink(
              p.from_atom_id,
              p.to_atom_id,
              linkType,
              p.strength ?? 0.5
            );

            return {
              content: [{
                type: "text",
                text: `Created causal link: ${p.from_atom_id} --[${linkType}]--> ${p.to_atom_id}`,
              }],
              details: { link_id: linkId, type: linkType },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Link creation error: ${err}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { names: ["atom_link"] },
    );

    // =========================================================================
    // Tool: atom_stats - Atomic knowledge statistics
    // =========================================================================
    api.registerTool(
      {
        name: "atom_stats",
        description: "PHASE 3: Get statistics about the atomic knowledge database - total atoms, causal links, embeddings status.",
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

            const stats = await bridge.getAtomStats();

            // Defensive: handle null/undefined stats
            const safeStats = stats ?? {
              total_atoms: 0,
              total_causal_links: 0,
              by_source: {},
              links_by_type: {},
              avg_confidence: 0,
              atoms_with_embeddings: 0,
              embeddings_available: false,
            };

            return {
              content: [{
                type: "text",
                text: `Atomic Knowledge Stats (PHASE 3):

⚛️  Atoms: ${safeStats.total_atoms ?? 0}
🔗 Causal Links: ${safeStats.total_causal_links ?? 0}
📊 By source: ${Object.entries(safeStats.by_source ?? {}).map(([k, v]) => `${k}(${v})`).join(", ") || "none"}
🔧 Links by type: ${Object.entries(safeStats.links_by_type ?? {}).map(([k, v]) => `${k}(${v})`).join(", ") || "none"}
📈 Avg confidence: ${(safeStats.avg_confidence ?? 0).toFixed(2)}
🧮 With embeddings: ${safeStats.atoms_with_embeddings ?? 0}
🖥️  GPU embeddings: ${safeStats.embeddings_available ? "ENABLED" : "DISABLED"}`,
              }],
              details: safeStats,
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Atom stats error: ${err}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { names: ["atom_stats"] },
    );

    // =========================================================================
    // Tool: atomize - Extract atoms from text
    // =========================================================================
    api.registerTool(
      {
        name: "atomize",
        description:
          "PHASE 3B: Extract atomic knowledge units from text using local pattern matching. " +
          "Finds causal structures and converts them to atoms. Also supports batch atomization of existing memories.",
        parameters: Type.Object({
          text: Type.Optional(Type.String({ description: "Text to extract atoms from" })),
          batch_stm: Type.Optional(Type.Boolean({ description: "Batch atomize all STM memories" })),
          batch_embeddings: Type.Optional(Type.Boolean({ description: "Batch atomize all embeddings memories" })),
          source: Type.Optional(Type.String({ description: "Source label (default: 'agent')" })),
        }),
        async execute(_toolCallId, params) {
          const p = params as {
            text?: string;
            batch_stm?: boolean;
            batch_embeddings?: boolean;
            source?: string;
          };

          try {
            const available = await bridge.isAvailable();
            if (!available) {
              return {
                content: [{ type: "text", text: "Cortex memory system not available" }],
                details: { error: "unavailable" },
              };
            }

            // Batch atomization mode
            if (p.batch_stm || p.batch_embeddings) {
              let stmResult = { processed: 0, atomsCreated: 0 };
              let embResult = { processed: 0, atomsCreated: 0 };

              if (p.batch_stm) {
                const res = await bridge.batchAtomizeSTM();
                stmResult = res ?? { processed: 0, atomsCreated: 0 };
              }
              if (p.batch_embeddings) {
                const res = await bridge.batchAtomizeEmbeddings();
                embResult = res ?? { processed: 0, atomsCreated: 0 };
              }

              const total = (stmResult.atomsCreated ?? 0) + (embResult.atomsCreated ?? 0);
              return {
                content: [{
                  type: "text",
                  text: `Batch atomization complete:\n` +
                        (p.batch_stm ? `  STM: ${stmResult.processed} processed → ${stmResult.atomsCreated} atoms\n` : "") +
                        (p.batch_embeddings ? `  Embeddings: ${embResult.processed} processed → ${embResult.atomsCreated} atoms\n` : "") +
                        `  Total atoms created: ${total}`,
                }],
                details: { stm: stmResult, embeddings: embResult },
              };
            }

            // Single text atomization
            if (!p.text) {
              return {
                content: [{ type: "text", text: "Must provide text or batch flag" }],
                details: { error: "missing_input" },
              };
            }

            const atomIds = await bridge.atomizeText(p.text, {
              source: p.source ?? "agent",
              saveToDb: true,
            });

            // Defensive: ensure atomIds is an array
            const safeAtomIds = Array.isArray(atomIds) ? atomIds : [];

            if (safeAtomIds.length === 0) {
              return {
                content: [{
                  type: "text",
                  text: "No atoms extracted - text doesn't contain recognizable causal patterns.\n" +
                        "Try text with patterns like: 'When X happens, Y results' or 'A causes B'",
                }],
                details: { count: 0 },
              };
            }

            return {
              content: [{
                type: "text",
                text: `Extracted ${safeAtomIds.length} atom(s) from text:\n` +
                      safeAtomIds.map((id, i) => `  ${i + 1}. ${id ?? "unknown"}`).join("\n"),
              }],
              details: { count: safeAtomIds.length, ids: safeAtomIds },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Atomization error: ${err}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { names: ["atomize"] },
    );

    // =========================================================================
    // PHASE 3E: DEEP ABSTRACTION TOOLS
    // =========================================================================

    // =========================================================================
    // Tool: abstract_deeper - Run deep causal analysis
    // =========================================================================
    api.registerTool(
      {
        name: "abstract_deeper",
        description:
          "PHASE 3E: Run deep causal analysis on a query. Automatically traverses atom chains " +
          "to find root causes and novel indicators. The 'keep going until no' capability.",
        parameters: Type.Object({
          query: Type.String({ description: "The question or topic to analyze causally" }),
          max_depth: Type.Optional(Type.Number({ description: "Max causal chain depth (default: 5)" })),
        }),
        async execute(_toolCallId, params) {
          const p = params as { query: string; max_depth?: number };

          try {
            const available = await bridge.isAvailable();
            if (!available) {
              return {
                content: [{ type: "text", text: "Cortex memory system not available" }],
                details: { error: "unavailable" },
              };
            }

            const result = await bridge.abstractDeeper(p.query, { maxDepth: p.max_depth ?? 5 });

            // Defensive: handle null/undefined result
            const safeResult = result ?? {
              query: p.query,
              targets: [],
              novel_indicators: [],
              epistemic_limits: ["No result returned"],
              depth_reached: 0,
              atoms_traversed: 0,
            };

            const targets = Array.isArray(safeResult.targets) ? safeResult.targets : [];
            const novelIndicators = Array.isArray(safeResult.novel_indicators) ? safeResult.novel_indicators : [];
            const epistemicLimits = Array.isArray(safeResult.epistemic_limits) ? safeResult.epistemic_limits : [];

            if (novelIndicators.length === 0) {
              return {
                content: [{
                  type: "text",
                  text: `Deep abstraction for: "${p.query}"\n\n` +
                        `Targets identified: ${targets.join(", ") || "none"}\n` +
                        `Atoms traversed: ${safeResult.atoms_traversed ?? 0}\n` +
                        `Depth reached: ${safeResult.depth_reached ?? 0}\n\n` +
                        `No novel indicators found at chain roots.\n` +
                        `Epistemic limits: ${epistemicLimits.join("; ") || "unknown"}`,
                }],
                details: safeResult,
              };
            }

            const indicators = novelIndicators.slice(0, 5).map((ind, i) => {
              const a = ind?.atom ?? {};
              return `${i + 1}. [${ind?.frequency ?? 0}x] {${a.subject ?? "?"}} {${a.action ?? "?"}}\n` +
                     `   → {${a.outcome ?? "?"}}\n` +
                     `   (${ind?.insight ?? "unknown"})`;
            }).join("\n\n");

            return {
              content: [{
                type: "text",
                text: `🧠 Deep Abstraction: "${p.query}"\n\n` +
                      `📊 Analysis:\n` +
                      `   Targets: ${targets.join(", ") || "none"}\n` +
                      `   Depth: ${safeResult.depth_reached ?? 0} levels\n` +
                      `   Atoms: ${safeResult.atoms_traversed ?? 0} traversed\n\n` +
                      `🔍 Novel Indicators (root causes others miss):\n\n${indicators}` +
                      (epistemicLimits.length > 0
                        ? `\n\n⚠️ Limits: ${epistemicLimits.join("; ")}`
                        : ""),
              }],
              details: safeResult,
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Deep abstraction error: ${err}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { names: ["abstract_deeper", "deep_abstract"] },
    );

    // =========================================================================
    // Tool: classify_query - Check if query needs deep analysis
    // =========================================================================
    api.registerTool(
      {
        name: "classify_query",
        description:
          "PHASE 3E: Classify a query as 'causal' (needs deep abstraction) or 'recall' (simple retrieval). " +
          "Useful for understanding how Helios will process different questions.",
        parameters: Type.Object({
          query: Type.String({ description: "The query to classify" }),
        }),
        async execute(_toolCallId, params) {
          const p = params as { query: string };

          try {
            const available = await bridge.isAvailable();
            if (!available) {
              return {
                content: [{ type: "text", text: "Cortex memory system not available" }],
                details: { error: "unavailable" },
              };
            }

            const result = await bridge.classifyQuery(p.query);

            // Defensive: handle null/undefined result
            const queryType = result?.queryType ?? "recall";
            const confidence = typeof result?.confidence === "number" ? result.confidence : 0.5;
            const emoji = queryType === "causal" ? "🧠" : "📚";

            return {
              content: [{
                type: "text",
                text: `${emoji} Query classification:\n` +
                      `   Type: ${queryType}\n` +
                      `   Confidence: ${(confidence * 100).toFixed(0)}%\n\n` +
                      (queryType === "causal"
                        ? "This query would trigger deep abstraction (causal chain traversal)."
                        : "This query would use simple memory recall."),
              }],
              details: { queryType, confidence },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Classification error: ${err}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { names: ["classify_query"] },
    );

    // =========================================================================
    // PHASE 3F: TEMPORAL ANALYSIS TOOLS
    // =========================================================================

    // =========================================================================
    // Tool: temporal_search - Search with time context
    // =========================================================================
    api.registerTool(
      {
        name: "temporal_search",
        description:
          "PHASE 3F: Search atoms with temporal context. Supports natural language time references " +
          "like '4 hours ago', 'yesterday', 'last week'.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          time_reference: Type.String({ description: "Time reference: '4 hours ago', 'yesterday', 'last week', etc." }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 20)" })),
        }),
        async execute(_toolCallId, params) {
          const p = params as { query: string; time_reference: string; limit?: number };

          try {
            const available = await bridge.isAvailable();
            if (!available) {
              return {
                content: [{ type: "text", text: "Cortex memory system not available" }],
                details: { error: "unavailable" },
              };
            }

            const result = await bridge.searchTemporal(p.query, p.time_reference, p.limit ?? 20);

            if (result.atoms.length === 0) {
              return {
                content: [{
                  type: "text",
                  text: `No atoms found for "${p.query}" in ${p.time_reference}`,
                }],
                details: result,
              };
            }

            const atoms = result.atoms.slice(0, 10).map((a, i) =>
              `${i + 1}. {${a.subject}} {${a.action}}\n   → {${a.outcome}}`
            ).join("\n\n");

            return {
              content: [{
                type: "text",
                text: `🕐 Temporal Search: "${p.query}" in ${p.time_reference}\n\n` +
                      (result.time_range
                        ? `Time range: ${result.time_range.start} to ${result.time_range.end}\n\n`
                        : "") +
                      `Found ${result.atoms.length} atom(s):\n\n${atoms}`,
              }],
              details: result,
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Temporal search error: ${err}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { names: ["temporal_search"] },
    );

    // =========================================================================
    // Tool: what_happened_before - Find precursors to an event
    // =========================================================================
    api.registerTool(
      {
        name: "what_happened_before",
        description:
          "PHASE 3F: Find what happened before a given event. " +
          "Example: 'What happened 4 hours before the price spike?'",
        parameters: Type.Object({
          event: Type.String({ description: "Description of the event" }),
          hours_before: Type.Optional(Type.Number({ description: "Hours to look back (default: 4)" })),
        }),
        async execute(_toolCallId, params) {
          const p = params as { event: string; hours_before?: number };

          try {
            const available = await bridge.isAvailable();
            if (!available) {
              return {
                content: [{ type: "text", text: "Cortex memory system not available" }],
                details: { error: "unavailable" },
              };
            }

            const result = await bridge.whatHappenedBefore(p.event, p.hours_before ?? 4);

            if (result.error) {
              return {
                content: [{ type: "text", text: `Could not analyze: ${result.error}` }],
                details: result,
              };
            }

            const precursors = result.precursor_atoms.slice(0, 10).map((a, i) =>
              `${i + 1}. {${a.subject}} {${a.action}}\n` +
              `   ${a.time_before_event ? `(${a.time_before_event} before)` : ""}`
            ).join("\n\n");

            const causal = result.causal_candidates.map((c, i) =>
              `${i + 1}. {${c.atom.subject}} {${c.atom.action}}\n   Reason: ${c.reason}`
            ).join("\n\n");

            return {
              content: [{
                type: "text",
                text: `⏪ What happened before: "${p.event}"\n` +
                      `Lookback: ${result.lookback_hours} hours\n\n` +
                      `Precursor atoms (${result.precursor_atoms.length}):\n${precursors || "None found"}\n\n` +
                      `🎯 Likely causal (${result.causal_candidates.length}):\n${causal || "None identified"}`,
              }],
              details: result,
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Precursor analysis error: ${err}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { names: ["what_happened_before", "before_event"] },
    );

    // =========================================================================
    // Tool: temporal_patterns - Analyze timing patterns
    // =========================================================================
    api.registerTool(
      {
        name: "temporal_patterns",
        description:
          "PHASE 3F: Analyze temporal patterns for an outcome. " +
          "Example: 'whale accumulation typically precedes price movement by 4-12 hours'.",
        parameters: Type.Object({
          outcome: Type.String({ description: "The outcome to analyze patterns for" }),
          min_observations: Type.Optional(Type.Number({ description: "Minimum observations needed (default: 3)" })),
        }),
        async execute(_toolCallId, params) {
          const p = params as { outcome: string; min_observations?: number };

          try {
            const available = await bridge.isAvailable();
            if (!available) {
              return {
                content: [{ type: "text", text: "Cortex memory system not available" }],
                details: { error: "unavailable" },
              };
            }

            const result = await bridge.analyzeTemporalPatterns(p.outcome, p.min_observations ?? 3);

            if (result.error) {
              return {
                content: [{ type: "text", text: `Pattern analysis: ${result.error}` }],
                details: result,
              };
            }

            const precursors = result.common_precursors.map(p =>
              `  - ${p.subject} (${p.count}x)`
            ).join("\n");

            return {
              content: [{
                type: "text",
                text: `📊 Temporal Patterns: "${p.outcome}"\n\n` +
                      `Observations: ${result.observations}\n` +
                      (result.avg_outcome_delay
                        ? `Avg outcome delay: ${result.avg_outcome_delay.human}\n`
                        : "") +
                      (result.avg_consequence_delay
                        ? `Avg consequence delay: ${result.avg_consequence_delay.human}\n`
                        : "") +
                      (result.time_patterns?.peak_hour !== undefined
                        ? `Peak hour: ${result.time_patterns.peak_hour}:00\n`
                        : "") +
                      `\nCommon precursors:\n${precursors || "  None identified"}`,
              }],
              details: result,
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Pattern analysis error: ${err}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { names: ["temporal_patterns"] },
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
    // SYNAPSE — Inter-agent messaging (Helios <-> Claude Code)
    // =========================================================================
    const synapsePath = join(homedir(), ".openclaw", "workspace", "memory", "synapse.json");
    const MAX_SYNAPSE_MESSAGES = 200;

    interface SynapseMessage {
      id: string;
      from: string;
      to: string;
      priority: "info" | "action" | "urgent";
      subject: string;
      body: string;
      status: "unread" | "read" | "acknowledged";
      timestamp: string;
      read_by: string[];
      thread_id: string;
      ack_body: string | null;
    }

    interface SynapseStore {
      messages: SynapseMessage[];
      agents: string[];
      version: number;
    }

    function generateSynapseId(): string {
      return `syn_${randomBytes(6).toString("hex")}`;
    }

    function generateThreadId(): string {
      return `thr_${randomBytes(6).toString("hex")}`;
    }

    function loadSynapse(): SynapseStore {
      try {
        const data = JSON.parse(require("node:fs").readFileSync(synapsePath, "utf-8")) as SynapseStore;
        return data;
      } catch {
        return { messages: [], agents: ["helios", "claude-code"], version: 1 };
      }
    }

    function saveSynapse(data: SynapseStore): void {
      const tmpPath = synapsePath + ".tmp";
      writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      renameSync(tmpPath, synapsePath);
    }

    function pruneSynapseMessages(data: SynapseStore): void {
      if (data.messages.length <= MAX_SYNAPSE_MESSAGES) {
        return;
      }

      const unread = data.messages.filter((m) => m.status === "unread");
      const read = data.messages.filter((m) => m.status === "read");
      const acked = data.messages.filter((m) => m.status === "acknowledged");

      // Sort oldest first for pruning
      read.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      acked.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      let excess = data.messages.length - MAX_SYNAPSE_MESSAGES;

      // Prune acknowledged first, then read. Never prune unread.
      while (excess > 0 && acked.length > 0) {
        acked.shift();
        excess--;
      }
      while (excess > 0 && read.length > 0) {
        read.shift();
        excess--;
      }

      data.messages = [...unread, ...read, ...acked].sort((a, b) =>
        a.timestamp.localeCompare(b.timestamp),
      );
    }

    // Tool: synapse - 1 action-discriminated tool with 5 actions
    api.registerTool(
      {
        name: "synapse",
        description:
          "SYNAPSE — inter-agent messaging between Helios and Claude Code. " +
          "Structured messages with addressing, read/unread tracking, priority, " +
          "and threading. Actions: send, inbox, read, ack, history",
        parameters: Type.Object({
          action: Type.String({ description: "Action: 'send', 'inbox', 'read', 'ack', 'history'" }),
          to: Type.Optional(Type.String({ description: "Recipient agent ID (for send). e.g. 'claude-code', 'all'" })),
          subject: Type.Optional(Type.String({ description: "Message subject (for send)" })),
          body: Type.Optional(Type.String({ description: "Message body (for send, ack)" })),
          priority: Type.Optional(Type.String({ description: "Priority: 'info', 'action', 'urgent' (for send). Default: info" })),
          thread_id: Type.Optional(Type.String({ description: "Thread ID to continue a conversation (for send, history)" })),
          message_id: Type.Optional(Type.String({ description: "Message ID (for read, ack)" })),
          agent_id: Type.Optional(Type.String({ description: "Agent ID for filtering (for inbox, history)" })),
          include_read: Type.Optional(Type.Boolean({ description: "Include read messages in inbox. Default: false" })),
          limit: Type.Optional(Type.Number({ description: "Max messages to return (for history). Default: 20" })),
        }),
        async execute(_toolCallId, params) {
          const p = params as {
            action: string;
            to?: string;
            subject?: string;
            body?: string;
            priority?: string;
            thread_id?: string;
            message_id?: string;
            agent_id?: string;
            include_read?: boolean;
            limit?: number;
          };

          try {
            switch (p.action) {
              case "send": {
                if (!p.to || !p.subject || !p.body) {
                  return { content: [{ type: "text", text: "Error: to, subject, and body are required for send" }], details: { error: "missing params" } };
                }
                const priority = (["info", "action", "urgent"].includes(p.priority || "") ? p.priority : "info") as SynapseMessage["priority"];
                const msg: SynapseMessage = {
                  id: generateSynapseId(),
                  from: "helios",
                  to: p.to,
                  priority,
                  subject: p.subject,
                  body: p.body,
                  status: "unread",
                  timestamp: new Date().toISOString(),
                  read_by: [],
                  thread_id: p.thread_id || generateThreadId(),
                  ack_body: null,
                };
                const data = loadSynapse();
                data.messages.push(msg);
                pruneSynapseMessages(data);
                saveSynapse(data);
                return {
                  content: [{ type: "text", text: `Sent SYNAPSE message ${msg.id} to ${msg.to} [${msg.priority}]: ${msg.subject}` }],
                  details: { id: msg.id, thread_id: msg.thread_id, to: msg.to, priority: msg.priority },
                };
              }
              case "inbox": {
                const agentId = p.agent_id || "helios";
                const includeRead = p.include_read || false;
                const data = loadSynapse();
                let results = data.messages.filter((m) => m.to === agentId || m.to === "all");
                if (includeRead) {
                  results = results.filter((m) => m.status !== "acknowledged");
                } else {
                  results = results.filter((m) => !m.read_by.includes(agentId));
                }
                results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
                return {
                  content: [{ type: "text", text: JSON.stringify({ agent_id: agentId, count: results.length, messages: results }, null, 2) }],
                  details: { count: results.length },
                };
              }
              case "read": {
                if (!p.message_id) {
                  return { content: [{ type: "text", text: "Error: message_id is required for read" }], details: { error: "missing message_id" } };
                }
                const readerAgent = p.agent_id || "helios";
                const data = loadSynapse();
                const msg = data.messages.find((m) => m.id === p.message_id);
                if (!msg) {
                  return { content: [{ type: "text", text: `Error: Message not found: ${p.message_id}` }], details: { error: "not_found" } };
                }
                if (!msg.read_by.includes(readerAgent)) {
                  msg.read_by.push(readerAgent);
                }
                if (msg.status === "unread") {
                  msg.status = "read";
                }
                saveSynapse(data);
                return {
                  content: [{ type: "text", text: JSON.stringify(msg, null, 2) }],
                  details: { id: msg.id, status: msg.status },
                };
              }
              case "ack": {
                if (!p.message_id) {
                  return { content: [{ type: "text", text: "Error: message_id is required for ack" }], details: { error: "missing message_id" } };
                }
                const ackerAgent = p.agent_id || "helios";
                const data = loadSynapse();
                const msg = data.messages.find((m) => m.id === p.message_id);
                if (!msg) {
                  return { content: [{ type: "text", text: `Error: Message not found: ${p.message_id}` }], details: { error: "not_found" } };
                }
                msg.status = "acknowledged";
                if (!msg.read_by.includes(ackerAgent)) {
                  msg.read_by.push(ackerAgent);
                }
                if (p.body) {
                  msg.ack_body = p.body;
                }
                saveSynapse(data);
                return {
                  content: [{ type: "text", text: `Acknowledged ${msg.id}: ${msg.subject}` }],
                  details: { id: msg.id, status: "acknowledged", ack_body: msg.ack_body },
                };
              }
              case "history": {
                const data = loadSynapse();
                let results = data.messages;
                if (p.agent_id) {
                  results = results.filter((m) => m.from === p.agent_id || m.to === p.agent_id || m.to === "all");
                }
                if (p.thread_id) {
                  results = results.filter((m) => m.thread_id === p.thread_id);
                }
                results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
                const limit = p.limit || 20;
                results = results.slice(0, limit);
                return {
                  content: [{ type: "text", text: JSON.stringify({ count: results.length, messages: results }, null, 2) }],
                  details: { count: results.length },
                };
              }
              default:
                return { content: [{ type: "text", text: `Unknown synapse action: ${p.action}` }], details: { error: "unknown action" } };
            }
          } catch (err) {
            return { content: [{ type: "text", text: `Synapse error: ${err}` }], details: { error: String(err) } };
          }
        },
      },
      { names: ["synapse"] },
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

        // PHASE 2 IMPROVEMENT #3: Dynamic token budget based on complexity
        const tokenBudget = calculateDynamicTokenBudget(event.prompt, config.maxContextTokens);

        // Track injected memory IDs for dedup and access counting
        const injectedContentKeys = new Set<string>();

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
        const hotMemories = bridge.getHotMemoriesTier(20); // Get more for filtering
        if (hotMemories.length > 0) {
          // Filter to relevant ones
          const queryTerms = queryText.toLowerCase().split(/\s+/).filter(t => t.length > 2);
          let relevantHot = hotMemories.filter(m => {
            const content = m.content.toLowerCase();
            return queryTerms.some(term => content.includes(term));
          });

          // PHASE 2 IMPROVEMENT #2: Deduplicate
          relevantHot = deduplicateByContent(relevantHot).slice(0, 3);

          if (relevantHot.length > 0) {
            const hotContext = relevantHot.map((m) => {
              // PHASE 2 IMPROVEMENT #4: Record access on injection
              bridge.memoryIndex.hotTier.recordAccess(m.id);
              const accessCount = bridge.memoryIndex.hotTier.getAccessCount(m.id);

              // PHASE 2 IMPROVEMENT #5: Use time delta instead of generic label
              const timeDelta = formatTimeDelta(m.timestamp);

              // Track for dedup across tiers
              injectedContentKeys.add(m.content.slice(0, 100).toLowerCase().trim());

              // PHASE 2B: Multi-category display
              const cats = m.categories ?? (m.category ? [m.category] : ["hot"]);
              return `- [${cats.join(",")}/${timeDelta}/access=${Math.round(accessCount)}] ${m.content.slice(0, config.truncateOldMemoriesTo)}`;
            }).join("\n");
            const hotTokens = estimateTokens(hotContext);

            if (usedTokens + hotTokens <= tokenBudget) {
              contextParts.push(`<hot-memory hint="frequently accessed knowledge">\n${hotContext}\n</hot-memory>`);
              usedTokens += hotTokens;

              // Record co-occurrence for these memories
              if (relevantHot.length > 1) {
                bridge.memoryIndex.recordCoOccurrence(relevantHot.map(m => m.id));
              }
            }
          }
        }

        // L3.5. STM fast path (keyword matching for very recent items)
        const stmItems = await bridge.getRecentSTM(Math.min(config.stmCapacity, 100));
        let stmMatches = stmItems.length > 0
          ? matchSTMItems(stmItems, queryText, config.temporalWeight, config.importanceWeight)
              .filter(m => m.matchScore >= config.minMatchScore)
          : [];

        // PHASE 2 IMPROVEMENT #2: Deduplicate and filter already-injected
        stmMatches = deduplicateByContent(stmMatches)
          .filter(m => !injectedContentKeys.has(m.content.slice(0, 100).toLowerCase().trim()))
          .slice(0, 3);

        if (stmMatches.length > 0) {
          const stmContext = stmMatches.map((m) => {
            // PHASE 2 IMPROVEMENT #5: Use time delta
            const timeDelta = formatTimeDelta(m.timestamp);

            // Track for dedup
            injectedContentKeys.add(m.content.slice(0, 100).toLowerCase().trim());

            // PHASE 2B: Multi-category display
            const cats = m.categories ?? (m.category ? [m.category] : ["general"]);
            return `- [${cats.join(",")}/${timeDelta}] ${m.content.slice(0, config.truncateOldMemoriesTo)}`;
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

            // PHASE 2 IMPROVEMENT #2: Use shared dedup set
            const uniqueResults = budgetedResults.filter(
              r => !injectedContentKeys.has(r.content.slice(0, 100).toLowerCase().trim())
            );

            if (uniqueResults.length > 0) {
              const semanticContext = uniqueResults.map((r) => {
                // Track for dedup
                injectedContentKeys.add(r.content.slice(0, 100).toLowerCase().trim());
                // PHASE 2B: Multi-category display
                const cats = r.categories ?? (r.category ? [r.category] : ["general"]);
                return `- [${cats.join(",")}/${r.tokens}tok] ${r.finalContent}`;
              }).join("\n");
              contextParts.push(`<semantic-memory hint="related knowledge (token-budgeted)">\n${semanticContext}\n</semantic-memory>`);
              usedTokens += uniqueResults.reduce((sum, r) => sum + r.tokens, 0);
            }
          }
        }

        // PHASE 2 IMPROVEMENT #6: Category diversity - ensure breadth
        // PHASE 2B: Multi-category support
        // Check if we're missing any active categories and add one memory from each
        const injectedCategories = new Set<string>();
        // Collect categories from what we've already injected (handle multi-category)
        for (const match of stmMatches) {
          const matchCats = match.categories ?? (match.category ? [match.category] : ["general"]);
          for (const cat of matchCats) {
            injectedCategories.add(cat);
          }
        }

        const diversityBudget = tokenBudget - usedTokens;
        if (diversityBudget > 50) {
          const allCategories = bridge.memoryIndex.categories;
          const missingCategories = allCategories.filter(cat =>
            !injectedCategories.has(cat) && cat !== "general"
          );

          if (missingCategories.length > 0) {
            const diverseMemories: string[] = [];
            for (const cat of missingCategories.slice(0, 2)) { // Max 2 diversity additions
              const catMemories = bridge.memoryIndex.getByCategory(cat);
              if (catMemories.length > 0) {
                // Get most recent from this category that hasn't been injected
                const fresh = catMemories
                  .filter(m => !injectedContentKeys.has(m.content.slice(0, 100).toLowerCase().trim()))
                  .toSorted((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

                if (fresh) {
                  const timeDelta = formatTimeDelta(fresh.timestamp);
                  diverseMemories.push(`- [${cat}/${timeDelta}] ${fresh.content.slice(0, config.truncateOldMemoriesTo)}`);
                  injectedContentKeys.add(fresh.content.slice(0, 100).toLowerCase().trim());
                  bridge.memoryIndex.hotTier.recordAccess(fresh.id);
                }
              }
            }

            if (diverseMemories.length > 0) {
              const diverseTokens = estimateTokens(diverseMemories.join("\n"));
              if (usedTokens + diverseTokens <= tokenBudget) {
                contextParts.push(`<diverse-context hint="breadth from other categories">\n${diverseMemories.join("\n")}\n</diverse-context>`);
                usedTokens += diverseTokens;
              }
            }
          }
        }

        // L5. PHASE 3E: Deep Abstraction Layer - automatic causal analysis for causal queries
        const abstractionBudget = tokenBudget - usedTokens;
        if (abstractionBudget > 200) { // Need enough tokens for abstraction insights
          try {
            // Process query with deep abstraction (classifies and optionally runs abstraction)
            const abstractionResult = await bridge.processWithAbstraction(queryText, {
              autoAbstract: true,
              maxDepth: 5,
            });

            // Only inject if we got novel indicators
            if (abstractionResult.abstraction_performed && abstractionResult.context_injection) {
              const abstractionTokens = estimateTokens(abstractionResult.context_injection);
              if (usedTokens + abstractionTokens <= tokenBudget) {
                contextParts.push(`<deep-abstraction hint="PHASE 3E: causal insights from atomic knowledge">\n${abstractionResult.context_injection}\n</deep-abstraction>`);
                usedTokens += abstractionTokens;
                api.logger.debug?.(`Cortex: deep abstraction injected (${abstractionResult.abstraction_result?.novel_indicators?.length ?? 0} novel indicators)`);
              }
            }
          } catch (abstractionErr) {
            // Don't fail the whole context injection if abstraction fails
            api.logger.debug?.(`Cortex: deep abstraction skipped: ${abstractionErr}`);
          }
        }

        if (contextParts.length === 0) {
          return;
        }

        api.logger.debug?.(`Cortex: injected ${contextParts.length} tiers, ~${usedTokens}/${tokenBudget} tokens (dynamic budget)`);

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

              // Dedupe check: skip if recently captured
              const hash = contentHash(content);
              const lastCaptured = recentlyCaptures.get(hash);
              if (lastCaptured && Date.now() - lastCaptured < DEDUPE_WINDOW_MS) {
                api.logger.debug?.(`Cortex auto-capture skipped (dedupe): "${text.slice(0, 40)}..."`);
                continue;
              }

              // Mark as captured
              recentlyCaptures.set(hash, Date.now());

              // Clean up old entries (keep cache small)
              if (recentlyCaptures.size > 1000) {
                const cutoff = Date.now() - DEDUPE_WINDOW_MS;
                for (const [k, v] of recentlyCaptures) {
                  if (v < cutoff) { recentlyCaptures.delete(k); }
                }
              }

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
