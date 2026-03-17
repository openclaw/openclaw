import { resolveGlobalMap } from "../../../src/shared/global-singleton.js";
const TTL_MS = 24 * 60 * 60 * 1e3;
const MAX_ENTRIES = 5e3;
const SLACK_THREAD_PARTICIPATION_KEY = /* @__PURE__ */ Symbol.for("openclaw.slackThreadParticipation");
const threadParticipation = resolveGlobalMap(SLACK_THREAD_PARTICIPATION_KEY);
function makeKey(accountId, channelId, threadTs) {
  return `${accountId}:${channelId}:${threadTs}`;
}
function evictExpired() {
  const now = Date.now();
  for (const [key, timestamp] of threadParticipation) {
    if (now - timestamp > TTL_MS) {
      threadParticipation.delete(key);
    }
  }
}
function evictOldest() {
  const oldest = threadParticipation.keys().next().value;
  if (oldest) {
    threadParticipation.delete(oldest);
  }
}
function recordSlackThreadParticipation(accountId, channelId, threadTs) {
  if (!accountId || !channelId || !threadTs) {
    return;
  }
  if (threadParticipation.size >= MAX_ENTRIES) {
    evictExpired();
  }
  if (threadParticipation.size >= MAX_ENTRIES) {
    evictOldest();
  }
  threadParticipation.set(makeKey(accountId, channelId, threadTs), Date.now());
}
function hasSlackThreadParticipation(accountId, channelId, threadTs) {
  if (!accountId || !channelId || !threadTs) {
    return false;
  }
  const key = makeKey(accountId, channelId, threadTs);
  const timestamp = threadParticipation.get(key);
  if (timestamp == null) {
    return false;
  }
  if (Date.now() - timestamp > TTL_MS) {
    threadParticipation.delete(key);
    return false;
  }
  return true;
}
function clearSlackThreadParticipationCache() {
  threadParticipation.clear();
}
export {
  clearSlackThreadParticipationCache,
  hasSlackThreadParticipation,
  recordSlackThreadParticipation
};
