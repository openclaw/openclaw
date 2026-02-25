/**
 * LRU-based dedup tracker for incoming NKN message IDs.
 * Prevents duplicate processing when the same message arrives
 * via multiple NKN sub-clients.
 */
export class SeenTracker {
  private seen: Map<string, true>;
  private maxSize: number;

  constructor(maxSize = 10_000) {
    this.seen = new Map();
    this.maxSize = maxSize;
  }

  /** Returns true if the ID was already seen. */
  hasSeen(id: string): boolean {
    return this.seen.has(id);
  }

  /** Mark an ID as seen. Evicts oldest entries if over capacity. */
  markSeen(id: string): void {
    if (this.seen.has(id)) {
      // Move to end (most recent) by deleting and re-inserting
      this.seen.delete(id);
    }
    this.seen.set(id, true);
    this.evict();
  }

  /** Check + mark in one call. Returns true if already seen. */
  checkAndMark(id: string): boolean {
    if (this.seen.has(id)) {
      return true;
    }
    this.markSeen(id);
    return false;
  }

  get size(): number {
    return this.seen.size;
  }

  clear(): void {
    this.seen.clear();
  }

  private evict(): void {
    while (this.seen.size > this.maxSize) {
      // Map iterates in insertion order; first key is oldest
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
  }
}
