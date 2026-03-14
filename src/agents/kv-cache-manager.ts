/**
 * KV Cache Manager for OpenClaw
 *
 * Manages llama.cpp KV cache slots with memory-driven context preloading,
 * smart eviction, and session persistence.
 */

import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { MemorySearchManager, MemorySearchResult } from "../memory/types.js";
import { resolveUserPath } from "../utils.js";

const log = createSubsystemLogger("kv-cache");

// ============================================================================
// Types
// ============================================================================

export type KvSlotState = {
  id: number;
  n_ctx: number;
  is_processing: boolean;
  sessionKey?: string;
  lastUsedAt?: number;
  tokensUsed?: number;
  preloadedFrom?: string[];
};

export type KvCacheConfig = {
  enabled: boolean;
  baseUrl: string;
  maxSlots: number;
  preloadEnabled: boolean;
  preloadMaxTokens: number;
  preloadMinScore: number;
  evictionEnabled: boolean;
  evictionIdleMs: number;
  persistenceEnabled: boolean;
  persistencePath: string;
};

export type KvCacheStatus = {
  enabled: boolean;
  slots: KvSlotState[];
  totalSlots: number;
  activeSlots: number;
  idleSlots: number;
  memoryUsedEstimate: number;
  preloadedSessions: string[];
};

export type PreloadResult = {
  slotId: number;
  tokensPreloaded: number;
  sources: string[];
  score: number;
};

type LlamaSlotInfo = {
  id: number;
  n_ctx: number;
  is_processing: boolean;
};

type LlamaSlotsResponse = LlamaSlotInfo[];

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_CONFIG: KvCacheConfig = {
  enabled: true,
  baseUrl: "http://127.0.0.1:18790",
  maxSlots: 4,
  preloadEnabled: true,
  preloadMaxTokens: 8192,
  preloadMinScore: 0.5,
  evictionEnabled: true,
  evictionIdleMs: 300000, // 5 minutes
  persistenceEnabled: true,
  persistencePath: "~/.openclaw/kv-cache",
};

export function resolveKvCacheConfig(
  cfg: OpenClawConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): KvCacheConfig {
  const kvConfig = cfg?.agents?.defaults?.kvCache as Record<string, unknown> | undefined;

  const baseUrl =
    (kvConfig?.baseUrl as string) ??
    env.LLAMA_SERVER_URL ??
    DEFAULT_CONFIG.baseUrl;

  const persistencePath =
    (kvConfig?.persistencePath as string) ??
    env.OPENCLAW_KV_CACHE_PATH ??
    DEFAULT_CONFIG.persistencePath;

  return {
    enabled: (kvConfig?.enabled as boolean) ?? DEFAULT_CONFIG.enabled,
    baseUrl,
    maxSlots: (kvConfig?.maxSlots as number) ?? DEFAULT_CONFIG.maxSlots,
    preloadEnabled: (kvConfig?.preloadEnabled as boolean) ?? DEFAULT_CONFIG.preloadEnabled,
    preloadMaxTokens: (kvConfig?.preloadMaxTokens as number) ?? DEFAULT_CONFIG.preloadMaxTokens,
    preloadMinScore: (kvConfig?.preloadMinScore as number) ?? DEFAULT_CONFIG.preloadMinScore,
    evictionEnabled: (kvConfig?.evictionEnabled as boolean) ?? DEFAULT_CONFIG.evictionEnabled,
    evictionIdleMs: (kvConfig?.evictionIdleMs as number) ?? DEFAULT_CONFIG.evictionIdleMs,
    persistenceEnabled: (kvConfig?.persistenceEnabled as boolean) ?? DEFAULT_CONFIG.persistenceEnabled,
    persistencePath: resolveUserPath(persistencePath),
  };
}

// ============================================================================
// KV Cache Manager
// ============================================================================

export class KvCacheManager {
  private readonly config: KvCacheConfig;
  private readonly memoryManager?: MemorySearchManager;
  private readonly slots = new Map<number, KvSlotState>();
  private readonly sessionToSlot = new Map<string, number>();
  private evictionTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(params: {
    config: KvCacheConfig;
    memoryManager?: MemorySearchManager;
  }) {
    this.config = params.config;
    this.memoryManager = params.memoryManager;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      log.info("KV cache manager disabled");
      return;
    }

    log.info(`Initializing KV cache manager (baseUrl: ${this.config.baseUrl})`);

    // Fetch initial slot state
    await this.refreshSlotState();

    // Start eviction timer
    if (this.config.evictionEnabled) {
      this.startEvictionTimer();
    }

