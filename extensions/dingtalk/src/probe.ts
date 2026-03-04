import axios from "axios";
import { getAccessToken } from "./client.js";
import type { DingtalkProbeResult, ResolvedDingtalkAccount } from "./types.js";

// 探测结果缓存 / Probe result cache
const probeCache = new Map<string, { result: DingtalkProbeResult; expiresAt: number }>();
const PROBE_SUCCESS_TTL_MS = 10 * 60 * 1000;
const PROBE_ERROR_TTL_MS = 60 * 1000;
const MAX_PROBE_CACHE_SIZE = 64;
export const DINGTALK_PROBE_REQUEST_TIMEOUT_MS = 10_000;

function setCachedProbeResult(
  cacheKey: string,
  result: DingtalkProbeResult,
  ttlMs: number,
): DingtalkProbeResult {
  probeCache.set(cacheKey, { result, expiresAt: Date.now() + ttlMs });
  if (probeCache.size > MAX_PROBE_CACHE_SIZE) {
    const oldest = probeCache.keys().next().value;
    if (oldest !== undefined) {
      probeCache.delete(oldest);
    }
  }
  return result;
}

/**
 * 探测钉钉连接状态 / Probe DingTalk connection status
 *
 * 通过获取 AccessToken 来验证凭证是否有效。
 * Validates credentials by attempting to get an AccessToken.
 */
export async function probeDingtalk(
  creds?: { accountId?: string; clientId?: string; clientSecret?: string },
): Promise<DingtalkProbeResult> {
  if (!creds?.clientId || !creds?.clientSecret) {
    return { ok: false, error: "missing credentials (clientId, clientSecret)" };
  }

  const cacheKey = creds.accountId ?? `${creds.clientId}:${creds.clientSecret.slice(0, 8)}`;
  const cached = probeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  try {
    const res = await axios.get("https://oapi.dingtalk.com/gettoken", {
      params: {
        appkey: creds.clientId,
        appsecret: creds.clientSecret,
      },
      timeout: DINGTALK_PROBE_REQUEST_TIMEOUT_MS,
    });

    if (res.data?.access_token) {
      return setCachedProbeResult(
        cacheKey,
        {
          ok: true,
          clientId: creds.clientId,
          robotCode: creds.clientId,
        },
        PROBE_SUCCESS_TTL_MS,
      );
    }

    return setCachedProbeResult(
      cacheKey,
      {
        ok: false,
        clientId: creds.clientId,
        error: `API error: ${res.data?.errmsg || "unknown"}`,
      },
      PROBE_ERROR_TTL_MS,
    );
  } catch (err) {
    return setCachedProbeResult(
      cacheKey,
      {
        ok: false,
        clientId: creds.clientId,
        error: err instanceof Error ? err.message : String(err),
      },
      PROBE_ERROR_TTL_MS,
    );
  }
}

// 清除探测缓存 / Clear probe cache
export function clearProbeCache(): void {
  probeCache.clear();
}
