const DEFAULT_WINDOW_MS = 6e4;
const DEFAULT_MAX_HITS = 5;
const CLEANUP_INTERVAL_MS = 12e4;
function createLoopRateLimiter(opts) {
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const maxHits = opts?.maxHits ?? DEFAULT_MAX_HITS;
  const conversations = /* @__PURE__ */ new Map();
  let lastCleanup = Date.now();
  function cleanup() {
    const now = Date.now();
    if (now - lastCleanup < CLEANUP_INTERVAL_MS) {
      return;
    }
    lastCleanup = now;
    for (const [key, win] of conversations.entries()) {
      const recent = win.timestamps.filter((ts) => now - ts <= windowMs);
      if (recent.length === 0) {
        conversations.delete(key);
      } else {
        win.timestamps = recent;
      }
    }
  }
  return {
    record(conversationKey) {
      cleanup();
      let win = conversations.get(conversationKey);
      if (!win) {
        win = { timestamps: [] };
        conversations.set(conversationKey, win);
      }
      win.timestamps.push(Date.now());
    },
    isRateLimited(conversationKey) {
      cleanup();
      const win = conversations.get(conversationKey);
      if (!win) {
        return false;
      }
      const now = Date.now();
      const recent = win.timestamps.filter((ts) => now - ts <= windowMs);
      win.timestamps = recent;
      return recent.length >= maxHits;
    }
  };
}
export {
  createLoopRateLimiter
};
