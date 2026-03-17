import { createDedupeCache } from "../../../../src/infra/dedupe.js";
const RECENT_WEB_MESSAGE_TTL_MS = 20 * 6e4;
const RECENT_WEB_MESSAGE_MAX = 5e3;
const recentInboundMessages = createDedupeCache({
  ttlMs: RECENT_WEB_MESSAGE_TTL_MS,
  maxSize: RECENT_WEB_MESSAGE_MAX
});
function resetWebInboundDedupe() {
  recentInboundMessages.clear();
}
function isRecentInboundMessage(key) {
  return recentInboundMessages.check(key);
}
export {
  isRecentInboundMessage,
  resetWebInboundDedupe
};
