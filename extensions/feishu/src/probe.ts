import type { FeishuProbeResult } from "./types.js";
import { createFeishuClient, type FeishuClientCredentials } from "./client.js";

// Cache bot info for 24 hours to minimize quota-consuming API calls.
//
// The Feishu free tier allows 10,000 basic API calls/month. Without caching,
// periodic health probes (every 60s) would consume ~43,200 calls/month per account,
// far exceeding the quota limit.
//
// Strategy:
// - Cache hit (< 24h): Validate auth via token manager (quota-exempt endpoint)
// - Cache miss (> 24h): Refresh bot info via GET /bot/v3/info (quota-consuming)
//
// This reduces quota usage to ~30 calls/month per account (99.9%+ reduction)
// while ensuring bot info stays current (daily refresh) and auth health is
// continuously monitored (every 60s via token validation).
//
// Cache key uses appId:domain (credential-based) so credential rotations
// automatically invalidate stale entries via new cache key.
type BotInfoCacheEntry = {
  botName?: string;
  botOpenId?: string;
  expires: number;
};

const botInfoCache = new Map<string, BotInfoCacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_SIZE = 64;

/**
 * Build cache key from credentials.
 * Bot info is app-level (appId), not account-level.
 * Domain matters because Feishu and Lark are separate endpoints.
 */
function buildCacheKey(creds: FeishuClientCredentials): string {
  const domain = creds.domain ?? "feishu";
  return `${creds.appId}:${domain}`;
}

export async function probeFeishu(creds?: FeishuClientCredentials): Promise<FeishuProbeResult> {
  if (!creds?.appId || !creds?.appSecret) {
    return {
      ok: false,
      error: "missing credentials (appId, appSecret)",
    };
  }

  try {
    const client = createFeishuClient(creds);
    const cacheKey = buildCacheKey(creds);

    // After the first successful probe we cache bot metadata and switch to
    // a lightweight token-validity check for subsequent calls.  The SDK's
    // TokenManager keeps the tenant_access_token in memory (~2 h TTL) and
    // only refreshes via POST /auth/v3/tenant_access_token/internal — an
    // auth-infrastructure endpoint that does not consume the basic-API-call
    // quota.
    const cached = botInfoCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing internal SDK tokenManager
        const token = await (client as any).tokenManager.getTenantAccessToken();
        if (!token || typeof token !== "string" || token.trim().length === 0) {
          // Token invalid - invalidate cache and re-probe
          botInfoCache.delete(cacheKey);
          // Fall through to full probe below
        } else {
          // Token valid - return cached bot info
          return {
            ok: true,
            appId: creds.appId,
            botName: cached.botName,
            botOpenId: cached.botOpenId,
          };
        }
      } catch (err) {
        // Auth error (revoked credentials) - invalidate and re-probe
        botInfoCache.delete(cacheKey);
        // Fall through to full probe below
      }
    }

    // First probe: use bot/v3/info API to get bot information
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK generic request method
    const response = await (client as any).request({
      method: "GET",
      url: "/open-apis/bot/v3/info",
      data: {},
    });

    if (response.code !== 0) {
      return {
        ok: false,
        appId: creds.appId,
        error: `API error: ${response.msg || `code ${response.code}`}`,
      };
    }

    const bot = response.bot || response.data?.bot;

    // Cache bot info for future lightweight probes
    botInfoCache.set(cacheKey, {
      botName: bot?.bot_name,
      botOpenId: bot?.open_id,
      expires: Date.now() + CACHE_TTL_MS,
    });

    // Evict oldest entry if exceeds size cap (LRU-style)
    if (botInfoCache.size > MAX_CACHE_SIZE) {
      const oldest = botInfoCache.keys().next().value;
      if (oldest !== undefined) {
        botInfoCache.delete(oldest);
      }
    }

    return {
      ok: true,
      appId: creds.appId,
      botName: bot?.bot_name,
      botOpenId: bot?.open_id,
    };
  } catch (err) {
    return {
      ok: false,
      appId: creds.appId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Clear the bot info cache (for testing).
 * Exported to match pattern from BlueBubbles cache.
 */
export function clearBotInfoCache(): void {
  botInfoCache.clear();
}
