import { extractMessageText } from "./utils.js";
function formatUd(id) {
  const str = String(id).replace(/\./g, "");
  const reversed = str.split("").toReversed();
  const chunks = [];
  for (let i = 0; i < reversed.length; i += 3) {
    chunks.push(
      reversed.slice(i, i + 3).toReversed().join("")
    );
  }
  return chunks.toReversed().join(".");
}
const messageCache = /* @__PURE__ */ new Map();
const MAX_CACHED_MESSAGES = 100;
function cacheMessage(channelNest, message) {
  if (!messageCache.has(channelNest)) {
    messageCache.set(channelNest, []);
  }
  const cache = messageCache.get(channelNest);
  if (!cache) {
    return;
  }
  cache.unshift(message);
  if (cache.length > MAX_CACHED_MESSAGES) {
    cache.pop();
  }
}
async function fetchChannelHistory(api, channelNest, count = 50, runtime) {
  try {
    const scryPath = `/channels/v4/${channelNest}/posts/newest/${count}/outline.json`;
    runtime?.log?.(`[tlon] Fetching history: ${scryPath}`);
    const data = await api.scry(scryPath);
    if (!data) {
      return [];
    }
    let posts = [];
    if (Array.isArray(data)) {
      posts = data;
    } else if (data.posts && typeof data.posts === "object") {
      posts = Object.values(data.posts);
    } else if (typeof data === "object") {
      posts = Object.values(data);
    }
    const messages = posts.map((item) => {
      const essay = item.essay || item["r-post"]?.set?.essay;
      const seal = item.seal || item["r-post"]?.set?.seal;
      return {
        author: essay?.author || "unknown",
        content: extractMessageText(essay?.content || []),
        timestamp: essay?.sent || Date.now(),
        id: seal?.id
      };
    }).filter((msg) => msg.content);
    runtime?.log?.(`[tlon] Extracted ${messages.length} messages from history`);
    return messages;
  } catch (error) {
    runtime?.log?.(`[tlon] Error fetching channel history: ${error?.message ?? String(error)}`);
    return [];
  }
}
async function getChannelHistory(api, channelNest, count = 50, runtime) {
  const cache = messageCache.get(channelNest) ?? [];
  if (cache.length >= count) {
    runtime?.log?.(`[tlon] Using cached messages (${cache.length} available)`);
    return cache.slice(0, count);
  }
  runtime?.log?.(`[tlon] Cache has ${cache.length} messages, need ${count}, fetching from scry...`);
  return await fetchChannelHistory(api, channelNest, count, runtime);
}
async function fetchThreadHistory(api, channelNest, parentId, count = 50, runtime) {
  try {
    const formattedParentId = formatUd(parentId);
    runtime?.log?.(
      `[tlon] Thread history - parentId: ${parentId} -> formatted: ${formattedParentId}`
    );
    const scryPath = `/channels/v4/${channelNest}/posts/post/id/${formattedParentId}/replies/newest/${count}.json`;
    runtime?.log?.(`[tlon] Fetching thread history: ${scryPath}`);
    const data = await api.scry(scryPath);
    if (!data) {
      runtime?.log?.(`[tlon] No thread history data returned`);
      return [];
    }
    let replies = [];
    if (Array.isArray(data)) {
      replies = data;
    } else if (data.replies && Array.isArray(data.replies)) {
      replies = data.replies;
    } else if (typeof data === "object") {
      replies = Object.values(data);
    }
    const messages = replies.map((item) => {
      const memo = item.memo || item["r-reply"]?.set?.memo || item;
      const seal = item.seal || item["r-reply"]?.set?.seal;
      return {
        author: memo?.author || "unknown",
        content: extractMessageText(memo?.content || []),
        timestamp: memo?.sent || Date.now(),
        id: seal?.id || item.id
      };
    }).filter((msg) => msg.content);
    runtime?.log?.(`[tlon] Extracted ${messages.length} thread replies from history`);
    return messages;
  } catch (error) {
    runtime?.log?.(`[tlon] Error fetching thread history: ${error?.message ?? String(error)}`);
    try {
      const altPath = `/channels/v4/${channelNest}/posts/post/id/${formatUd(parentId)}.json`;
      runtime?.log?.(`[tlon] Trying alternate path: ${altPath}`);
      const data = await api.scry(altPath);
      if (data?.seal?.meta?.replyCount > 0 && data?.replies) {
        const replies = Array.isArray(data.replies) ? data.replies : Object.values(data.replies);
        const messages = replies.map((reply) => ({
          author: reply.memo?.author || "unknown",
          content: extractMessageText(reply.memo?.content || []),
          timestamp: reply.memo?.sent || Date.now(),
          id: reply.seal?.id
        })).filter((msg) => msg.content);
        runtime?.log?.(`[tlon] Extracted ${messages.length} replies from post data`);
        return messages;
      }
    } catch (altError) {
      runtime?.log?.(`[tlon] Alternate path also failed: ${altError?.message ?? String(altError)}`);
    }
    return [];
  }
}
export {
  cacheMessage,
  fetchChannelHistory,
  fetchThreadHistory,
  getChannelHistory
};
