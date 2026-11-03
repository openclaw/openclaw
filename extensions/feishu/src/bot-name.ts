import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { createFeishuClient } from "./client.js";
import { extractFeishuApiErrorMeta } from "./comment-shared.js";
import type { ResolvedFeishuAccount } from "./types.js";

type FeishuLogger = (...args: unknown[]) => void;
type CacheEntry = { name?: string; expiresAt: number };
type BotBatchResponse = {
  code?: number;
  msg?: string;
  data?: { bots?: Record<string, { name?: string }> };
};

const POSITIVE_TTL_MS = 10 * 60_000;
const NEGATIVE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 5_000;
const LOOKUP_BACKOFF_MS = 60_000;
const REQUEST_TIMEOUT_MS = 1_500;

const cache = new Map<string, CacheEntry>();
const backoffUntilByAccount = new Map<string, number>();
const inflight = new Map<string, Promise<string | undefined>>();

function readCache(key: string): CacheEntry | undefined {
  const entry = cache.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function writeCache(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  pruneMapToMaxSize(cache, MAX_CACHE_ENTRIES);
}

export async function resolveFeishuBotName(params: {
  account: ResolvedFeishuAccount;
  openId: string;
  log: FeishuLogger;
}): Promise<string | undefined> {
  const openId = params.openId.trim();
  if (!params.account.configured || !openId) {
    return undefined;
  }
  const backoffUntil = backoffUntilByAccount.get(params.account.accountId);
  if (backoffUntil !== undefined) {
    if (backoffUntil > Date.now()) {
      return undefined;
    }
    backoffUntilByAccount.delete(params.account.accountId);
  }
  const key = `${params.account.accountId}::${openId}`;
  const cached = readCache(key);
  if (cached) {
    return cached.name;
  }
  const pending = inflight.get(key);
  if (pending) {
    return pending;
  }
  const { account, log } = params;
  const lookup = (async () => {
    const query = new URLSearchParams({ bot_ids: openId });
    let result: BotBatchResponse | null = null;
    try {
      const client = createFeishuClient(account);
      const response = await client.request<BotBatchResponse>({
        method: "GET",
        url: `/open-apis/bot/v3/bots/basic_batch?${query.toString()}`,
        timeout: REQUEST_TIMEOUT_MS,
      });
      const code = response.code ?? 0;
      if (code === 0) {
        result = response;
      } else if (code === 99991672) {
        log(`feishu[${account.accountId}]: bot.basic_info scope not granted`);
      } else {
        log(`feishu[${account.accountId}]: bot name lookup failed (code=${code})`);
      }
    } catch (error) {
      if (extractFeishuApiErrorMeta(error).feishuCode === 99991672) {
        log(`feishu[${account.accountId}]: bot.basic_info scope not granted`);
      } else {
        log(`feishu[${account.accountId}]: bot name lookup failed: ${String(error)}`);
      }
    }
    if (!result) {
      // Optional names use one short cooldown, not an hour-long failure circuit.
      backoffUntilByAccount.set(account.accountId, Date.now() + LOOKUP_BACKOFF_MS);
      return undefined;
    }

    const name = result.data?.bots?.[openId]?.name?.trim();
    writeCache(key, {
      ...(name ? { name } : {}),
      expiresAt: Date.now() + (name ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
    });
    return name;
  })();
  inflight.set(key, lookup);
  try {
    return await lookup;
  } finally {
    inflight.delete(key);
  }
}
