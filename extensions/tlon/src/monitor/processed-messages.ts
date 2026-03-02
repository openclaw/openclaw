import { createDedupeCache } from "openclaw/plugin-sdk";

export type ProcessedMessageTracker = {
  mark: (id?: string | null) => boolean;
  has: (id?: string | null) => boolean;
  size: () => number;
};

export function createProcessedMessageTracker(limit = 2000): ProcessedMessageTracker {
  const dedupe = createDedupeCache({ ttlMs: 0, maxSize: limit });

  const mark = (id?: string | null) => {
    const trimmed = id?.trim();
    if (!trimmed) {
      return true;
    }
    return !dedupe.check(trimmed);
  };

  const has = (id?: string | null) => {
    const trimmed = id?.trim();
    if (!trimmed) {
      return false;
    }
    return dedupe.peek(trimmed);
  };

  return {
    mark,
    has,
    size: () => dedupe.size(),
  };
}
