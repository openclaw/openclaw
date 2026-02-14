/**
 * Cortex Bridge - TypeScript wrapper for Python Cortex memory system
 *
 * PHASE 1 MEMORY EXPANSION:
 * - Full memory index loaded into RAM (microsecond retrieval)
 * - 50,000 item STM capacity
 * - Active Session layer (last 50 messages always in context)
 * - Write-through caching (RAM + SQLite)
 *
 * With 66GB available RAM, we can cache everything and eliminate disk I/O latency.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile, access, constants } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface CortexMemory {
  id: string;
  content: string;
  source: string;
  categories: string[];  // Multi-category support (Phase 3)
  category?: string | null;  // Deprecated: kept for backward compat, use categories
  timestamp: string;
  importance: number;
  access_count: number;
  score?: number;
  recency_score?: number;
  semantic_score?: number;
  embedding?: number[]; // Cached embedding vector
}

/**
 * Normalize category input to array format.
 * Handles: string, string[], null, undefined
 */
export function normalizeCategories(input: string | string[] | null | undefined): string[] {
  if (!input) {
    return ["general"];
  }
  if (Array.isArray(input)) {
    return input.length > 0 ? input : ["general"];
  }
  return [input];
}

/**
 * Check if item categories match any of the query categories.
 * Used for filtering memories by category.
 */
export function categoriesMatch(itemCats: string[], queryCats: string | string[] | null | undefined): boolean {
  if (!queryCats) {
    return true;  // No filter means match all
  }
  const queryArray = normalizeCategories(queryCats);
  return itemCats.some(cat => queryArray.includes(cat));
}

export interface CortexSearchOptions {
  limit?: number;
  temporalWeight?: number;
  dateRange?: string | [string, string];
  category?: string;
}

/**
 * PHASE 2: Token budget configuration
 */
export interface TokenBudgetConfig {
  maxContextTokens: number;      // Max tokens for memory context (default: 2000)
  relevanceThreshold: number;    // Skip memories below this score (default: 0.5)
  truncateOldMemoriesTo: number; // Truncate old memories to N chars (default: 200)
}

/**
 * PHASE 2: Simple token estimation
 * Rough approximation: 1 token ≈ 4 chars for English text
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface STMItem {
  content: string;
  timestamp: string;
  categories: string[];  // Multi-category support (Phase 3)
  category?: string;  // Deprecated: kept for backward compat, use categories
  importance: number;
  access_count: number;
}

export interface ActiveSessionMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  messageId?: string;
}

/**
 * L2 - Active Session Cache
 * Last N messages always in RAM, never expires during session
 */
export class ActiveSessionCache {
  private messages: ActiveSessionMessage[] = [];
  private readonly maxMessages: number;

  constructor(maxMessages = 50) {
    this.maxMessages = maxMessages;
  }

  add(message: ActiveSessionMessage): void {
    this.messages.push({
      ...message,
      timestamp: message.timestamp || new Date().toISOString(),
    });
    // Keep only last N messages
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }
  }

  getRecent(count?: number): ActiveSessionMessage[] {
    const n = count ?? this.maxMessages;
    return this.messages.slice(-n);
  }

  getAll(): ActiveSessionMessage[] {
    return [...this.messages];
  }

  search(query: string): ActiveSessionMessage[] {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    if (terms.length === 0) {
      return [];
    }
    return this.messages.filter(msg => {
      const content = msg.content.toLowerCase();
      return terms.some(term => content.includes(term));
    });
  }

  clear(): void {
    this.messages = [];
  }

  get count(): number {
    return this.messages.length;
  }

  get sizeBytes(): number {
    return this.messages.reduce((sum, m) => sum + m.content.length * 2, 0);
  }
}

/**
 * PHASE 2: Hot Memory Tier
 * Top N most-accessed memories with instant retrieval
 * Implements access count decay to prevent stale hot memories
 */
export class HotMemoryTier {
  private hotIds: Set<string> = new Set();
  private accessCounts: Map<string, number> = new Map();
  private lastAccess: Map<string, number> = new Map();
  private readonly maxSize: number;
  private readonly decayIntervalMs = 3600000; // 1 hour
  private readonly decayFactor = 0.9; // Multiply access counts by this every decay interval

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
  }

  /**
   * Record an access and potentially promote to hot tier
   */
  recordAccess(id: string): void {
    const now = Date.now();
    const prevCount = this.accessCounts.get(id) ?? 0;
    const lastTime = this.lastAccess.get(id) ?? now;

    // Apply decay if enough time has passed
    const hoursSinceAccess = (now - lastTime) / this.decayIntervalMs;
    const decayedCount = prevCount * Math.pow(this.decayFactor, hoursSinceAccess);

    const newCount = decayedCount + 1;
    this.accessCounts.set(id, newCount);
    this.lastAccess.set(id, now);

    // Check if this should be promoted to hot tier
    this.maybePromote(id, newCount);
  }

  /**
   * Promote to hot tier if access count is high enough
   */
  private maybePromote(id: string, count: number): void {
    if (this.hotIds.has(id)) {
      return; // Already hot
    }

    if (this.hotIds.size < this.maxSize) {
      this.hotIds.add(id);
      return;
    }

    // Find the coldest hot item and compare
    let coldestId: string | null = null;
    let coldestCount = Infinity;
    for (const hotId of this.hotIds) {
      const hotCount = this.accessCounts.get(hotId) ?? 0;
      if (hotCount < coldestCount) {
        coldestCount = hotCount;
        coldestId = hotId;
      }
    }

    if (coldestId && count > coldestCount) {
      this.hotIds.delete(coldestId);
      this.hotIds.add(id);
    }
  }

  /**
   * Check if memory is in hot tier
   */
  isHot(id: string): boolean {
    return this.hotIds.has(id);
  }

  /**
   * Get all hot memory IDs
   */
  getHotIds(): string[] {
    return Array.from(this.hotIds);
  }

  /**
   * Get access count for a memory
   */
  getAccessCount(id: string): number {
    return this.accessCounts.get(id) ?? 0;
  }

  /**
   * Apply global decay to all access counts (run periodically)
   */
  applyDecay(): void {
    const now = Date.now();
    for (const [id, count] of this.accessCounts.entries()) {
      const lastTime = this.lastAccess.get(id) ?? now;
      const hoursSinceAccess = (now - lastTime) / this.decayIntervalMs;
      if (hoursSinceAccess > 0) {
        const decayedCount = count * Math.pow(this.decayFactor, hoursSinceAccess);
        this.accessCounts.set(id, decayedCount);
        this.lastAccess.set(id, now);
      }
    }

    // Rebuild hot tier after decay
    this.rebuildHotTier();
  }

  /**
   * Rebuild hot tier from access counts
   */
  private rebuildHotTier(): void {
    const sorted = Array.from(this.accessCounts.entries())
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, this.maxSize);

    this.hotIds.clear();
    for (const [id] of sorted) {
      this.hotIds.add(id);
    }
  }

  get size(): number {
    return this.hotIds.size;
  }

  getStats(): { size: number; topAccessCounts: Array<{ id: string; count: number }> } {
    const top = Array.from(this.accessCounts.entries())
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, count]) => ({ id, count }));
    return { size: this.hotIds.size, topAccessCounts: top };
  }
}

