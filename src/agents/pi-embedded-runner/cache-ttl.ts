type CustomEntryLike = {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
  id?: string;
  parentId?: string;
};

export const CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";

export type CacheTtlEntryData = {
  timestamp: number;
  provider?: string;
  modelId?: string;
};

export function isCacheTtlEligibleProvider(provider: string, modelId: string): boolean {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModelId = modelId.toLowerCase();
  if (normalizedProvider === "anthropic") {
    return true;
  }
  if (normalizedProvider === "openrouter" && normalizedModelId.startsWith("anthropic/")) {
    return true;
  }
  return false;
}

export function readLastCacheTtlTimestamp(sessionManager: unknown): number | null {
  const sm = sessionManager as { getEntries?: () => CustomEntryLike[] };
  if (!sm?.getEntries) {
    return null;
  }
  try {
    const entries = sm.getEntries();

    // Build set of compaction entry IDs to filter out cache-ttl entries
    // that were written immediately after compaction (which can trigger
    // a second compaction that loses context on recovery).
    const compactionIds = new Set<string>();
    for (const entry of entries) {
      if (entry?.type === "compaction" && entry?.id) {
        compactionIds.add(entry.id);
      }
    }

    let last: number | null = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type !== "custom" || entry?.customType !== CACHE_TTL_CUSTOM_TYPE) {
        continue;
      }
      // Skip cache-ttl entries whose parent is a compaction entry
      if (entry.parentId && compactionIds.has(entry.parentId)) {
        continue;
      }
      const data = entry?.data as Partial<CacheTtlEntryData> | undefined;
      const ts = typeof data?.timestamp === "number" ? data.timestamp : null;
      if (ts && Number.isFinite(ts)) {
        last = ts;
        break;
      }
    }
    return last;
  } catch {
    return null;
  }
}

export function appendCacheTtlTimestamp(sessionManager: unknown, data: CacheTtlEntryData): void {
  const sm = sessionManager as {
    appendCustomEntry?: (customType: string, data: unknown) => void;
  };
  if (!sm?.appendCustomEntry) {
    return;
  }
  try {
    sm.appendCustomEntry(CACHE_TTL_CUSTOM_TYPE, data);
  } catch {
    // ignore persistence failures
  }
}
