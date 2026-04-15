type TtlDbEntry<V> = {
  value: V;
  expiresAt: number;
};

/**
 * 轻量内存 TTL KV（类似 Redis 的过期键行为）。
 * 设计约束：
 * - 每次读写都会尝试触发过期清理（受限频控制）
 * - key 过期后视为不存在
 */
export class InMemoryTtlDb<K, V> {
  private readonly ttlMs: number;
  private readonly maxKeys: number;
  private readonly cleanupMinIntervalMs: number;
  private readonly store = new Map<K, TtlDbEntry<V>>();
  private lastCleanupAt = 0;

  constructor(options: { ttlMs: number; maxKeys?: number; cleanupMinIntervalMs?: number }) {
    this.ttlMs = options.ttlMs;
    this.maxKeys = options.maxKeys ?? Number.POSITIVE_INFINITY;
    this.cleanupMinIntervalMs = Math.max(0, options.cleanupMinIntervalMs ?? 5_000); // 默认 5s 清理一次
  }

  has(key: K): boolean {
    this.cleanupExpired();
    return this.getValidEntry(key) !== undefined;
  }

  get(key: K): V | null {
    this.cleanupExpired();
    return this.getValidEntry(key)?.value ?? null;
  }

  set(key: K, value: V): void {
    this.cleanupExpired();
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    this.evictOverflow();
  }

  delete(key: K): boolean {
    this.cleanupExpired();
    return this.store.delete(key);
  }

  size(): number {
    this.cleanupExpired();
    return this.store.size;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    if (now - this.lastCleanupAt < this.cleanupMinIntervalMs) {
      return;
    }

    this.lastCleanupAt = now;
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }

  private getValidEntry(key: K): TtlDbEntry<V> | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  private evictOverflow(): void {
    if (this.store.size <= this.maxKeys) {
      return;
    }
    const overflow = this.store.size - this.maxKeys;
    const keysByExpiryAsc = Array.from(this.store.entries())
      .toSorted((a, b) => a[1].expiresAt - b[1].expiresAt)
      .map(([key]) => key);

    for (let i = 0; i < overflow; i++) {
      const key = keysByExpiryAsc[i];
      if (key === undefined) {
        break;
      }
      this.store.delete(key);
    }
  }
}