    log.info(`KV cache manager initialized (${this.slots.size} slots)`);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = undefined;
    }

    // Persist slot states
    if (this.config.persistenceEnabled) {
      await this.persistSlotStates();
    }

    log.info("KV cache manager closed");
  }

  // --------------------------------------------------------------------------
  // Slot Management
  // --------------------------------------------------------------------------

  async refreshSlotState(): Promise<KvSlotState[]> {
    try {
      const response = await fetch(`${this.config.baseUrl}/slots`);
      if (!response.ok) {
        throw new Error(`Failed to fetch slots: ${response.status}`);
      }

      const slots = (await response.json()) as LlamaSlotsResponse;

      // Update slot states
      for (const slot of slots) {
        const existing = this.slots.get(slot.id);
        this.slots.set(slot.id, {
          ...existing,
          id: slot.id,
          n_ctx: slot.n_ctx,
          is_processing: slot.is_processing,
          lastUsedAt: existing?.lastUsedAt ?? Date.now(),
        });
      }

      return Array.from(this.slots.values());
    } catch (err) {
      log.warn(`Failed to refresh slot state: ${String(err)}`);
      return [];
    }
  }

  async acquireSlot(sessionKey: string): Promise<number | null> {
    // Check if session already has a slot
    const existingSlot = this.sessionToSlot.get(sessionKey);
    if (existingSlot !== undefined) {
      const state = this.slots.get(existingSlot);
      if (state && !state.is_processing) {
        state.lastUsedAt = Date.now();
        return existingSlot;
      }
    }

    // Find an available slot
    const slots = await this.refreshSlotState();
    const available = slots.find((s) => !s.is_processing && !this.sessionToSlot.has(String(s.id)));

    if (!available) {
      // Try to evict idle slot
      if (this.config.evictionEnabled) {
        const evicted = await this.evictIdleSlot();
        if (evicted !== null) {
          this.sessionToSlot.set(sessionKey, evicted);
          const state = this.slots.get(evicted);
          if (state) {
            state.sessionKey = sessionKey;
            state.lastUsedAt = Date.now();
          }
          return evicted;
        }
      }
      return null;
    }

    this.sessionToSlot.set(sessionKey, available.id);
    const state = this.slots.get(available.id);
    if (state) {
      state.sessionKey = sessionKey;
      state.lastUsedAt = Date.now();
    }

    return available.id;
  }

  releaseSlot(sessionKey: string): void {
    const slotId = this.sessionToSlot.get(sessionKey);
    if (slotId !== undefined) {
      this.sessionToSlot.delete(sessionKey);
      const state = this.slots.get(slotId);
      if (state) {
        state.sessionKey = undefined;
        state.lastUsedAt = Date.now();
      }
      log.debug(`Released slot ${slotId} for session ${sessionKey}`);
    }
  }

  // --------------------------------------------------------------------------
  // Memory-Driven Preloading
  // --------------------------------------------------------------------------

  async preloadContext(
    sessionKey: string,
    query: string,
  ): Promise<PreloadResult | null> {
    if (!this.config.preloadEnabled || !this.memoryManager) {
      return null;
    }

    const slotId = await this.acquireSlot(sessionKey);
    if (slotId === null) {
      log.warn(`No available slot for preloading session ${sessionKey}`);
      return null;
    }

    try {
      // Search memory for relevant context
      const results = await this.memoryManager.search(query, {
        maxResults: 10,
        minScore: this.config.preloadMinScore,
        sessionKey,
      });

      if (results.length === 0) {
        return { slotId, tokensPreloaded: 0, sources: [], score: 0 };
      }

      // Build preload content
      const { content, tokens, sources } = this.buildPreloadContent(results);

      if (tokens === 0) {
        return { slotId, tokensPreloaded: 0, sources: [], score: 0 };
      }

      // Warm up the slot with the context
      // Note: This is done by making a "prefill" request to populate KV cache
      await this.warmupSlot(slotId, content);

      // Update slot state
      const state = this.slots.get(slotId);
      if (state) {
        state.preloadedFrom = sources;
        state.tokensUsed = tokens;
      }

      log.info(`Preloaded ${tokens} tokens into slot ${slotId} for session ${sessionKey}`);

      return {
        slotId,
        tokensPreloaded: tokens,
        sources,
        score: results[0]?.score ?? 0,
      };
    } catch (err) {
      log.warn(`Failed to preload context: ${String(err)}`);
      return null;
    }
  }

  private buildPreloadContent(results: MemorySearchResult[]): {
    content: string;
    tokens: number;
    sources: string[];
  } {
    const parts: string[] = [];
    const sources: string[] = [];
    let estimatedTokens = 0;
    const maxTokens = this.config.preloadMaxTokens;

    for (const result of results) {
      const snippet = result.snippet?.trim();
      if (!snippet) continue;

      // Rough token estimation (1 token ≈ 4 chars)
      const snippetTokens = Math.ceil(snippet.length / 4);

      if (estimatedTokens + snippetTokens > maxTokens) {
        break;
      }

      parts.push(`[From ${result.path}]\n${snippet}`);
      sources.push(result.path);
      estimatedTokens += snippetTokens;
    }

    return {
      content: parts.join("\n\n"),
      tokens: estimatedTokens,
      sources,
    };
  }

  private async warmupSlot(slotId: number, content: string): Promise<void> {
    // Make a lightweight request to populate the KV cache
    // This uses the /v1/chat/completions endpoint with a system message
    const response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "current",
        messages: [
          {
            role: "system",
            content: `Context preloaded from memory:\n\n${content}`,
          },
          {
            role: "user",
            content: "[System: KV cache warmup - ignore this message]",
          },
        ],
        max_tokens: 1,
        temperature: 0,
        slot: slotId,
        cache_prompt: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Warmup request failed: ${response.status}`);
    }

    // Consume the response body
    await response.text();
  }

  // --------------------------------------------------------------------------
  // Smart Eviction
  // --------------------------------------------------------------------------

  private startEvictionTimer(): void {
    const interval = Math.max(60000, this.config.evictionIdleMs / 5);
    this.evictionTimer = setInterval(() => {
      void this.runEviction().catch((err) => {
        log.warn(`Eviction error: ${String(err)}`);
      });
    }, interval);
  }

  private async runEviction(): Promise<void> {
    const now = Date.now();
    const threshold = this.config.evictionIdleMs;

    for (const [sessionKey, slotId] of this.sessionToSlot) {
      const state = this.slots.get(slotId);
      if (!state) continue;

      if (state.is_processing) continue;

      const idleMs = now - (state.lastUsedAt ?? 0);
      if (idleMs > threshold) {
        log.info(`Evicting idle slot ${slotId} (session ${sessionKey}, idle ${Math.round(idleMs / 1000)}s)`);
        this.releaseSlot(sessionKey);
      }
    }
  }

  private async evictIdleSlot(): Promise<number | null> {
    let oldestSlot: number | null = null;
    let oldestTime = Infinity;

    for (const [slotId, state] of this.slots) {
      if (state.is_processing) continue;
      if (!state.sessionKey) {
        // Slot is free, use it directly
        return slotId;
      }

      if (state.lastUsedAt && state.lastUsedAt < oldestTime) {
        oldestTime = state.lastUsedAt;
        oldestSlot = slotId;
      }
    }

    if (oldestSlot !== null) {
      const state = this.slots.get(oldestSlot);
      if (state?.sessionKey) {
        this.releaseSlot(state.sessionKey);
      }
      return oldestSlot;
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  private async persistSlotStates(): Promise<void> {
    // Slot persistence is handled by llama.cpp's --slot-save-path
    // This method can be used for additional metadata persistence
    log.debug("Slot state persistence handled by llama.cpp");
  }

  // --------------------------------------------------------------------------
  // Status & Monitoring
  // --------------------------------------------------------------------------

  getStatus(): KvCacheStatus {
    const slots = Array.from(this.slots.values());
    const activeSlots = slots.filter((s) => s.is_processing || s.sessionKey);
    const idleSlots = slots.filter((s) => !s.is_processing && !s.sessionKey);

    // Estimate memory usage (rough: 0.5MB per 1K tokens in q8_0)
    const memoryUsedEstimate = slots.reduce((acc, s) => {
      return acc + (s.tokensUsed ?? 0) * 0.5;
    }, 0);

    return {
      enabled: this.config.enabled,
      slots,
      totalSlots: slots.length,
      activeSlots: activeSlots.length,
      idleSlots: idleSlots.length,
      memoryUsedEstimate,
      preloadedSessions: Array.from(this.slots.values())
        .filter((s) => s.preloadedFrom && s.preloadedFrom.length > 0)
        .map((s) => s.sessionKey)
        .filter((v): v is string => v !== undefined),
    };
  }

  getSlotForSession(sessionKey: string): number | undefined {
    return this.sessionToSlot.get(sessionKey);
  }
}

// ============================================================================
// Factory
// ============================================================================

export async function createKvCacheManager(params: {
  cfg: OpenClawConfig | undefined;
  memoryManager?: MemorySearchManager;
}): Promise<KvCacheManager | null> {
  const config = resolveKvCacheConfig(params.cfg);

  if (!config.enabled) {
    return null;
  }

  const manager = new KvCacheManager({
    config,
    memoryManager: params.memoryManager,
  });

  await manager.initialize();
  return manager;
}
