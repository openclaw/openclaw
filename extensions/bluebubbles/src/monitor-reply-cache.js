const REPLY_CACHE_MAX = 2e3;
const REPLY_CACHE_TTL_MS = 6 * 60 * 60 * 1e3;
const blueBubblesReplyCacheByMessageId = /* @__PURE__ */ new Map();
const blueBubblesShortIdToUuid = /* @__PURE__ */ new Map();
const blueBubblesUuidToShortId = /* @__PURE__ */ new Map();
let blueBubblesShortIdCounter = 0;
function trimOrUndefined(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : void 0;
}
function generateShortId() {
  blueBubblesShortIdCounter += 1;
  return String(blueBubblesShortIdCounter);
}
function rememberBlueBubblesReplyCache(entry) {
  const messageId = entry.messageId.trim();
  if (!messageId) {
    return { ...entry, shortId: "" };
  }
  let shortId = blueBubblesUuidToShortId.get(messageId);
  if (!shortId) {
    shortId = generateShortId();
    blueBubblesShortIdToUuid.set(shortId, messageId);
    blueBubblesUuidToShortId.set(messageId, shortId);
  }
  const fullEntry = { ...entry, messageId, shortId };
  blueBubblesReplyCacheByMessageId.delete(messageId);
  blueBubblesReplyCacheByMessageId.set(messageId, fullEntry);
  const cutoff = Date.now() - REPLY_CACHE_TTL_MS;
  for (const [key, value] of blueBubblesReplyCacheByMessageId) {
    if (value.timestamp < cutoff) {
      blueBubblesReplyCacheByMessageId.delete(key);
      if (value.shortId) {
        blueBubblesShortIdToUuid.delete(value.shortId);
        blueBubblesUuidToShortId.delete(key);
      }
      continue;
    }
    break;
  }
  while (blueBubblesReplyCacheByMessageId.size > REPLY_CACHE_MAX) {
    const oldest = blueBubblesReplyCacheByMessageId.keys().next().value;
    if (!oldest) {
      break;
    }
    const oldEntry = blueBubblesReplyCacheByMessageId.get(oldest);
    blueBubblesReplyCacheByMessageId.delete(oldest);
    if (oldEntry?.shortId) {
      blueBubblesShortIdToUuid.delete(oldEntry.shortId);
      blueBubblesUuidToShortId.delete(oldest);
    }
  }
  return fullEntry;
}
function resolveBlueBubblesMessageId(shortOrUuid, opts) {
  const trimmed = shortOrUuid.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (/^\d+$/.test(trimmed)) {
    const uuid = blueBubblesShortIdToUuid.get(trimmed);
    if (uuid) {
      return uuid;
    }
    if (opts?.requireKnownShortId) {
      throw new Error(
        `BlueBubbles short message id "${trimmed}" is no longer available. Use MessageSidFull.`
      );
    }
  }
  return trimmed;
}
function _resetBlueBubblesShortIdState() {
  blueBubblesShortIdToUuid.clear();
  blueBubblesUuidToShortId.clear();
  blueBubblesReplyCacheByMessageId.clear();
  blueBubblesShortIdCounter = 0;
}
function getShortIdForUuid(uuid) {
  return blueBubblesUuidToShortId.get(uuid.trim());
}
function resolveReplyContextFromCache(params) {
  const replyToId = params.replyToId.trim();
  if (!replyToId) {
    return null;
  }
  const cached = blueBubblesReplyCacheByMessageId.get(replyToId);
  if (!cached) {
    return null;
  }
  if (cached.accountId !== params.accountId) {
    return null;
  }
  const cutoff = Date.now() - REPLY_CACHE_TTL_MS;
  if (cached.timestamp < cutoff) {
    blueBubblesReplyCacheByMessageId.delete(replyToId);
    return null;
  }
  const chatGuid = trimOrUndefined(params.chatGuid);
  const chatIdentifier = trimOrUndefined(params.chatIdentifier);
  const cachedChatGuid = trimOrUndefined(cached.chatGuid);
  const cachedChatIdentifier = trimOrUndefined(cached.chatIdentifier);
  const chatId = typeof params.chatId === "number" ? params.chatId : void 0;
  const cachedChatId = typeof cached.chatId === "number" ? cached.chatId : void 0;
  if (chatGuid && cachedChatGuid && chatGuid !== cachedChatGuid) {
    return null;
  }
  if (!chatGuid && chatIdentifier && cachedChatIdentifier && chatIdentifier !== cachedChatIdentifier) {
    return null;
  }
  if (!chatGuid && !chatIdentifier && chatId && cachedChatId && chatId !== cachedChatId) {
    return null;
  }
  return cached;
}
export {
  _resetBlueBubblesShortIdState,
  getShortIdForUuid,
  rememberBlueBubblesReplyCache,
  resolveBlueBubblesMessageId,
  resolveReplyContextFromCache
};
