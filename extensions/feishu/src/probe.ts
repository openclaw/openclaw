import { createFeishuClient, type FeishuClientCredentials } from "./client.js";
import type { FeishuProbeResult } from "./types.js";

/** Cache successful probe results to reduce API calls (bot info is static).
 * Gateway health checks call probeFeishu() every minute; without caching this
 * burns ~43,200 calls/month, easily exceeding Feishu's free-tier quota.
 * A 10-min TTL cuts that to ~4,320 calls/month. (#26684) */
const probeCache = new Map<string, { result: FeishuProbeResult; expiresAt: number }>();
const PROBE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PROBE_CACHE_SIZE = 64;

export async function probeFeishu(creds?: FeishuClientCredentials): Promise<FeishuProbeResult> {
  if (!creds?.appId || !creds?.appSecret) {
    return {
      ok: false,
      error: "missing credentials (appId, appSecret)",
    };
  }

  // Return cached result if still valid.
  // Use accountId when available; otherwise include appSecret prefix so two
  // accounts sharing the same appId (e.g. after secret rotation) don't
  // pollute each other's cache entry.
  const cacheKey = creds.accountId ?? `${creds.appId}:${creds.appSecret.slice(0, 8)}`;
  const cached = probeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  try {
    const client = createFeishuClient(creds);
    // Use bot/v3/info API to get bot information
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
    const result: FeishuProbeResult = {
      ok: true,
      appId: creds.appId,
      botName: bot?.bot_name,
      botOpenId: bot?.open_id,
    };

    // Cache successful results only
    probeCache.set(cacheKey, { result, expiresAt: Date.now() + PROBE_CACHE_TTL_MS });
    // Evict oldest entry if cache exceeds max size
    if (probeCache.size > MAX_PROBE_CACHE_SIZE) {
      const oldest = probeCache.keys().next().value;
      if (oldest !== undefined) {
        probeCache.delete(oldest);
      }
    }

    return result;
  } catch (err) {
    return {
      ok: false,
      appId: creds.appId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Clear the probe cache (for testing). */
export function clearProbeCache(): void {
  probeCache.clear();
}