/**
 * L3/L4 - Full Memory Index Cache
 * All memories loaded into RAM for microsecond retrieval
 * PHASE 2: Integrated Hot Memory Tier
 */
export class MemoryIndexCache {
  private memories: Map<string, CortexMemory> = new Map();
  private byCategory: Map<string, Set<string>> = new Map();
  private accessRanking: Map<string, number> = new Map(); // id -> composite score
  private initialized = false;
  private lastRefresh: number = 0;

  // PHASE 2: Hot memory tier integration
  public readonly hotTier: HotMemoryTier;

  // PHASE 2: Co-occurrence tracking for predictive prefetch
  private coOccurrences: Map<string, Map<string, number>> = new Map(); // id -> (other_id -> count)

  constructor(hotTierSize = 100) {
    this.hotTier = new HotMemoryTier(hotTierSize);
  }

  async loadFromDaemon(embeddingsUrl: string): Promise<number> {
    try {
      // Fetch all memories from the embeddings daemon
      const response = await fetch(`${embeddingsUrl}/dump`, {
        method: "GET",
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        // Daemon doesn't support /dump, fall back to stats only
        return 0;
      }

      const data = await response.json() as { memories: CortexMemory[] };
      this.loadMemories(data.memories);
      return data.memories.length;
    } catch {
      return 0;
    }
  }

  loadMemories(memories: CortexMemory[]): void {
    this.memories.clear();
    this.byCategory.clear();
    this.accessRanking.clear();

    for (const memory of memories) {
      // Normalize categories (handle old single-category format)
      const normalizedMemory = {
        ...memory,
        categories: normalizeCategories(memory.categories ?? memory.category),
      };
      this.memories.set(memory.id, normalizedMemory);

      // Index by all categories (multi-category support)
      for (const category of normalizedMemory.categories) {
        if (!this.byCategory.has(category)) {
          this.byCategory.set(category, new Set());
        }
        this.byCategory.get(category)!.add(memory.id);
      }

      // Calculate access ranking (recency × access_count × importance)
      const recency = this.calculateRecency(memory.timestamp);
      const score = recency * (memory.access_count + 1) * memory.importance;
      this.accessRanking.set(memory.id, score);
    }

    this.initialized = true;
    this.lastRefresh = Date.now();
  }

  private calculateRecency(timestamp: string): number {
    const now = Date.now();
    const then = new Date(timestamp).getTime();
    const ageHours = (now - then) / (1000 * 60 * 60);
    // Exponential decay with ~7 day half-life for long-term memories
    return Math.exp(-ageHours / 168);
  }

  add(memory: CortexMemory): void {
    // Normalize categories (handle old single-category format)
    const normalizedMemory = {
      ...memory,
      categories: normalizeCategories(memory.categories ?? memory.category),
    };
    this.memories.set(memory.id, normalizedMemory);

    // Index by all categories (multi-category support)
    for (const category of normalizedMemory.categories) {
      if (!this.byCategory.has(category)) {
        this.byCategory.set(category, new Set());
      }
      this.byCategory.get(category)!.add(memory.id);
    }

    const recency = this.calculateRecency(memory.timestamp);
    const score = recency * (memory.access_count + 1) * memory.importance;
    this.accessRanking.set(memory.id, score);
  }

  get(id: string): CortexMemory | undefined {
    const memory = this.memories.get(id);
    if (memory) {
      // Increment access count in cache
      memory.access_count = (memory.access_count || 0) + 1;
      // Update ranking
      const recency = this.calculateRecency(memory.timestamp);
      const score = recency * memory.access_count * memory.importance;
      this.accessRanking.set(id, score);
      // PHASE 2: Record access in hot tier
      this.hotTier.recordAccess(id);
    }
    return memory;
  }

  /**
   * PHASE 2: Record co-occurrence of memories accessed together
   * Call this when multiple memories are returned in the same query
   */
  recordCoOccurrence(ids: string[]): void {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const id1 = ids[i];
        const id2 = ids[j];

        // Record id1 -> id2
        if (!this.coOccurrences.has(id1)) {
          this.coOccurrences.set(id1, new Map());
        }
        const count1 = this.coOccurrences.get(id1)!.get(id2) ?? 0;
        this.coOccurrences.get(id1)!.set(id2, count1 + 1);

        // Record id2 -> id1
        if (!this.coOccurrences.has(id2)) {
          this.coOccurrences.set(id2, new Map());
        }
        const count2 = this.coOccurrences.get(id2)!.get(id1) ?? 0;
        this.coOccurrences.get(id2)!.set(id1, count2 + 1);
      }
    }
  }

  /**
   * PHASE 2: Get memories that frequently co-occur with a given memory
   */
  getCoOccurring(id: string, limit = 5): CortexMemory[] {
    const coOccurs = this.coOccurrences.get(id);
    if (!coOccurs) {
      return [];
    }

    const sorted = Array.from(coOccurs.entries())
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, limit);

    return sorted
      .map(([coId]) => this.memories.get(coId))
      .filter((m): m is CortexMemory => m !== undefined);
  }

  getByCategory(category: string): CortexMemory[] {
    const ids = this.byCategory.get(category);
    if (!ids) {
      return [];
    }
    return Array.from(ids)
      .map(id => this.memories.get(id))
      .filter((m): m is CortexMemory => m !== undefined);
  }

  getHotMemories(limit = 100): CortexMemory[] {
    // PHASE 2: First check the hot tier, then fall back to access ranking
    const hotIds = this.hotTier.getHotIds();

    if (hotIds.length >= limit) {
      return hotIds
        .slice(0, limit)
        .map(id => this.memories.get(id))
        .filter((m): m is CortexMemory => m !== undefined);
    }

    // Supplement with access ranking
    const hotSet = new Set(hotIds);
    const additional = Array.from(this.accessRanking.entries())
      .filter(([id]) => !hotSet.has(id))
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, limit - hotIds.length);

    const allIds = [...hotIds, ...additional.map(([id]) => id)];
    return allIds
      .map(id => this.memories.get(id))
      .filter((m): m is CortexMemory => m !== undefined);
  }

  /**
   * PHASE 2: Get memories within a token budget
   * Prioritizes by: importance × recency × access_count
   * Truncates old memories, skips low-relevance items
   */
  getWithinTokenBudget(
    query: string,
    budget: TokenBudgetConfig = { maxContextTokens: 2000, relevanceThreshold: 0.5, truncateOldMemoriesTo: 200 }
  ): Array<CortexMemory & { finalContent: string; tokens: number }> {
    const results: Array<CortexMemory & { finalContent: string; tokens: number }> = [];
    let usedTokens = 0;

    // Search and score memories
    const candidates = this.searchByKeyword(query, 50); // Get more candidates for filtering

    // Score and sort by composite priority
    const scored = candidates.map(memory => {
      const recency = this.calculateRecency(memory.timestamp);
      const accessScore = this.hotTier.getAccessCount(memory.id) / 100; // Normalize
      const priority = memory.importance * recency * (1 + accessScore);
      return { memory, priority, recency };
    }).toSorted((a, b) => b.priority - a.priority);

    for (const { memory, priority, recency } of scored) {
      // Skip if below relevance threshold
      if (priority < budget.relevanceThreshold) {
        continue;
      }

      // Truncate old memories (recency < 0.3 = older than ~4 days)
      let content = memory.content;
      if (recency < 0.3 && content.length > budget.truncateOldMemoriesTo) {
        content = content.slice(0, budget.truncateOldMemoriesTo) + "...";
      }

      const tokens = estimateTokens(content);

      // Check budget
      if (usedTokens + tokens > budget.maxContextTokens) {
        break; // Budget exhausted
      }

      usedTokens += tokens;
      results.push({ ...memory, finalContent: content, tokens });
    }

    return results;
  }

  searchByKeyword(query: string, limit = 10): CortexMemory[] {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    if (terms.length === 0) {
      return [];
    }

    const matches: Array<{ memory: CortexMemory; score: number }> = [];

    for (const memory of this.memories.values()) {
      const content = memory.content.toLowerCase();
      let matchCount = 0;
      for (const term of terms) {
        if (content.includes(term)) {
          matchCount++;
        }
      }

      if (matchCount > 0) {
        const keywordScore = matchCount / terms.length;
        const recency = this.calculateRecency(memory.timestamp);
        const accessScore = this.accessRanking.get(memory.id) ?? 0;
        const combinedScore = keywordScore * 0.4 + recency * 0.3 + (accessScore / 1000) * 0.3;
        matches.push({ memory, score: combinedScore });
      }
    }

    return matches
      .toSorted((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(m => ({ ...m.memory, score: m.score }));
  }

  prefetchCategory(category: string): CortexMemory[] {
    // Immediately load all memories for a category into "hot" state
    const memories = this.getByCategory(category);
    for (const memory of memories) {
      // Boost access ranking for prefetched items
      const current = this.accessRanking.get(memory.id) ?? 0;
      this.accessRanking.set(memory.id, current * 1.5);
    }
    return memories;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get totalCount(): number {
    return this.memories.size;
  }

  get categories(): string[] {
    return Array.from(this.byCategory.keys());
  }

  get sizeBytes(): number {
    let total = 0;
    for (const memory of this.memories.values()) {
      total += memory.content.length * 2; // Rough estimate: 2 bytes per char
      total += 200; // Metadata overhead estimate
      if (memory.embedding) {
        total += memory.embedding.length * 8; // 8 bytes per float64
      }
    }
    return total;
  }

  getStats(): { total: number; byCategory: Record<string, number>; sizeBytes: number; hotCount: number; hotTierStats: ReturnType<HotMemoryTier["getStats"]> } {
    const byCategory: Record<string, number> = {};
    for (const [cat, ids] of this.byCategory.entries()) {
      byCategory[cat] = ids.size;
    }
    return {
      total: this.memories.size,
      byCategory,
      sizeBytes: this.sizeBytes,
      hotCount: this.hotTier.size,
      hotTierStats: this.hotTier.getStats(),
    };
  }

  /**
   * PHASE 2: Delta sync - load only memories changed since a timestamp
   */
  async loadDelta(embeddingsUrl: string): Promise<{ added: number; updated: number }> {
    try {
      const sinceTs = this.lastRefresh > 0
        ? new Date(this.lastRefresh).toISOString()
        : new Date(Date.now() - 86400000).toISOString(); // Default: last 24h

      const response = await fetch(`${embeddingsUrl}/delta?since=${encodeURIComponent(sinceTs)}`, {
        method: "GET",
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        // Daemon doesn't support /delta
        return { added: 0, updated: 0 };
      }

      const data = await response.json() as { memories: CortexMemory[]; since: string };

      let added = 0;
      let updated = 0;

      for (const memory of data.memories) {
        if (this.memories.has(memory.id)) {
          updated++;
        } else {
          added++;
        }
        this.add(memory);
      }

      this.lastRefresh = Date.now();
      return { added, updated };
    } catch {
      return { added: 0, updated: 0 };
    }
  }

  /**
   * Get last refresh timestamp
   */
  get lastRefreshTime(): number {
    return this.lastRefresh;
  }
}

export class CortexBridge {
  private memoryDir: string;  // Data directory for stm.json, embeddings, etc.
  private pythonScriptsDir: string;  // Directory containing Python scripts
  private pythonPath: string;
  private embeddingsUrl: string;

  // RAM Caches
  public readonly activeSession: ActiveSessionCache;
  public readonly memoryIndex: MemoryIndexCache;
  private stmCache: STMItem[] | null = null;
  private stmCacheTime: number = 0;
  private readonly stmCacheTTL = 5000; // 5 second TTL for STM cache

  // Configuration
  public readonly stmCapacity = 50000; // PHASE 1: Massive STM capacity
  public readonly activeSessionCapacity = 50; // Last 50 messages always in RAM

  // PHASE 2: Token budget and delta sync configuration
  public tokenBudget: TokenBudgetConfig = {
    maxContextTokens: 2000,
    relevanceThreshold: 0.5,
    truncateOldMemoriesTo: 200,
  };
  private deltaSyncInterval: ReturnType<typeof setInterval> | null = null;
  private readonly deltaSyncIntervalMs = 300000; // 5 minutes

  constructor(options?: {
    memoryDir?: string;
    pythonScriptsDir?: string;
    pythonPath?: string;
    embeddingsUrl?: string;
    hotTierSize?: number;
    tokenBudget?: Partial<TokenBudgetConfig>;
  }) {
    this.memoryDir = options?.memoryDir ?? join(homedir(), ".openclaw", "workspace", "memory");
    // Python scripts are in the extension's python/ directory
    // Use import.meta.url to find the extension directory
    const extensionDir = new URL(".", import.meta.url).pathname;
    this.pythonScriptsDir = options?.pythonScriptsDir ?? join(extensionDir, "python");
    this.pythonPath = options?.pythonPath ?? "python3";
    this.embeddingsUrl = options?.embeddingsUrl ?? "http://localhost:8030";

    // PHASE 2: Token budget config
    if (options?.tokenBudget) {
      this.tokenBudget = { ...this.tokenBudget, ...options.tokenBudget };
    }

    // Initialize RAM caches (PHASE 2: configurable hot tier size)
    this.activeSession = new ActiveSessionCache(this.activeSessionCapacity);
    this.memoryIndex = new MemoryIndexCache(options?.hotTierSize ?? 100);
  }

  /**
   * PHASE 1: Warm up all caches on startup
   * Loads full memory index into RAM for microsecond retrieval
   * PHASE 2: Also starts delta sync interval
   */
  async warmupCaches(): Promise<{ stm: number; memories: number; activeSession: number }> {
    const results = { stm: 0, memories: 0, activeSession: 0 };

    // Load STM into cache
    try {
      const stmData = await this.loadSTMDirect();
      this.stmCache = stmData.short_term_memory;
      this.stmCacheTime = Date.now();
      results.stm = this.stmCache.length;
    } catch {
      // STM load failed, will fall back to on-demand
    }

    // Try to load full memory index from daemon
    try {
      results.memories = await this.memoryIndex.loadFromDaemon(this.embeddingsUrl);
    } catch {
      // Daemon doesn't support dump, index will be populated on-demand
    }

    results.activeSession = this.activeSession.count;

    // PHASE 2: Start delta sync interval
    this.startDeltaSync();

    return results;
  }

  /**
   * PHASE 2: Start background delta sync
   */
  startDeltaSync(): void {
    if (this.deltaSyncInterval) {
      return; // Already running
    }

    this.deltaSyncInterval = setInterval(async () => {
      try {
        const result = await this.memoryIndex.loadDelta(this.embeddingsUrl);
        if (result.added > 0 || result.updated > 0) {
          console.log(`[Cortex] Delta sync: +${result.added} new, ${result.updated} updated`);
        }
        // Also apply decay to hot tier
        this.memoryIndex.hotTier.applyDecay();
      } catch (err) {
        console.warn(`[Cortex] Delta sync failed: ${err}`);
      }
    }, this.deltaSyncIntervalMs);
  }

  /**
   * PHASE 2: Stop background delta sync
   */
  stopDeltaSync(): void {
    if (this.deltaSyncInterval) {
      clearInterval(this.deltaSyncInterval);
      this.deltaSyncInterval = null;
    }
  }

  /**
   * PHASE 2: Get memories within token budget
   */
  getContextWithinBudget(query: string, budgetOverride?: Partial<TokenBudgetConfig>): Array<CortexMemory & { finalContent: string; tokens: number }> {
    const budget = { ...this.tokenBudget, ...budgetOverride };
    return this.memoryIndex.getWithinTokenBudget(query, budget);
  }

  /**
   * PHASE 2: Get hot memories (most accessed)
   */
  getHotMemoriesTier(limit = 100): CortexMemory[] {
    return this.memoryIndex.getHotMemories(limit);
  }

  /**
   * PHASE 2: Predictive prefetch based on co-occurrence
   */
  async prefetchRelated(memoryId: string): Promise<number> {
    const related = this.memoryIndex.getCoOccurring(memoryId, 10);
    // Mark them as hot by recording access
    for (const memory of related) {
      this.memoryIndex.hotTier.recordAccess(memory.id);
    }
    return related.length;
  }

  /**
   * Add message to Active Session cache (L2)
   */
  trackMessage(role: "user" | "assistant" | "system", content: string, messageId?: string): void {
    this.activeSession.add({
      role,
      content,
      timestamp: new Date().toISOString(),
      messageId,
    });
  }

  /**
   * Get recent context from Active Session (L2)
   * This is what fixes "forgot 5 messages ago"
   */
  getRecentContext(count = 10): string {
    const messages = this.activeSession.getRecent(count);
    if (messages.length === 0) {
      return "";
    }
    return messages.map(m => `[${m.role}] ${m.content.slice(0, 200)}`).join("\n");
  }

  /**
   * Search Active Session for recent context
   */
  searchActiveSession(query: string): ActiveSessionMessage[] {
    return this.activeSession.search(query);
  }

  /**
   * Check if the embeddings daemon is running
   */
  async isEmbeddingsDaemonAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.embeddingsUrl}/health`, {
        signal: AbortSignal.timeout(2000)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Semantic search using the GPU embeddings daemon (fast path)
   * Now with RAM cache integration
   */
  async semanticSearch(
    query: string,
    options: { limit?: number; temporalWeight?: number; minScore?: number } = {}
  ): Promise<Array<{ content: string; category: string | null; importance: number; score: number; semantic: number }>> {
    const { limit = 5, temporalWeight = 0.3, minScore = 0.3 } = options;

    // First, try RAM cache keyword search (microseconds)
    if (this.memoryIndex.isInitialized) {
      const cachedResults = this.memoryIndex.searchByKeyword(query, limit * 2);
      if (cachedResults.length >= limit) {
        return cachedResults.slice(0, limit).map(r => ({
          content: r.content,
          category: r.category,
          importance: r.importance,
          score: r.score ?? 0.5,
          semantic: 0.5, // Keyword match, not semantic
        }));
      }
    }

    // Fall back to GPU semantic search
    try {
      const response = await fetch(`${this.embeddingsUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit: limit * 2, temporal_weight: temporalWeight }),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`Embeddings search failed: ${response.status}`);
      }

      const data = await response.json() as { results: Array<{ content: string; category: string | null; importance: number; score: number; semantic: number }> };

      // Cache results in memory index
      for (const result of data.results) {
        if (result.score >= minScore) {
          this.memoryIndex.add({
            id: `search-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            content: result.content,
            source: "search",
            category: result.category,
            timestamp: new Date().toISOString(),
            importance: result.importance,
            access_count: 1,
            score: result.score,
            semantic_score: result.semantic,
          });
        }
      }

      return data.results
        .filter(r => r.score >= minScore)
        .slice(0, limit);
    } catch {
      // Fall back to Python-based search if daemon unavailable
      console.warn("Embeddings daemon unavailable, falling back to Python search");
      const results = await this.searchMemories(query, { limit, temporalWeight });
      return results.map(r => ({
        content: r.content,
        category: r.category,
        importance: r.importance,
        score: r.score ?? 0.5,
        semantic: r.semantic_score ?? 0.5,
      }));
    }
  }

  /**
   * Store memory using the GPU embeddings daemon (fast path)
   * With write-through to RAM cache
   * PHASE 2B: Multi-category support
   */
  async storeMemoryFast(
    content: string,
    options: { category?: string; categories?: string | string[]; importance?: number } = {}
  ): Promise<string> {
    const { importance = 1.0 } = options;
    const normalizedCats = normalizeCategories(options.categories ?? options.category);
    const timestamp = new Date().toISOString();
    const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Write to RAM cache immediately
    this.memoryIndex.add({
      id,
      content,
      source: "agent",
      categories: normalizedCats,
      category: normalizedCats[0],  // Keep for backward compat
      timestamp,
      importance,
      access_count: 0,
    });

    // Then persist to daemon/SQLite (send categories as JSON array)
    try {
      const response = await fetch(`${this.embeddingsUrl}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, categories: normalizedCats, importance, timestamp }),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`Embeddings store failed: ${response.status}`);
      }

      const data = await response.json() as { id: string };
      return data.id;
    } catch {
      // Fall back to Python-based storage
      return this.addMemory(content, { categories: normalizedCats, importance });
    }
  }

  /**
   * Predictive prefetch - load all memories for a category into hot cache
   */
  async prefetchCategory(category: string): Promise<number> {
    const memories = this.memoryIndex.prefetchCategory(category);
    return memories.length;
  }

  /**
   * Get hot memories (most accessed/recent)
   */
  getHotMemories(limit = 100): CortexMemory[] {
    return this.memoryIndex.getHotMemories(limit);
  }

  /**
   * Check if Cortex is available (Python scripts exist)
   */
  async isAvailable(): Promise<boolean> {
    try {
      await access(join(this.pythonScriptsDir, "stm_manager.py"), constants.R_OK);
      await access(join(this.pythonScriptsDir, "embeddings_manager.py"), constants.R_OK);
      await access(join(this.pythonScriptsDir, "collections_manager.py"), constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run a Python script and return JSON result
   * Scripts are loaded from pythonScriptsDir, data is read/written to memoryDir
   */
  private async runPython(code: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.pythonPath, ["-c", code], {
        cwd: this.pythonScriptsDir,
        env: {
          ...process.env,
          PYTHONPATH: this.pythonScriptsDir,
          CORTEX_DATA_DIR: this.memoryDir,  // Tell Python where to store data
        },
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (exitCode) => {
        if (exitCode !== 0) {
          reject(new Error(`Python error (exit ${exitCode}): ${stderr || stdout || "Unknown error"}`));
          return;
        }
        try {
          // Try to parse as JSON
          const trimmed = stdout.trim();
          if (!trimmed) {
            // Empty output - return null
            resolve(null);
            return;
          }
          // Find the last line that looks like JSON (in case there's debug output)
          const lines = trimmed.split("\n");
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.startsWith("{") || line.startsWith("[") || line === "null" || line === "true" || line === "false") {
              try {
                resolve(JSON.parse(line));
                return;
              } catch {
                // Keep looking
              }
            }
          }
          // Try parsing the whole thing
          resolve(JSON.parse(trimmed));
        } catch {
          // If JSON parse fails completely, reject with the error
          reject(new Error(`Python output not valid JSON: ${stdout.slice(0, 200)}${stderr ? ` (stderr: ${stderr.slice(0, 200)})` : ""}`));
        }
      });

      proc.on("error", reject);
    });
  }

  /**
   * Add to short-term memory
   * PHASE 1: Now with 50,000 item capacity
   * PHASE 2B: Multi-category support
   */
  async addToSTM(content: string, categories?: string | string[], importance: number = 1.0): Promise<STMItem> {
    const normalizedCats = normalizeCategories(categories);
    const item: STMItem = {
      content,
      timestamp: new Date().toISOString(),
      categories: normalizedCats,
      category: normalizedCats[0],  // Keep for backward compat
      importance,
      access_count: 0,
    };

    // Update RAM cache immediately
    if (this.stmCache) {
      this.stmCache.push(item);
      // Trim to capacity
      if (this.stmCache.length > this.stmCapacity) {
        this.stmCache = this.stmCache.slice(-this.stmCapacity);
      }
    }

    // Persist via Python - send categories as JSON array
    const categoriesJson = JSON.stringify(normalizedCats);
    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from stm_manager import add_to_stm
result = add_to_stm(${JSON.stringify(content)}, categories=${categoriesJson}, importance=${importance})
print(json.dumps(result))
`;
    return (await this.runPython(code)) as STMItem;
  }

  /**
   * Get recent items from STM
   * PHASE 1: Uses RAM cache when available (microsecond access)
   * PHASE 2B: Multi-category filtering support
   */
  async getRecentSTM(limit: number = 10, category?: string | string[]): Promise<STMItem[]> {
    // Check RAM cache first
    const cacheAge = Date.now() - this.stmCacheTime;
    if (this.stmCache && cacheAge < this.stmCacheTTL) {
      let items = this.stmCache;
      if (category) {
        // Normalize both item and query categories for comparison
        items = items.filter(i => {
          const itemCats = i.categories ?? (i.category ? [i.category] : ["general"]);
          return categoriesMatch(itemCats, category);
        });
      }
      return items.slice(-limit).toReversed();
    }

    // Cache miss or stale - refresh from disk
    // For Python, send single category for backward compat (multi-cat filtering happens in JS)
    const singleCat = Array.isArray(category) ? category[0] : category;
    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from stm_manager import get_recent
result = get_recent(limit=${limit}, category=${singleCat ? JSON.stringify(singleCat) : "None"})
print(json.dumps(result))
`;
    const result = (await this.runPython(code)) as STMItem[];

    // Normalize categories in results
    const normalizedResult = result.map(item => ({
      ...item,
      categories: item.categories ?? (item.category ? [item.category] : ["general"]),
    }));

    // Update cache
    if (!category) {
      // Only cache full results
      const stmData = await this.loadSTMDirect();
      this.stmCache = stmData.short_term_memory.map(item => ({
        ...item,
        categories: item.categories ?? (item.category ? [item.category] : ["general"]),
      }));
      this.stmCacheTime = Date.now();
    }

    return normalizedResult;
  }

  /**
   * Search memories with temporal weighting
   */
  async searchMemories(query: string, options: CortexSearchOptions = {}): Promise<CortexMemory[]> {
    const { limit = 10, temporalWeight = 0.7, dateRange, category } = options;

    let dateRangeArg = "None";
    if (typeof dateRange === "string") {
      dateRangeArg = JSON.stringify(dateRange);
    } else if (Array.isArray(dateRange)) {
      dateRangeArg = JSON.stringify(dateRange);
    }

    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from embeddings_manager import search_memories, init_db
init_db()
result = search_memories(
    ${JSON.stringify(query)},
    limit=${limit},
    temporal_weight=${temporalWeight},
    date_range=${dateRangeArg},
    category=${category ? JSON.stringify(category) : "None"}
)
print(json.dumps(result))
`;
    return (await this.runPython(code)) as CortexMemory[];
  }

  /**
   * Add memory to embeddings database
   * PHASE 2B: Multi-category support
   */
  async addMemory(
    content: string,
    options: {
      source?: string;
      category?: string;  // Deprecated: use categories
      categories?: string | string[];
      importance?: number;
    } = {},
  ): Promise<string> {
    const { source = "agent", importance = 1.0 } = options;
    const normalizedCats = normalizeCategories(options.categories ?? options.category);

    // Add to RAM cache
    const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.memoryIndex.add({
      id,
      content,
      source,
      categories: normalizedCats,
      category: normalizedCats[0],  // Keep for backward compat
      timestamp: new Date().toISOString(),
      importance,
      access_count: 0,
    });

    // For Python, send categories as JSON array
    const categoriesJson = JSON.stringify(normalizedCats);
    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from embeddings_manager import add_memory, init_db
init_db()
result = add_memory(
    ${JSON.stringify(content)},
    source=${JSON.stringify(source)},
    categories=${categoriesJson},
    importance=${importance}
)
print(json.dumps(result))
`;
    return (await this.runPython(code)) as string;
  }

  /**
   * Get database statistics
   */
  async getStats(): Promise<{ total: number; by_category: Record<string, number>; by_source: Record<string, number> }> {
    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from embeddings_manager import stats, init_db
init_db()
result = stats()
print(json.dumps(result))
`;
    return (await this.runPython(code)) as { total: number; by_category: Record<string, number>; by_source: Record<string, number> };
  }

  /**
   * Get extended stats including RAM cache info
   */
  getExtendedStats(): {
    stm: { count: number; capacity: number; cached: boolean };
    activeSession: { count: number; capacity: number; sizeBytes: number };
    memoryIndex: { total: number; byCategory: Record<string, number>; sizeBytes: number; initialized: boolean };
    totalRamUsageBytes: number;
  } {
    const stmCount = this.stmCache?.length ?? 0;
    const activeSessionStats = {
      count: this.activeSession.count,
      capacity: this.activeSessionCapacity,
      sizeBytes: this.activeSession.sizeBytes,
    };
    const memoryIndexStats = this.memoryIndex.getStats();

    return {
      stm: {
        count: stmCount,
        capacity: this.stmCapacity,
        cached: this.stmCache !== null,
      },
      activeSession: activeSessionStats,
      memoryIndex: {
        ...memoryIndexStats,
        initialized: this.memoryIndex.isInitialized,
      },
      totalRamUsageBytes: activeSessionStats.sizeBytes + memoryIndexStats.sizeBytes + (stmCount * 2000),
    };
  }

  /**
   * Sync STM and collections to embeddings database
   */
  async syncAll(): Promise<{ stm: number; collections: number }> {
    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from embeddings_manager import sync_from_stm, sync_from_collections, init_db
init_db()
stm_count = sync_from_stm()
col_count = sync_from_collections()
print(json.dumps({"stm": stm_count, "collections": col_count}))
`;
    return (await this.runPython(code)) as { stm: number; collections: number };
  }

  /**
   * Run maintenance (cleanup expired STM, sync to embeddings)
   */
  async runMaintenance(mode: "nightly" | "weekly" = "nightly"): Promise<string> {
    const code = `
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from maintenance import main
result = main(["${mode}"])
print(result or "OK")
`;
    return (await this.runPython(code)) as string;
  }

  /**
   * Load STM directly from JSON file
   */
  async updateSTM(memoryId: string, importance?: number, categories?: string[]): Promise<boolean> {
    const impArg = importance !== undefined ? String(importance) : "None";
    const catArg = categories ? JSON.stringify(categories) : "None";
    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from brain import UnifiedBrain
b = UnifiedBrain()
result = b.update_stm('${memoryId}', importance=${impArg}, categories=${catArg})
print(json.dumps(result))
`;
    const result = await this.runPython(code);
    this.stmCache = null;
    this.stmCacheTime = 0;
    return result === true;
  }

  async deleteSTMBatch(memoryIds: string[]): Promise<number> {
    if (memoryIds.length === 0) return 0;
    const idsJson = JSON.stringify(memoryIds);
    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from stm_manager import delete_stm_batch
result = delete_stm_batch(${idsJson})
print(json.dumps(result))
`;
    const result = await this.runPython(code);
    // Invalidate STM cache
    this.stmCache = null;
    this.stmCacheTime = 0;
    return typeof result === "number" ? result : 0;
  }

  async loadSTMDirect(): Promise<{ short_term_memory: STMItem[]; capacity: number; auto_expire_days: number }> {
    const stmPath = join(this.memoryDir, "stm.json");
    try {
      const data = await readFile(stmPath, "utf-8");
      return JSON.parse(data);
    } catch {
      return { short_term_memory: [], capacity: this.stmCapacity, auto_expire_days: 30 };
    }
  }

  /**
   * Update STM capacity in the JSON file
   */
  async updateSTMCapacity(newCapacity: number): Promise<void> {
    const stmPath = join(this.memoryDir, "stm.json");
    try {
      const data = await this.loadSTMDirect();
      data.capacity = newCapacity;
      await writeFile(stmPath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error("Failed to update STM capacity:", err);
    }
  }

  // ==========================================
  // PHASE 3: ATOMIC KNOWLEDGE OPERATIONS
  // ==========================================

  /**
   * Create an atomic knowledge unit
   * PHASE 3: The irreducible unit of causal understanding
   */
  async createAtom(
    subject: string,
    action: string,
    outcome: string,
    consequences: string,
    options: {
      source?: string;
      confidence?: number;
      actionTimestamp?: string;
      outcomeDelaySeconds?: number;
      consequenceDelaySeconds?: number;
      sourceMemoryId?: string;
    } = {}
  ): Promise<string> {
    const {
      source = "agent",
      confidence = 1.0,
      actionTimestamp,
      outcomeDelaySeconds,
      consequenceDelaySeconds,
      sourceMemoryId,
    } = options;

    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from atom_manager import create_atom, init_db
init_db()
result = create_atom(
    subject=${JSON.stringify(subject)},
    action=${JSON.stringify(action)},
    outcome=${JSON.stringify(outcome)},
    consequences=${JSON.stringify(consequences)},
    source=${JSON.stringify(source)},
    confidence=${confidence},
    action_timestamp=${actionTimestamp ? JSON.stringify(actionTimestamp) : "None"},
    outcome_delay_seconds=${outcomeDelaySeconds ?? "None"},
    consequence_delay_seconds=${consequenceDelaySeconds ?? "None"},
    source_memory_id=${sourceMemoryId ? JSON.stringify(sourceMemoryId) : "None"}
)
print(json.dumps(result))
`;
    return (await this.runPython(code)) as string;
  }

  /**
   * Get an atom by ID
   * PHASE 3: Retrieve atomic knowledge unit
   */
  async getAtom(atomId: string): Promise<Atom | null> {
    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from atom_manager import get_atom, init_db
init_db()
result = get_atom(${JSON.stringify(atomId)})
print(json.dumps(result))
`;
    return (await this.runPython(code)) as Atom | null;
  }

  /**
   * Search atoms by field similarity
   * PHASE 3: Field-level semantic search (subject, action, outcome, consequences)
   */
  async searchAtomsByField(
    field: "subject" | "action" | "outcome" | "consequences",
    query: string,
    options: { limit?: number; threshold?: number } = {}
  ): Promise<AtomSearchResult[]> {
    const { limit = 10, threshold = 0.5 } = options;

    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from atom_manager import search_by_field, init_db
init_db()
result = search_by_field(${JSON.stringify(field)}, ${JSON.stringify(query)}, limit=${limit}, threshold=${threshold})
print(json.dumps(result))
`;
    return (await this.runPython(code)) as AtomSearchResult[];
  }

  /**
   * Create a causal link between atoms
   * PHASE 3: Connect atoms in causal chains
   */
  async createCausalLink(
    fromAtomId: string,
    toAtomId: string,
    linkType: "causes" | "enables" | "precedes" | "correlates" = "causes",
    strength: number = 0.5
  ): Promise<string> {
    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from atom_manager import create_causal_link, init_db
init_db()
result = create_causal_link(
    ${JSON.stringify(fromAtomId)},
    ${JSON.stringify(toAtomId)},
    ${JSON.stringify(linkType)},
    ${strength}
)
print(json.dumps(result))
`;
    return (await this.runPython(code)) as string;
  }

  /**
   * Find root causes by traversing causal chains backward
   * PHASE 3: The core "keep going until the answer is no" capability
   */
  async findRootCauses(
    atomId: string,
    maxDepth: number = 10
  ): Promise<Atom[]> {
    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from atom_manager import find_root_causes, init_db
init_db()
result = find_root_causes(${JSON.stringify(atomId)}, max_depth=${maxDepth})
print(json.dumps(result))
`;
    return (await this.runPython(code)) as Atom[];
  }

  /**
   * Find all causal paths leading to an outcome
   * PHASE 3: Discover the "40 novel indicators" that others miss
   */
  async findPathsToOutcome(
    targetOutcome: string,
    maxDepth: number = 10
  ): Promise<Atom[]> {
    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from atom_manager import find_all_paths_to_outcome, init_db
init_db()
result = find_all_paths_to_outcome(${JSON.stringify(targetOutcome)}, max_depth=${maxDepth})
print(json.dumps(result))
`;
    return (await this.runPython(code)) as Atom[];
  }

  /**
   * Get atomic knowledge statistics
   * PHASE 3: Stats for the atoms database
   */
  async getAtomStats(): Promise<AtomStats> {
    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from atom_manager import stats, init_db
init_db()
result = stats()
print(json.dumps(result))
`;
    return (await this.runPython(code)) as AtomStats;
  }

  // ==========================================
  // PHASE 3B: ATOMIZATION PIPELINE
  // ==========================================

  /**
   * Atomize text - extract atoms from text content
   * PHASE 3B: Local pattern matching, no API tokens needed
   */
  async atomizeText(
    text: string,
    options: { source?: string; saveToDb?: boolean; useLlmFallback?: boolean } = {}
  ): Promise<string[]> {
    const { source = "agent", saveToDb = true, useLlmFallback = false } = options;

    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from atomizer import atomize_text
result = atomize_text(
    ${JSON.stringify(text)},
    source=${JSON.stringify(source)},
    save_to_db=${saveToDb ? "True" : "False"},
    use_llm_fallback=${useLlmFallback ? "True" : "False"}
)
print(json.dumps(result))
`;
    return (await this.runPython(code)) as string[];
  }

  /**
   * Batch atomize existing STM memories
   * PHASE 3B: Migrate Phase 2 memories to atoms
   */
  async batchAtomizeSTM(): Promise<{ processed: number; atomsCreated: number }> {
    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from atomizer import batch_atomize_stm
processed, atoms = batch_atomize_stm()
print(json.dumps({"processed": processed, "atomsCreated": atoms}))
`;
    return (await this.runPython(code)) as { processed: number; atomsCreated: number };
  }

  /**
   * Batch atomize existing embeddings memories
   * PHASE 3B: Migrate Phase 2 memories to atoms
   */
  async batchAtomizeEmbeddings(): Promise<{ processed: number; atomsCreated: number }> {
    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from atomizer import batch_atomize_embeddings
processed, atoms = batch_atomize_embeddings()
print(json.dumps({"processed": processed, "atomsCreated": atoms}))
`;
    return (await this.runPython(code)) as { processed: number; atomsCreated: number };
  }

  /**
   * Auto-atomize on memory store (for hook integration)
   * PHASE 3B: Gradual migration as new memories come in
   */
  async autoAtomize(content: string, source: string = "auto"): Promise<string[]> {
    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from atomizer import auto_atomize_on_store
result = auto_atomize_on_store(${JSON.stringify(content)}, source=${JSON.stringify(source)})
print(json.dumps(result))
`;
    return (await this.runPython(code)) as string[];
  }

  // ==========================================
  // PHASE 3E: DEEP ABSTRACTION LAYER
  // ==========================================

  /**
   * Classify a query as causal or recall
   * PHASE 3E: Determines if deep abstraction is needed
   */
  async classifyQuery(query: string): Promise<{ queryType: string; confidence: number }> {
    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from deep_abstraction import classify_query
qtype, conf = classify_query(${JSON.stringify(query)})
print(json.dumps({"queryType": qtype, "confidence": conf}))
`;
    return (await this.runPython(code)) as { queryType: string; confidence: number };
  }

  /**
   * Run deep abstraction on a query
   * PHASE 3E: The "keep going until no" capability
   */
  async abstractDeeper(
    query: string,
    options: { maxDepth?: number; minConfidence?: number } = {}
  ): Promise<DeepAbstractionResult> {
    const { maxDepth = 5, minConfidence = 0.5 } = options;

    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from deep_abstraction import abstract_deeper
result = abstract_deeper(${JSON.stringify(query)}, max_depth=${maxDepth}, min_confidence=${minConfidence})
print(json.dumps(result))
`;
    return (await this.runPython(code)) as DeepAbstractionResult;
  }

  /**
   * Process query with automatic abstraction
   * PHASE 3E: Main entry point for deep abstraction layer
   */
  async processWithAbstraction(
    query: string,
    options: { autoAbstract?: boolean; maxDepth?: number } = {}
  ): Promise<AbstractionProcessResult> {
    const { autoAbstract = true, maxDepth = 5 } = options;

    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from deep_abstraction import process_query_with_abstraction
result = process_query_with_abstraction(
    ${JSON.stringify(query)},
    auto_abstract=${autoAbstract ? "True" : "False"},
    max_depth=${maxDepth}
)
print(json.dumps(result))
`;
    return (await this.runPython(code)) as AbstractionProcessResult;
  }

  // ==========================================
  // PHASE 3F: TEMPORAL ANALYSIS
  // ==========================================

  /**
   * Search atoms with temporal context
   * PHASE 3F: Time-aware queries
   */
  async searchTemporal(
    query: string,
    timeReference: string,
    limit: number = 20
  ): Promise<TemporalSearchResult> {
    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from temporal_analysis import search_temporal
result = search_temporal(${JSON.stringify(query)}, ${JSON.stringify(timeReference)}, limit=${limit})
print(json.dumps(result))
`;
    return (await this.runPython(code)) as TemporalSearchResult;
  }

  /**
   * Find what happened before an event
   * PHASE 3F: Temporal precursor analysis
   */
  async whatHappenedBefore(
    eventDescription: string,
    hoursBefore: number = 4,
    limit: number = 20
  ): Promise<PrecursorAnalysisResult> {
    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from temporal_analysis import what_happened_before
result = what_happened_before(${JSON.stringify(eventDescription)}, hours_before=${hoursBefore}, limit=${limit})
print(json.dumps(result))
`;
    return (await this.runPython(code)) as PrecursorAnalysisResult;
  }

  /**
   * Analyze temporal patterns for an outcome
   * PHASE 3F: "Whale accumulation precedes price movement by 4-12 hours"
   */
  async analyzeTemporalPatterns(
    outcomePattern: string,
    minObservations: number = 3
  ): Promise<TemporalPatternResult> {
    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from temporal_analysis import analyze_temporal_patterns
result = analyze_temporal_patterns(${JSON.stringify(outcomePattern)}, min_observations=${minObservations})
print(json.dumps(result))
`;
    return (await this.runPython(code)) as TemporalPatternResult;
  }

  /**
   * Detect delay patterns across all atoms
   * PHASE 3F: Find consistent timing patterns
   */
  async detectDelayPatterns(): Promise<DelayPatternResult> {
    const code = `
import json
import sys
sys.path.insert(0, '${this.pythonScriptsDir}')
from temporal_analysis import detect_delay_patterns
result = detect_delay_patterns()
print(json.dumps(result))
`;
    return (await this.runPython(code)) as DelayPatternResult;
  }
}

/**
 * PHASE 3: Atom interface - the irreducible unit of causal understanding
 */
export interface Atom {
  id: string;
  subject: string;
  action: string;
  outcome: string;
  consequences: string;
  action_timestamp?: string;
  outcome_delay_seconds?: number;
  consequence_delay_seconds?: number;
  confidence: number;
  access_count: number;
  created_at: string;
  source: string;
  source_memory_id?: string;
  depth?: number;  // Set by causal traversal
}

/**
 * PHASE 3: Search result with similarity score
 */
export interface AtomSearchResult extends Atom {
  similarity: number;
  matched_field: string;
}

/**
 * PHASE 3: Atom database statistics
 */
export interface AtomStats {
  total_atoms: number;
  total_causal_links: number;
  by_source: Record<string, number>;
  links_by_type: Record<string, number>;
  avg_confidence: number;
  atoms_with_embeddings: number;
  embeddings_available: boolean;
}

/**
 * PHASE 3E: Deep Abstraction result
 */
export interface DeepAbstractionResult {
  query: string;
  query_type: string;
  targets: string[];
  causal_chains: Array<{
    target: string;
    starting_atom: Atom;
    root_causes: Atom[];
    depth: number;
  }>;
  novel_indicators: Array<{
    atom: Atom;
    frequency: number;
    insight: string;
  }>;
  epistemic_limits: string[];
  depth_reached: number;
  atoms_traversed: number;
}

/**
 * PHASE 3E: Abstraction process result (includes context injection)
 */
export interface AbstractionProcessResult {
  query: string;
  query_type: string;
  classification_confidence: number;
  abstraction_performed: boolean;
  abstraction_result: DeepAbstractionResult | null;
  context_injection: string;
}

/**
 * PHASE 3F: Temporal search result
 */
export interface TemporalSearchResult {
  query: string;
  time_reference: string;
  time_range: { start: string; end: string } | null;
  atoms: Atom[];
  temporal_patterns: Array<Record<string, unknown>>;
}

/**
 * PHASE 3F: Precursor analysis result
 */
export interface PrecursorAnalysisResult {
  event: string;
  lookback_hours: number;
  precursor_atoms: Array<Atom & { time_before_event?: string }>;
  causal_candidates: Array<{ atom: Atom; reason: string }>;
  error?: string;
}

/**
 * PHASE 3F: Temporal pattern result
 */
export interface TemporalPatternResult {
  outcome_pattern: string;
  observations: number;
  avg_outcome_delay: { seconds: number; human: string } | null;
  avg_consequence_delay: { seconds: number; human: string } | null;
  common_precursors: Array<{ subject: string; count: number }>;
  time_patterns: {
    peak_hour?: number;
    distribution?: Record<number, number>;
  };
  error?: string;
}

/**
 * PHASE 3F: Delay pattern detection result
 */
export interface DelayPatternResult {
  patterns: Array<{
    pattern: string;
    observations: number;
    avg_delay_seconds: number;
    avg_delay_human: string;
  }>;
  total_observations: number;
}

export const defaultBridge = new CortexBridge();
