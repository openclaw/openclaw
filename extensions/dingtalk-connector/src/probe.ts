import type { DingtalkProbeResult } from "./types/index.ts";
import { raceWithTimeoutAndAbort } from "./utils/async.ts";
import { dingtalkHttp } from "./utils/http-client.ts";

/** LRU Cache for probe results to reduce repeated health-check calls. */
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // 重新插入以更新访问顺序
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    // 如果已存在，先删除（更新顺序）
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    this.cache.set(key, value);

    // 超过大小限制时删除最旧的（最少使用的）
    if (this.cache.size > this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

const probeCache = new LRUCache<string, { result: DingtalkProbeResult; expiresAt: number }>(64);
const PROBE_SUCCESS_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PROBE_ERROR_TTL_MS = 60 * 1000; // 1 minute
export const DINGTALK_PROBE_REQUEST_TIMEOUT_MS = 10_000;
export type ProbeDingtalkOptions = {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
};

function setCachedProbeResult(
  cacheKey: string,
  result: DingtalkProbeResult,
  ttlMs: number,
): DingtalkProbeResult {
  probeCache.set(cacheKey, { result, expiresAt: Date.now() + ttlMs });
  return result;
}

export async function probeDingtalk(
  creds?: { clientId: string; clientSecret: string; accountId?: string },
  options: ProbeDingtalkOptions = {},
): Promise<DingtalkProbeResult> {
  if (!creds?.clientId || !creds?.clientSecret) {
    return {
      ok: false,
      error: "missing credentials (clientId, clientSecret)",
    };
  }
  if (options.abortSignal?.aborted) {
    return {
      ok: false,
      clientId: creds.clientId,
      error: "probe aborted",
    };
  }

  const timeoutMs = options.timeoutMs ?? DINGTALK_PROBE_REQUEST_TIMEOUT_MS;

  // Return cached result if still valid.
  const cacheKey = creds.accountId ?? `${creds.clientId}:${creds.clientSecret.slice(0, 8)}`;
  const cached = probeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  try {
    // Get access token
    const tokenResponse = await raceWithTimeoutAndAbort(
      dingtalkHttp.post<{ accessToken?: string }>(
        "https://api.dingtalk.com/v1.0/oauth2/accessToken",
        { appKey: creds.clientId, appSecret: creds.clientSecret },
      ),
      { timeoutMs, abortSignal: options.abortSignal },
    );

    if (tokenResponse.status === "aborted") {
      return {
        ok: false,
        clientId: creds.clientId,
        error: "probe aborted",
      };
    }
    if (tokenResponse.status === "timeout") {
      return setCachedProbeResult(
        cacheKey,
        {
          ok: false,
          clientId: creds.clientId,
          error: `probe timed out after ${timeoutMs}ms`,
        },
        PROBE_ERROR_TTL_MS,
      );
    }

    const tokenData = tokenResponse.value.data;
    if (!tokenData.accessToken) {
      return setCachedProbeResult(
        cacheKey,
        {
          ok: false,
          clientId: creds.clientId,
          error: "failed to get access token",
        },
        PROBE_ERROR_TTL_MS,
      );
    }

    // Credentials proven valid by a successful accessToken exchange.
    // Do not call user-scoped endpoints (e.g. /contact/users/me) here: they require a
    // user-level OAuth token and return 403 against an app-level accessToken. Real
    // end-to-end connectivity is verified by the Stream gateway handshake on startup.
    return setCachedProbeResult(
      cacheKey,
      {
        ok: true,
        clientId: creds.clientId,
      },
      PROBE_SUCCESS_TTL_MS,
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

/** Clear the probe cache (for testing). */
export function clearProbeCache(): void {
  probeCache.clear();
}
