import type { NotificationDigest, TriagedNotification, TriageLevel } from "./types.js";

export type NotificationStoreOptions = {
  maxItems?: number;
  retentionMs?: number;
};

export type NotificationStore = {
  add(items: TriagedNotification[]): void;
  getRecent(sinceMs?: number): TriagedNotification[];
  getByLevel(level: TriageLevel, sinceMs?: number): TriagedNotification[];
  getDigest(sinceMs?: number): NotificationDigest;
  clear(): void;
  stats(): { count: number; oldestMs: number | null; newestMs: number | null };
  gc(): void;
};

export function createNotificationStore(opts?: NotificationStoreOptions): NotificationStore {
  const maxItems = opts?.maxItems ?? 500;
  const retentionMs = opts?.retentionMs ?? 60 * 60 * 1000; // 1 hour default

  /**
   * Indexed by notification id for O(1) deduplication.
   * Insertion order is maintained by the items array; the index maps id -> array position.
   */
  let items: TriagedNotification[] = [];
  const idIndex = new Set<string>();

  function rebuildIndex() {
    idIndex.clear();
    for (const n of items) {
      idIndex.add(n.id);
    }
  }

  function gc() {
    const cutoff = Date.now() - retentionMs;
    items = items.filter((n) => n.timestamp >= cutoff);
    // Enforce max items (keep newest).
    if (items.length > maxItems) {
      items = items.slice(items.length - maxItems);
    }
    rebuildIndex();
  }

  function getRecent(sinceMs?: number): TriagedNotification[] {
    const cutoff = sinceMs ? Date.now() - sinceMs : Date.now() - retentionMs;
    return items.filter((n) => n.timestamp >= cutoff);
  }

  return {
    add(newItems: TriagedNotification[]) {
      if (newItems.length === 0) return;
      for (const n of newItems) {
        if (idIndex.has(n.id)) {
          // Replace existing entry (notification was updated).
          const idx = items.findIndex((existing) => existing.id === n.id);
          if (idx !== -1) {
            items[idx] = n;
          }
        } else {
          items.push(n);
          idIndex.add(n.id);
        }
      }
      gc();
    },

    getRecent,

    getByLevel(level: TriageLevel, sinceMs?: number): TriagedNotification[] {
      return getRecent(sinceMs).filter((n) => n.triageLevel === level);
    },

    getDigest(sinceMs?: number): NotificationDigest {
      const recent = getRecent(sinceMs);
      return {
        generatedAtMs: Date.now(),
        totalCount: recent.length,
        critical: recent.filter((n) => n.triageLevel === "critical"),
        important: recent.filter((n) => n.triageLevel === "important"),
        informational: recent.filter((n) => n.triageLevel === "informational"),
        noise: recent.filter((n) => n.triageLevel === "noise"),
      };
    },

    clear() {
      items = [];
      idIndex.clear();
    },

    stats() {
      if (items.length === 0) return { count: 0, oldestMs: null, newestMs: null };
      return {
        count: items.length,
        oldestMs: items[0]!.timestamp,
        newestMs: items[items.length - 1]!.timestamp,
      };
    },

    gc,
  };
}
