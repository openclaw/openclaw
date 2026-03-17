import { createHash } from "node:crypto";
import { formatIMessageChatTarget } from "../targets.js";
const SELF_CHAT_TTL_MS = 1e4;
const MAX_SELF_CHAT_CACHE_ENTRIES = 512;
const CLEANUP_MIN_INTERVAL_MS = 1e3;
function normalizeText(text) {
  if (!text) {
    return null;
  }
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  return normalized ? normalized : null;
}
function isUsableTimestamp(createdAt) {
  return typeof createdAt === "number" && Number.isFinite(createdAt);
}
function digestText(text) {
  return createHash("sha256").update(text).digest("hex");
}
function buildScope(parts) {
  if (!parts.isGroup) {
    return `${parts.accountId}:imessage:${parts.sender}`;
  }
  const chatTarget = formatIMessageChatTarget(parts.chatId) || "chat_id:unknown";
  return `${parts.accountId}:${chatTarget}:imessage:${parts.sender}`;
}
class DefaultSelfChatCache {
  constructor() {
    this.cache = /* @__PURE__ */ new Map();
    this.lastCleanupAt = 0;
  }
  buildKey(lookup) {
    const text = normalizeText(lookup.text);
    if (!text || !isUsableTimestamp(lookup.createdAt)) {
      return null;
    }
    return `${buildScope(lookup)}:${lookup.createdAt}:${digestText(text)}`;
  }
  remember(lookup) {
    const key = this.buildKey(lookup);
    if (!key) {
      return;
    }
    this.cache.set(key, Date.now());
    this.maybeCleanup();
  }
  has(lookup) {
    this.maybeCleanup();
    const key = this.buildKey(lookup);
    if (!key) {
      return false;
    }
    const timestamp = this.cache.get(key);
    return typeof timestamp === "number" && Date.now() - timestamp <= SELF_CHAT_TTL_MS;
  }
  maybeCleanup() {
    const now = Date.now();
    if (now - this.lastCleanupAt < CLEANUP_MIN_INTERVAL_MS) {
      return;
    }
    this.lastCleanupAt = now;
    for (const [key, timestamp] of this.cache.entries()) {
      if (now - timestamp > SELF_CHAT_TTL_MS) {
        this.cache.delete(key);
      }
    }
    while (this.cache.size > MAX_SELF_CHAT_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (typeof oldestKey !== "string") {
        break;
      }
      this.cache.delete(oldestKey);
    }
  }
}
function createSelfChatCache() {
  return new DefaultSelfChatCache();
}
export {
  createSelfChatCache
};
