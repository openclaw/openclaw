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
  private memoryDir: string;
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
    pythonPath?: string;
    embeddingsUrl?: string;
    hotTierSize?: number;
    tokenBudget?: Partial<TokenBudgetConfig>;
  }) {
    this.memoryDir = options?.memoryDir ?? join(homedir(), ".openclaw", "workspace", "memory");
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
   * PHASE 3: Multi-category support
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
      await access(join(this.memoryDir, "stm_manager.py"), constants.R_OK);
      await access(join(this.memoryDir, "embeddings_manager.py"), constants.R_OK);
      await access(join(this.memoryDir, "collections_manager.py"), constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run a Python script and return JSON result
   */
  private async runPython(code: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.pythonPath, ["-c", code], {
        cwd: this.memoryDir,
        env: { ...process.env, PYTHONPATH: this.memoryDir },
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Python error: ${stderr || "Unknown error"}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(stdout.trim());
        }
      });

      proc.on("error", reject);
    });
  }

  /**
   * Add to short-term memory
   * PHASE 1: Now with 50,000 item capacity
   * PHASE 3: Multi-category support
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
sys.path.insert(0, '${this.memoryDir}')
from stm_manager import add_to_stm
result = add_to_stm(${JSON.stringify(content)}, categories=${categoriesJson}, importance=${importance})
print(json.dumps(result))
`;
    return (await this.runPython(code)) as STMItem;
  }

  /**
   * Get recent items from STM
   * PHASE 1: Uses RAM cache when available (microsecond access)
   * PHASE 3: Multi-category filtering support
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
sys.path.insert(0, '${this.memoryDir}')
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
sys.path.insert(0, '${this.memoryDir}')
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
   * PHASE 3: Multi-category support
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
sys.path.insert(0, '${this.memoryDir}')
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
sys.path.insert(0, '${this.memoryDir}')
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
sys.path.insert(0, '${this.memoryDir}')
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
sys.path.insert(0, '${this.memoryDir}')
from maintenance import main
result = main(["${mode}"])
print(result or "OK")
`;
    return (await this.runPython(code)) as string;
  }

  /**
   * Load STM directly from JSON file
   */
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
}

export const defaultBridge = new CortexBridge();
