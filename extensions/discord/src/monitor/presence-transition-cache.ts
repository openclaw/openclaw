// Discord plugin module tracks recent offline baselines for online transitions.
const DEFAULT_OFFLINE_BASELINE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_OFFLINE_BASELINE_MAX_ENTRIES = 25_000;

export class DiscordOfflinePresenceCache {
  private readonly offlineAtByKey = new Map<string, number>();

  constructor(
    private readonly options: { ttlMs: number; maxEntries: number } = {
      ttlMs: DEFAULT_OFFLINE_BASELINE_TTL_MS,
      maxEntries: DEFAULT_OFFLINE_BASELINE_MAX_ENTRIES,
    },
  ) {}

  clear(): void {
    this.offlineAtByKey.clear();
  }

  delete(key: string): void {
    this.offlineAtByKey.delete(key);
  }

  hasRecentOffline(key: string, nowMs: number): boolean {
    const observedAtMs = this.offlineAtByKey.get(key);
    if (observedAtMs === undefined) {
      return false;
    }
    if (nowMs - observedAtMs >= this.options.ttlMs) {
      this.offlineAtByKey.delete(key);
      return false;
    }
    return true;
  }

  observeOffline(key: string, nowMs: number): void {
    for (const [candidateKey, observedAtMs] of this.offlineAtByKey) {
      if (nowMs - observedAtMs < this.options.ttlMs) {
        break;
      }
      this.offlineAtByKey.delete(candidateKey);
    }
    this.offlineAtByKey.delete(key);
    this.offlineAtByKey.set(key, nowMs);
    while (this.offlineAtByKey.size > this.options.maxEntries) {
      const oldestKey = this.offlineAtByKey.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.offlineAtByKey.delete(oldestKey);
    }
  }
}
