/**
 * Utility helpers for the WeCom plugin.
 */
export class TTLCache {
  options;
  cache = new Map();
  checkPeriod;
  cleanupTimer;
  constructor(options) {
    this.options = options;
    this.checkPeriod = options.checkPeriod || options.ttl;
    this.startCleanup();
  }
  set(key, value, ttl) {
    const expiresAt = Date.now() + (ttl || this.options.ttl);
    this.cache.set(key, { value, expiresAt });
  }
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }
  has(key) {
    return this.get(key) !== undefined;
  }
  delete(key) {
    return this.cache.delete(key);
  }
  clear() {
    this.cache.clear();
  }
  size() {
    this.cleanup();
    return this.cache.size;
  }
  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
  startCleanup() {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.checkPeriod);
    // Don't prevent process from exiting
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }
  destroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.cache.clear();
  }
}
// ============================================================================
// Message deduplication
// ============================================================================
export class MessageDeduplicator {
  seen = new TTLCache({ ttl: 300000 }); // 5 minutes
  isDuplicate(msgId) {
    if (this.seen.has(msgId)) {
      return true;
    }
    this.seen.set(msgId, true);
    return false;
  }
  markAsSeen(msgId) {
    this.seen.set(msgId, true);
  }
}
// ============================================================================
// Constants
// ============================================================================
export const CONSTANTS = {
  // AES/Crypto
  AES_BLOCK_SIZE: 32,
  AES_KEY_LENGTH: 43,
};
