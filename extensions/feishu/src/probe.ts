import { createFeishuClient, type FeishuClientCredentials } from "./client.js";
import type { FeishuProbeResult } from "./types.js";

const DECIMAL_RADIX = 10;
const MINUTES_TO_MS = 60 * 1000;
const MIN_VALID_TTL_MINUTES = 0;
const DEFAULT_SUCCESS_CACHE_TTL_MINUTES = 15;
const DEFAULT_ERROR_CACHE_TTL_MINUTES = 5;
const FEISHU_API_SUCCESS_CODE = 0;
const SUCCESS_CACHE_TTL_ENV_KEY = "FEISHU_PROBE_CACHE_TTL_MINUTES";
const ERROR_CACHE_TTL_ENV_KEY = "FEISHU_PROBE_ERROR_CACHE_TTL_MINUTES";

// Cache for probe results to avoid API rate limits
// Success TTL default: 15 minutes (900000 ms)
// Can be customized via environment variable: FEISHU_PROBE_CACHE_TTL_MINUTES
// Error TTL default: 5 minutes (300000 ms)
// Can be customized via environment variable: FEISHU_PROBE_ERROR_CACHE_TTL_MINUTES
function resolveCacheTtlMs(envKey: string, defaultMinutes: number): number {
  const envTtl = process.env[envKey];
  if (envTtl) {
    const minutes = parseInt(envTtl, DECIMAL_RADIX);
    if (!isNaN(minutes) && minutes > MIN_VALID_TTL_MINUTES) {
      return minutes * MINUTES_TO_MS;
    }
  }
  return defaultMinutes * MINUTES_TO_MS;
}

const PROBE_CACHE_TTL_MS = resolveCacheTtlMs(
  SUCCESS_CACHE_TTL_ENV_KEY,
  DEFAULT_SUCCESS_CACHE_TTL_MINUTES,
);

interface ProbeCacheEntry {
  result: FeishuProbeResult;
  timestamp: number;
  ttlMs: number;
}

const probeCache = new Map<string, ProbeCacheEntry>();
const PROBE_ERROR_CACHE_TTL_MS = resolveCacheTtlMs(
  ERROR_CACHE_TTL_ENV_KEY,
  DEFAULT_ERROR_CACHE_TTL_MINUTES,
);

function getCacheKey(creds: FeishuClientCredentials): string {
  return `${creds.appId}:${creds.domain || "feishu"}`;
}

function getCachedResult(creds: FeishuClientCredentials): FeishuProbeResult | null {
  const key = getCacheKey(creds);
  const cached = probeCache.get(key);
  if (!cached) return null;

  const now = Date.now();
  if (now - cached.timestamp > cached.ttlMs) {
    // Cache expired
    probeCache.delete(key);
    return null;
  }

  return cached.result;
}

function setCachedResult(creds: FeishuClientCredentials, result: FeishuProbeResult): void {
  const key = getCacheKey(creds);
  const ttlMs = result.ok ? PROBE_CACHE_TTL_MS : PROBE_ERROR_CACHE_TTL_MS;
  probeCache.set(key, {
    result,
    timestamp: Date.now(),
    ttlMs,
  });
}

/**
 * Clear the probe cache for a specific appId or all accounts.
 */
export function clearProbeCache(appId?: string): void {
  if (appId) {
    // Cache keys are stored as `${appId}:${domain}`.
    for (const [key] of probeCache.entries()) {
      if (key.startsWith(`${appId}:`)) {
        probeCache.delete(key);
      }
    }
  } else {
    probeCache.clear();
  }
}

export async function probeFeishu(creds?: FeishuClientCredentials): Promise<FeishuProbeResult> {
  if (!creds?.appId || !creds?.appSecret) {
    return {
      ok: false,
      error: "missing credentials (appId, appSecret)",
    };
  }

  // Check cache first
  const cached = getCachedResult(creds);
  if (cached) {
    return cached;
  }

  try {
    const client = createFeishuClient(creds);
    // Use bot/v3/info API to get bot information
    const response = await (client as any).request({
      method: "GET",
      url: "/open-apis/bot/v3/info",
      data: {},
    });

    if (response.code !== FEISHU_API_SUCCESS_CODE) {
      const result: FeishuProbeResult = {
        ok: false,
        appId: creds.appId,
        error: `API error: ${response.msg || `code ${response.code}`}`,
      };
      // Cache error results with error TTL to avoid hammering the API
      setCachedResult(creds, result);
      return result;
    }

    const bot = response.bot || response.data?.bot;
    const result: FeishuProbeResult = {
      ok: true,
      appId: creds.appId,
      botName: bot?.bot_name,
      botOpenId: bot?.open_id,
    };

    // Cache successful result
    setCachedResult(creds, result);

    return result;
  } catch (err) {
    const result: FeishuProbeResult = {
      ok: false,
      appId: creds.appId,
      error: err instanceof Error ? err.message : String(err),
    };
    // Cache error results with error TTL
    setCachedResult(creds, result);
    return result;
  }
}
