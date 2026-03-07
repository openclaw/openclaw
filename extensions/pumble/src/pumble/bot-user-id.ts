import { createPumbleClient, fetchPumbleMe } from "./client.js";
import { resolveBotUserIdFromJwt } from "./jwt.js";

type CacheEntry = { userId: string; expiresAt: number };

const BOT_USER_ID_CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, CacheEntry>();

/**
 * Resolve the bot user ID using a three-step cascade:
 *  1. Explicit `botUserId` config value
 *  2. JWT payload decode (`workspaceUser` / `sub` claim)
 *  3. `/oauth2/me` API call (may 401 on app-scoped tokens)
 *
 * Results are cached per accountId for 10 minutes.
 */
export async function resolveBotUserId(params: {
  accountId: string;
  botToken: string;
  appKey?: string;
  explicitBotUserId?: string;
}): Promise<string | null> {
  // 1. Explicit config
  const explicit = params.explicitBotUserId?.trim();
  if (explicit) {
    cache.set(params.accountId, {
      userId: explicit,
      expiresAt: Date.now() + BOT_USER_ID_CACHE_TTL_MS,
    });
    return explicit;
  }

  // Check cache
  const cached = cache.get(params.accountId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.userId;
  }

  // 2. JWT decode
  const jwtUserId = resolveBotUserIdFromJwt(params.botToken);
  if (jwtUserId) {
    cache.set(params.accountId, {
      userId: jwtUserId,
      expiresAt: Date.now() + BOT_USER_ID_CACHE_TTL_MS,
    });
    return jwtUserId;
  }

  // 3. /oauth2/me API call
  try {
    const client = createPumbleClient({
      botToken: params.botToken,
      appKey: params.appKey,
    });
    const me = await fetchPumbleMe(client);
    const userId = me.id?.trim();
    if (userId) {
      cache.set(params.accountId, { userId, expiresAt: Date.now() + BOT_USER_ID_CACHE_TTL_MS });
      return userId;
    }
  } catch {
    // Non-fatal — caller handles null
  }

  return null;
}

export function resetBotUserIdCacheForTests(): void {
  cache.clear();
}
