import { resolveMattermostAccount } from "./accounts.js";
import { createMattermostClient, fetchMattermostMe } from "./client.js";
const BOT_USER_CACHE_TTL_MS = 10 * 6e4;
const botUserIdCache = /* @__PURE__ */ new Map();
async function resolveBotUserId(client, cacheKey) {
  const cached = botUserIdCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.userId;
  }
  const me = await fetchMattermostMe(client);
  const userId = me?.id?.trim();
  if (!userId) {
    return null;
  }
  botUserIdCache.set(cacheKey, { userId, expiresAt: Date.now() + BOT_USER_CACHE_TTL_MS });
  return userId;
}
async function addMattermostReaction(params) {
  return runMattermostReaction(params, {
    action: "add",
    mutation: createReaction
  });
}
async function removeMattermostReaction(params) {
  return runMattermostReaction(params, {
    action: "remove",
    mutation: deleteReaction
  });
}
function resetMattermostReactionBotUserCacheForTests() {
  botUserIdCache.clear();
}
async function runMattermostReaction(params, options) {
  const resolved = resolveMattermostAccount({ cfg: params.cfg, accountId: params.accountId });
  const baseUrl = resolved.baseUrl?.trim();
  const botToken = resolved.botToken?.trim();
  if (!baseUrl || !botToken) {
    return { ok: false, error: "Mattermost botToken/baseUrl missing." };
  }
  const client = createMattermostClient({
    baseUrl,
    botToken,
    fetchImpl: params.fetchImpl
  });
  const cacheKey = `${baseUrl}:${botToken}`;
  const userId = await resolveBotUserId(client, cacheKey);
  if (!userId) {
    return { ok: false, error: "Mattermost reactions failed: could not resolve bot user id." };
  }
  try {
    await options.mutation(client, {
      userId,
      postId: params.postId,
      emojiName: params.emojiName
    });
  } catch (err) {
    return { ok: false, error: `Mattermost ${options.action} reaction failed: ${String(err)}` };
  }
  return { ok: true };
}
async function createReaction(client, params) {
  await client.request("/reactions", {
    method: "POST",
    body: JSON.stringify({
      user_id: params.userId,
      post_id: params.postId,
      emoji_name: params.emojiName
    })
  });
}
async function deleteReaction(client, params) {
  const emoji = encodeURIComponent(params.emojiName);
  await client.request(
    `/users/${params.userId}/posts/${params.postId}/reactions/${emoji}`,
    {
      method: "DELETE"
    }
  );
}
export {
  addMattermostReaction,
  removeMattermostReaction,
  resetMattermostReactionBotUserCacheForTests
};
