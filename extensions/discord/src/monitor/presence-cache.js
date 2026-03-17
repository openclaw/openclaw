const MAX_PRESENCE_PER_ACCOUNT = 5e3;
const presenceCache = /* @__PURE__ */ new Map();
function resolveAccountKey(accountId) {
  return accountId ?? "default";
}
function setPresence(accountId, userId, data) {
  const accountKey = resolveAccountKey(accountId);
  let accountCache = presenceCache.get(accountKey);
  if (!accountCache) {
    accountCache = /* @__PURE__ */ new Map();
    presenceCache.set(accountKey, accountCache);
  }
  accountCache.set(userId, data);
  if (accountCache.size > MAX_PRESENCE_PER_ACCOUNT) {
    const oldest = accountCache.keys().next().value;
    if (oldest !== void 0) {
      accountCache.delete(oldest);
    }
  }
}
function getPresence(accountId, userId) {
  return presenceCache.get(resolveAccountKey(accountId))?.get(userId);
}
function clearPresences(accountId) {
  if (accountId) {
    presenceCache.delete(resolveAccountKey(accountId));
    return;
  }
  presenceCache.clear();
}
function presenceCacheSize() {
  let total = 0;
  for (const accountCache of presenceCache.values()) {
    total += accountCache.size;
  }
  return total;
}
export {
  clearPresences,
  getPresence,
  presenceCacheSize,
  setPresence
};
