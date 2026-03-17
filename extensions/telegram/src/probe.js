import { fetchWithTimeout } from "../../../src/utils/fetch-timeout.js";
import { resolveTelegramFetch } from "./fetch.js";
import { makeProxyFetch } from "./proxy.js";
const TELEGRAM_API_BASE = "https://api.telegram.org";
const probeFetcherCache = /* @__PURE__ */ new Map();
const MAX_PROBE_FETCHER_CACHE_SIZE = 64;
function resetTelegramProbeFetcherCacheForTests() {
  probeFetcherCache.clear();
}
function resolveProbeOptions(proxyOrOptions) {
  if (!proxyOrOptions) {
    return void 0;
  }
  if (typeof proxyOrOptions === "string") {
    return { proxyUrl: proxyOrOptions };
  }
  return proxyOrOptions;
}
function shouldUseProbeFetcherCache() {
  return !process.env.VITEST && process.env.NODE_ENV !== "test";
}
function buildProbeFetcherCacheKey(token, options) {
  const cacheIdentity = options?.accountId?.trim() || token;
  const cacheIdentityKind = options?.accountId?.trim() ? "account" : "token";
  const proxyKey = options?.proxyUrl?.trim() ?? "";
  const autoSelectFamily = options?.network?.autoSelectFamily;
  const autoSelectFamilyKey = typeof autoSelectFamily === "boolean" ? String(autoSelectFamily) : "default";
  const dnsResultOrderKey = options?.network?.dnsResultOrder ?? "default";
  return `${cacheIdentityKind}:${cacheIdentity}::${proxyKey}::${autoSelectFamilyKey}::${dnsResultOrderKey}`;
}
function setCachedProbeFetcher(cacheKey, fetcher) {
  probeFetcherCache.set(cacheKey, fetcher);
  if (probeFetcherCache.size > MAX_PROBE_FETCHER_CACHE_SIZE) {
    const oldestKey = probeFetcherCache.keys().next().value;
    if (oldestKey !== void 0) {
      probeFetcherCache.delete(oldestKey);
    }
  }
  return fetcher;
}
function resolveProbeFetcher(token, options) {
  const cacheEnabled = shouldUseProbeFetcherCache();
  const cacheKey = cacheEnabled ? buildProbeFetcherCacheKey(token, options) : null;
  if (cacheKey) {
    const cachedFetcher = probeFetcherCache.get(cacheKey);
    if (cachedFetcher) {
      return cachedFetcher;
    }
  }
  const proxyUrl = options?.proxyUrl?.trim();
  const proxyFetch = proxyUrl ? makeProxyFetch(proxyUrl) : void 0;
  const resolved = resolveTelegramFetch(proxyFetch, { network: options?.network });
  if (cacheKey) {
    return setCachedProbeFetcher(cacheKey, resolved);
  }
  return resolved;
}
async function probeTelegram(token, timeoutMs, proxyOrOptions) {
  const started = Date.now();
  const timeoutBudgetMs = Math.max(1, Math.floor(timeoutMs));
  const deadlineMs = started + timeoutBudgetMs;
  const options = resolveProbeOptions(proxyOrOptions);
  const fetcher = resolveProbeFetcher(token, options);
  const base = `${TELEGRAM_API_BASE}/bot${token}`;
  const retryDelayMs = Math.max(50, Math.min(1e3, Math.floor(timeoutBudgetMs / 5)));
  const resolveRemainingBudgetMs = () => Math.max(0, deadlineMs - Date.now());
  const result = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0
  };
  try {
    let meRes = null;
    let fetchError = null;
    for (let i = 0; i < 3; i++) {
      const remainingBudgetMs = resolveRemainingBudgetMs();
      if (remainingBudgetMs <= 0) {
        break;
      }
      try {
        meRes = await fetchWithTimeout(
          `${base}/getMe`,
          {},
          Math.max(1, Math.min(timeoutBudgetMs, remainingBudgetMs)),
          fetcher
        );
        break;
      } catch (err) {
        fetchError = err;
        if (i < 2) {
          const remainingAfterAttemptMs = resolveRemainingBudgetMs();
          if (remainingAfterAttemptMs <= 0) {
            break;
          }
          const delayMs = Math.min(retryDelayMs, remainingAfterAttemptMs);
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
      }
    }
    if (!meRes) {
      throw fetchError ?? new Error(`probe timed out after ${timeoutBudgetMs}ms`);
    }
    const meJson = await meRes.json();
    if (!meRes.ok || !meJson?.ok) {
      result.status = meRes.status;
      result.error = meJson?.description ?? `getMe failed (${meRes.status})`;
      return { ...result, elapsedMs: Date.now() - started };
    }
    result.bot = {
      id: meJson.result?.id ?? null,
      username: meJson.result?.username ?? null,
      canJoinGroups: typeof meJson.result?.can_join_groups === "boolean" ? meJson.result?.can_join_groups : null,
      canReadAllGroupMessages: typeof meJson.result?.can_read_all_group_messages === "boolean" ? meJson.result?.can_read_all_group_messages : null,
      supportsInlineQueries: typeof meJson.result?.supports_inline_queries === "boolean" ? meJson.result?.supports_inline_queries : null
    };
    try {
      const webhookRemainingBudgetMs = resolveRemainingBudgetMs();
      if (webhookRemainingBudgetMs > 0) {
        const webhookRes = await fetchWithTimeout(
          `${base}/getWebhookInfo`,
          {},
          Math.max(1, Math.min(timeoutBudgetMs, webhookRemainingBudgetMs)),
          fetcher
        );
        const webhookJson = await webhookRes.json();
        if (webhookRes.ok && webhookJson?.ok) {
          result.webhook = {
            url: webhookJson.result?.url ?? null,
            hasCustomCert: webhookJson.result?.has_custom_certificate ?? null
          };
        }
      }
    } catch {
    }
    result.ok = true;
    result.status = null;
    result.error = null;
    result.elapsedMs = Date.now() - started;
    return result;
  } catch (err) {
    return {
      ...result,
      status: err instanceof Response ? err.status : result.status,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - started
    };
  }
}
export {
  probeTelegram,
  resetTelegramProbeFetcherCacheForTests
};
