export type ProcessedMessageTracker = {
  mark: (id?: string | null) => boolean;
  has: (id?: string | null) => boolean;
  size: () => number;
};

export function createProcessedMessageTracker(limit = 2000): ProcessedMessageTracker {
  const seen = new Set<string>();
  const order: string[] = [];

  const mark = (id?: string | null) => {
    const trimmed = id?.trim();
    if (!trimmed) return true;
    if (seen.has(trimmed)) return false;
    seen.add(trimmed);
    order.push(trimmed);
    if (order.length > limit) {
      const overflow = order.length - limit;
      for (let i = 0; i < overflow; i += 1) {
        const oldest = order.shift();
        if (oldest) seen.delete(oldest);
      }
    }
    return true;
  };

  const has = (id?: string | null) => {
    const trimmed = id?.trim();
    if (!trimmed) return false;
    return seen.has(trimmed);
  };

  return {
    mark,
    has,
    size: () => seen.size,
  };
}
