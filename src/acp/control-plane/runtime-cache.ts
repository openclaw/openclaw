import type { AcpRuntime, AcpRuntimeHandle, AcpRuntimeSessionMode } from "../runtime/types.js";

export type CachedRuntimeState = {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  backend: string;
  agent: string;
  mode: AcpRuntimeSessionMode;
  cwd?: string;
  appliedControlSignature?: string;
};

type RuntimeCacheEntry = {
  state: CachedRuntimeState;
  lastTouchedAt: number;
};

export type CachedRuntimeSnapshot = {
  actorKey: string;
  state: CachedRuntimeState;
  lastTouchedAt: number;
  idleMs: number;
};

const DEFAULT_RUNTIME_CACHE_MAX_ENTRIES = 500;

export class RuntimeCache {
  private readonly cache = new Map<string, RuntimeCacheEntry>();
  private readonly maxEntries: number;

  constructor(params: { maxEntries?: number } = {}) {
    this.maxEntries =
      Number.isFinite(params.maxEntries) && (params.maxEntries ?? 0) > 0
        ? Math.floor(params.maxEntries ?? 0)
        : DEFAULT_RUNTIME_CACHE_MAX_ENTRIES;
  }

  size(): number {
    return this.cache.size;
  }

  has(actorKey: string): boolean {
    return this.cache.has(actorKey);
  }

  get(
    actorKey: string,
    params: {
      touch?: boolean;
      now?: number;
    } = {},
  ): CachedRuntimeState | null {
    const entry = this.cache.get(actorKey);
    if (!entry) {
      return null;
    }
    if (params.touch !== false) {
      entry.lastTouchedAt = params.now ?? Date.now();
    }
    return entry.state;
  }

  peek(actorKey: string): CachedRuntimeState | null {
    return this.get(actorKey, { touch: false });
  }

  getLastTouchedAt(actorKey: string): number | null {
    return this.cache.get(actorKey)?.lastTouchedAt ?? null;
  }

  private pruneOverflow(): void {
    while (this.cache.size > this.maxEntries) {
      let oldestKey: string | null = null;
      let oldestTouchedAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.cache.entries()) {
        if (entry.lastTouchedAt < oldestTouchedAt) {
          oldestTouchedAt = entry.lastTouchedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) {
        return;
      }
      this.cache.delete(oldestKey);
    }
  }

  set(
    actorKey: string,
    state: CachedRuntimeState,
    params: {
      now?: number;
    } = {},
  ): void {
    this.cache.set(actorKey, {
      state,
      lastTouchedAt: params.now ?? Date.now(),
    });
    this.pruneOverflow();
  }

  clear(actorKey: string): void {
    this.cache.delete(actorKey);
  }

  snapshot(params: { now?: number } = {}): CachedRuntimeSnapshot[] {
    const now = params.now ?? Date.now();
    const entries: CachedRuntimeSnapshot[] = [];
    for (const [actorKey, entry] of this.cache.entries()) {
      entries.push({
        actorKey,
        state: entry.state,
        lastTouchedAt: entry.lastTouchedAt,
        idleMs: Math.max(0, now - entry.lastTouchedAt),
      });
    }
    return entries;
  }

  collectIdleCandidates(params: { maxIdleMs: number; now?: number }): CachedRuntimeSnapshot[] {
    if (!Number.isFinite(params.maxIdleMs) || params.maxIdleMs <= 0) {
      return [];
    }
    const now = params.now ?? Date.now();
    return this.snapshot({ now }).filter((entry) => entry.idleMs >= params.maxIdleMs);
  }
}
