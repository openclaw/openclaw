import { createFeishuClient } from "./client.js";
import type { MentionTarget } from "./mention-target.types.js";
import type { ResolvedFeishuAccount } from "./types.js";

type FeishuLogger = (...args: unknown[]) => void;

const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 5000;
const BATCH_SIZE = 10;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 200;
const BREAKER_FAILURE_THRESHOLD = 10;
const BREAKER_OPEN_DURATION_MS = 60 * 60 * 1000;
const BOT_BATCH_TIMEOUT_MS = 30_000;

type CacheEntry = { name?: string; expireAt: number };

// Module-private cache, keyed by `${accountId}::${ou}` so the same `ou_xxx`
// across different feishu apps does not collide. Insertion order doubles as
// LRU position; entries refreshed via delete-then-set.
const nameCache = new Map<string, CacheEntry>();

type BreakerState = { failuresInRow: number; openUntil: number };
const breakerByAccount = new Map<string, BreakerState>();

// In-flight dedup: concurrent resolves for the same ou share one promise.
const inflightByKey = new Map<string, Promise<string | undefined>>();

type BotBatchOk = {
  code?: number;
  msg?: string;
  data?: {
    bots?: Record<string, { bot_id?: string; name?: string; i18n_names?: Record<string, string> }>;
    failed_bots?: Record<string, { code?: number; reason?: string }>;
  };
};
type BotBatchOutcome = BotBatchOk | "permission" | "fatal";

// Generic SDK passthrough — same pattern as comment-reaction.ts, since the
// Lark SDK has no typed wrapper for `bot/v3/bots/basic_batch` yet.
type BotNameClient = ReturnType<typeof createFeishuClient> & {
  request(params: { method: "GET"; url: string; timeout: number }): Promise<unknown>;
};

function cacheKey(accountId: string, ou: string): string {
  return `${accountId}::${ou}`;
}

function getCached(accountId: string, ou: string): CacheEntry | undefined {
  const key = cacheKey(accountId, ou);
  const entry = nameCache.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expireAt <= Date.now()) {
    nameCache.delete(key);
    return undefined;
  }
  // Refresh LRU position.
  nameCache.delete(key);
  nameCache.set(key, entry);
  return entry;
}

function writeCacheEntry(accountId: string, ou: string, entry: CacheEntry): void {
  const key = cacheKey(accountId, ou);
  if (nameCache.has(key)) {
    nameCache.delete(key);
  }
  nameCache.set(key, entry);
  while (nameCache.size > CACHE_MAX_ENTRIES) {
    const oldest = nameCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    nameCache.delete(oldest);
  }
}

function setHit(accountId: string, ou: string, name: string): void {
  writeCacheEntry(accountId, ou, { name, expireAt: Date.now() + POSITIVE_TTL_MS });
}

function setMiss(accountId: string, ou: string): void {
  writeCacheEntry(accountId, ou, { expireAt: Date.now() + NEGATIVE_TTL_MS });
}

function isBreakerOpen(accountId: string): boolean {
  const state = breakerByAccount.get(accountId);
  if (!state) {
    return false;
  }
  if (state.openUntil > Date.now()) {
    return true;
  }
  if (state.openUntil > 0) {
    // Window expired; reset for the half-open probe attempt.
    state.openUntil = 0;
    state.failuresInRow = 0;
  }
  return false;
}

function recordSuccess(accountId: string): void {
  const state = breakerByAccount.get(accountId);
  if (state) {
    state.failuresInRow = 0;
  }
}

function recordFailure(accountId: string): void {
  const state = breakerByAccount.get(accountId) ?? { failuresInRow: 0, openUntil: 0 };
  state.failuresInRow += 1;
  if (state.failuresInRow >= BREAKER_FAILURE_THRESHOLD) {
    state.openUntil = Date.now() + BREAKER_OPEN_DURATION_MS;
    state.failuresInRow = 0;
  }
  breakerByAccount.set(accountId, state);
}

function extractFeishuErrorCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const data = (err as { response?: { data?: unknown } }).response?.data;
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const code = (data as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildBatchUrl(ous: string[]): string {
  // The OpenAPI requires repeated `bot_ids` query keys, which the shared
  // encodeQuery helper cannot express (single value per key).
  const search = new URLSearchParams();
  for (const ou of ous) {
    search.append("bot_ids", ou);
  }
  return `/open-apis/bot/v3/bots/basic_batch?${search.toString()}`;
}

async function callBotBatchOnce(params: {
  account: ResolvedFeishuAccount;
  ous: string[];
  log: FeishuLogger;
}): Promise<BotBatchOutcome> {
  const { account, ous, log } = params;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const client = createFeishuClient(account) as BotNameClient;
      const resp = (await client.request({
        method: "GET",
        url: buildBatchUrl(ous),
        timeout: BOT_BATCH_TIMEOUT_MS,
      })) as BotBatchOk;
      const code = resp.code ?? 0;
      if (code === 0) {
        return resp;
      }
      if (code === 20005 || code === 20006) {
        // Internal error — retry with exponential backoff.
        lastErr = new Error(`feishu bot batch internal error code=${code}`);
        if (attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_BASE_MS * 2 ** attempt);
          continue;
        }
        log(
          `feishu[${account.accountId}]: bot batch failed after ${MAX_RETRIES} attempts (code=${code})`,
        );
        return "fatal";
      }
      if (code === 20001) {
        // Caller bug — we control batch size <=10, this should never fire.
        log(`feishu[${account.accountId}]: bot batch over limit (ous=${ous.length})`);
        return "fatal";
      }
      // Other unexpected batch-level codes.
      log(`feishu[${account.accountId}]: bot batch unexpected code=${code} msg=${resp.msg ?? ""}`);
      return "fatal";
    } catch (err) {
      lastErr = err;
      const code = extractFeishuErrorCode(err);
      if (code === 99991672) {
        // Scope not granted — silent per weak-dependency principle.
        log(`feishu[${account.accountId}]: bot.basic_info scope not granted (silent)`);
        return "permission";
      }
      if (attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      log(`feishu[${account.accountId}]: bot batch failed after retries: ${String(lastErr)}`);
      return "fatal";
    }
  }
  return "fatal";
}

export async function resolveFeishuBotNames(params: {
  account: ResolvedFeishuAccount;
  openIds: string[];
  log: FeishuLogger;
}): Promise<Map<string, string>> {
  const { account, openIds, log } = params;
  const result = new Map<string, string>();
  if (!account.configured || openIds.length === 0) {
    return result;
  }
  const accountId = account.accountId;

  const seen = new Set<string>();
  const toFetch: string[] = [];
  for (const raw of openIds) {
    const ou = raw.trim();
    if (!ou || seen.has(ou)) {
      continue;
    }
    seen.add(ou);
    const cached = getCached(accountId, ou);
    if (cached) {
      if (cached.name) {
        result.set(ou, cached.name);
      }
      continue;
    }
    toFetch.push(ou);
  }

  if (toFetch.length === 0) {
    return result;
  }
  if (isBreakerOpen(accountId)) {
    log(`feishu[${accountId}]: bot name resolution short-circuited (breaker open)`);
    return result;
  }

  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const chunk = toFetch.slice(i, i + BATCH_SIZE);
    const outcome = await callBotBatchOnce({ account, ous: chunk, log });
    if (outcome === "permission") {
      // Silent: no negative cache so granting the scope takes effect immediately.
      // Permission errors do count toward the breaker so a persistently un-granted
      // scope eventually short-circuits the noise.
      recordFailure(accountId);
      continue;
    }
    if (outcome === "fatal") {
      recordFailure(accountId);
      continue;
    }
    recordSuccess(accountId);
    const bots = outcome.data?.bots ?? {};
    const failed = outcome.data?.failed_bots ?? {};
    for (const ou of chunk) {
      const hit = bots[ou];
      if (hit?.name) {
        setHit(accountId, ou, hit.name);
        result.set(ou, hit.name);
        continue;
      }
      if (failed[ou]) {
        // 20002 NotFound / 20003 CrossTenant / 20004 InvalidOpenID — collapse
        // into a 60s negative cache so a busy chat stops re-querying.
        setMiss(accountId, ou);
      }
      // Not in bots and not in failed_bots: server returned partial data;
      // skip caching so the next call retries.
    }
  }

  return result;
}

export async function resolveFeishuBotName(params: {
  account: ResolvedFeishuAccount;
  openId: string;
  log: FeishuLogger;
}): Promise<string | undefined> {
  const ou = params.openId.trim();
  if (!ou) {
    return undefined;
  }
  const key = cacheKey(params.account.accountId, ou);
  const inflight = inflightByKey.get(key);
  if (inflight) {
    return inflight;
  }
  const promise = (async () => {
    const map = await resolveFeishuBotNames({
      account: params.account,
      openIds: [ou],
      log: params.log,
    });
    return map.get(ou);
  })();
  inflightByKey.set(key, promise);
  try {
    return await promise;
  } finally {
    inflightByKey.delete(key);
  }
}

export async function enrichMentionBotNames(params: {
  account: ResolvedFeishuAccount;
  targets: MentionTarget[];
  log: FeishuLogger;
}): Promise<void> {
  const { account, targets, log } = params;
  const needFill = targets.filter(
    (t) => t.mentionedType === "bot" && !t.name?.trim() && Boolean(t.openId),
  );
  if (needFill.length === 0) {
    return;
  }
  const map = await resolveFeishuBotNames({
    account,
    openIds: needFill.map((t) => t.openId),
    log,
  });
  for (const t of needFill) {
    const name = map.get(t.openId.trim());
    if (name) {
      t.name = name;
    }
  }
}

// Test-only helpers. Exported so unit tests can reset cache/breaker state
// between cases without exposing the underlying maps.
export function resetBotNameStateForTests(): void {
  nameCache.clear();
  breakerByAccount.clear();
  inflightByKey.clear();
}
