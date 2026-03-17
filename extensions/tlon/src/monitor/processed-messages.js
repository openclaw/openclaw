import { createDedupeCache } from "openclaw/plugin-sdk/tlon";
function createProcessedMessageTracker(limit = 2e3) {
  const dedupe = createDedupeCache({ ttlMs: 0, maxSize: limit });
  const mark = (id) => {
    const trimmed = id?.trim();
    if (!trimmed) {
      return true;
    }
    return !dedupe.check(trimmed);
  };
  const has = (id) => {
    const trimmed = id?.trim();
    if (!trimmed) {
      return false;
    }
    return dedupe.peek(trimmed);
  };
  return {
    mark,
    has,
    size: () => dedupe.size()
  };
}
export {
  createProcessedMessageTracker
};
