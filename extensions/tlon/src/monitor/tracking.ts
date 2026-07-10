// Tlon monitor module owns bounded and snapshot-scoped identifier tracking.
import { createDedupeCache } from "../../runtime-api.js";

export const TLON_PARTICIPATED_THREAD_LIMIT = 2000;

type ParticipatedThreadTracker = {
  add: (parentId: string) => void;
  has: (parentId: string) => boolean;
  size: () => number;
};

export function createParticipatedThreadTracker(
  limit = TLON_PARTICIPATED_THREAD_LIMIT,
): ParticipatedThreadTracker {
  const cache = createDedupeCache({ ttlMs: 0, maxSize: limit });

  return {
    add: (parentId) => {
      cache.check(parentId);
    },
    has: (parentId) => {
      if (!cache.peek(parentId)) {
        return false;
      }
      // Active thread replies refresh recency before older participation is evicted.
      cache.check(parentId);
      return true;
    },
    size: () => cache.size(),
  };
}

type ActiveSnapshotTracker = {
  beginSnapshot: (keys: Iterable<string>) => void;
  process: (key: string, task: () => Promise<boolean>) => Promise<boolean>;
};

export function createActiveSnapshotTracker(): ActiveSnapshotTracker {
  let active = new Set<string>();
  const processed = new Set<string>();
  const inFlight = new Map<string, Promise<boolean>>();

  return {
    beginSnapshot: (keys) => {
      active = new Set(keys);
      for (const key of processed) {
        if (!active.has(key)) {
          processed.delete(key);
        }
      }
    },
    process: async (key, task) => {
      while (active.has(key) && !processed.has(key)) {
        const pending = inFlight.get(key);
        if (pending) {
          try {
            await pending;
          } catch {
            // A newer snapshot waiting on failed work gets the retry opportunity.
          }
          continue;
        }

        const current = Promise.resolve().then(task);
        inFlight.set(key, current);
        try {
          const completed = await current;
          if (completed && active.has(key)) {
            processed.add(key);
          }
          return completed;
        } finally {
          if (inFlight.get(key) === current) {
            inFlight.delete(key);
          }
        }
      }
      return false;
    },
  };
}
