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

type ActiveSnapshot = {
  process: (key: string, task: () => Promise<boolean>) => Promise<boolean>;
};

type ActiveSnapshotTracker = {
  beginSnapshot: (keys: Iterable<string>) => ActiveSnapshot;
};

export function createActiveSnapshotTracker(): ActiveSnapshotTracker {
  type InFlightEntry = { generation: number; promise: Promise<boolean> };

  let nextGeneration = 0;
  let active = new Map<string, number>();
  const processed = new Set<string>();
  const inFlight = new Map<string, InFlightEntry>();

  const process = async (key: string, generation: number, task: () => Promise<boolean>) => {
    while (active.get(key) === generation && !processed.has(key)) {
      const pending = inFlight.get(key);
      if (pending?.generation === generation) {
        try {
          await pending.promise;
        } catch {
          // A waiter in the same active generation gets the retry opportunity.
        }
        continue;
      }

      const current: InFlightEntry = {
        generation,
        promise: Promise.resolve().then(task),
      };
      inFlight.set(key, current);
      try {
        const completed = await current.promise;
        if (completed && active.get(key) === generation) {
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
  };

  return {
    beginSnapshot: (keys) => {
      const snapshotGeneration = ++nextGeneration;
      const nextActive = new Map<string, number>();
      for (const key of new Set(keys)) {
        nextActive.set(key, active.get(key) ?? snapshotGeneration);
      }
      active = nextActive;
      for (const key of processed) {
        if (!active.has(key)) {
          processed.delete(key);
        }
      }
      return {
        process: (key, task) => {
          const generation = nextActive.get(key);
          return generation === undefined ? Promise.resolve(false) : process(key, generation, task);
        },
      };
    },
  };
}
