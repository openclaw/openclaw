import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { feishuGroupNameCache } from "./bot-group-name-state.js";
import { getChatInfo } from "./chat.js";
import { createFeishuClient } from "./client.js";
import type { ResolvedFeishuAccount } from "./types.js";

const GROUP_NAME_CACHE_TTL_MS = 30 * 60 * 1000;
const GROUP_NAME_CACHE_MAX_SIZE = 500;

function evictGroupNameCache(): void {
  const now = Date.now();
  for (const [key, value] of feishuGroupNameCache) {
    if (value.expiresAt <= now) {
      feishuGroupNameCache.delete(key);
    }
  }

  pruneMapToMaxSize(feishuGroupNameCache, GROUP_NAME_CACHE_MAX_SIZE);
}

function setCacheEntry(key: string, name: string): void {
  feishuGroupNameCache.delete(key);
  feishuGroupNameCache.set(key, { name, expiresAt: Date.now() + GROUP_NAME_CACHE_TTL_MS });
}

export async function resolveGroupName(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  log: (...args: unknown[]) => void;
}): Promise<string | undefined> {
  const { account, chatId, log } = params;
  if (!account.configured) {
    return undefined;
  }

  const cacheKey = `${account.accountId}:${chatId}`;
  const cached = feishuGroupNameCache.get(cacheKey);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return cached.name || undefined;
    }
    feishuGroupNameCache.delete(cacheKey);
  }

  let resolvedName: string | undefined;
  try {
    const client = createFeishuClient(account);
    const chatInfo = await getChatInfo(client, chatId);
    const name = chatInfo?.name?.trim();
    if (name) {
      setCacheEntry(cacheKey, name);
      resolvedName = name;
    } else {
      setCacheEntry(cacheKey, "");
    }
  } catch (err) {
    log(`feishu[${account.accountId}]: getChatInfo failed for ${chatId}: ${String(err)}`);
    setCacheEntry(cacheKey, "");
  }

  evictGroupNameCache();
  return resolvedName;
}
