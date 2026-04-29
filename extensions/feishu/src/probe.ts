import crypto from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { raceWithTimeoutAndAbort } from "./async.js";
import { createFeishuClient, type FeishuClientCredentials } from "./client.js";
import type { FeishuProbeResult } from "./types.js";

/** Cache probe results to reduce repeated health-check calls.
 * Gateway health checks call probeFeishu() every minute; without caching this
 * burns ~43,200 calls/month, easily exceeding Feishu's free-tier quota.
 * Successful bot info is effectively static, while failures are cached briefly
 * to avoid hammering the API during transient outages. */
const probeCache = new Map<string, { result: FeishuProbeResult; expiresAt: number }>();
const PROBE_SUCCESS_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PROBE_ERROR_TTL_MS = 60 * 1000; // 1 minute
const MAX_PROBE_CACHE_SIZE = 64;
export const FEISHU_PROBE_REQUEST_TIMEOUT_MS = 10_000;
export type ProbeFeishuOptions = {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  forceFresh?: boolean;
};

type FeishuPingResponse = {
  code: number;
  msg?: string;
  data?: { pingBotInfo?: { botID?: string; botName?: string } };
};

type FeishuRequestClient = ReturnType<typeof createFeishuClient> & {
  request(params: {
    method: "POST";
    url: string;
    data: Record<string, unknown>;
    timeout: number;
  }): Promise<FeishuPingResponse>;
};

function setCachedProbeResult(
  cacheKey: string,
  result: FeishuProbeResult,
  ttlMs: number,
): FeishuProbeResult {
  probeCache.set(cacheKey, { result, expiresAt: Date.now() + ttlMs });
  if (probeCache.size > MAX_PROBE_CACHE_SIZE) {
    const oldest = probeCache.keys().next().value;
    if (oldest !== undefined) {
      probeCache.delete(oldest);
    }
  }
  return result;
}

function getValidCachedProbeResult(
  cacheKey: string,
  now = Date.now(),
): { result: FeishuProbeResult; expiresAt: number } | undefined {
  const cached = probeCache.get(cacheKey);
  if (!cached || cached.expiresAt <= now) {
    return undefined;
  }
  return cached;
}

function buildProbeCacheKey(creds: FeishuClientCredentials): string {
  const fingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify([creds.domain ?? "feishu", creds.appId, creds.appSecret]))
    .digest("hex")
    .slice(0, 16);

  // Keep accountId in the key so same-credential aliases do not cross-pollute,
  // but also include a credential fingerprint so hot-reloaded account updates
  // trigger a fresh probe instead of reusing stale bot identity.
  return creds.accountId ? `${creds.accountId}:${fingerprint}` : `${creds.appId}:${fingerprint}`;
}

export async function probeFeishu(
  creds?: FeishuClientCredentials,
  options: ProbeFeishuOptions = {},
): Promise<FeishuProbeResult> {
  if (!creds?.appId || !creds?.appSecret) {
    return {
      ok: false,
      error: "missing credentials (appId, appSecret)",
    };
  }
  if (options.abortSignal?.aborted) {
    return {
      ok: false,
      appId: creds.appId,
      error: "probe aborted",
    };
  }

  const timeoutMs = options.timeoutMs ?? FEISHU_PROBE_REQUEST_TIMEOUT_MS;

  // Return cached result if still valid.
  // Include both logical account identity and a credential fingerprint so a
  // renamed or hot-reloaded account keeps its own cache bucket while a
  // credential change forces a fresh bot-identity probe.
  const cacheKey = buildProbeCacheKey(creds);
  const cached = getValidCachedProbeResult(cacheKey);
  if (!options.forceFresh && cached) {
    return cached.result;
  }
  const cachedSuccessFallback = options.forceFresh && cached?.result.ok ? cached.result : undefined;

  function maybeUseCachedIdentityFallback(error: string): FeishuProbeResult | null {
    if (!cachedSuccessFallback) {
      return null;
    }
    // Startup/reload should prefer a live probe, but transient probe failures
    // should not discard the last known-good bot identity immediately.
    return {
      ...cachedSuccessFallback,
      usedCachedIdentityFallback: true,
      cachedIdentityFallbackError: error,
    };
  }

  try {
    const client = createFeishuClient(creds) as FeishuRequestClient;
    // Feishu-provided endpoint for OpenClaw, supported on both Feishu (CN)
    // and Lark (international). No OAuth scopes required. Validates
    // credentials and registers the app as an AI agent (智能体).
    const responseResult = await raceWithTimeoutAndAbort<FeishuPingResponse>(
      client.request({
        method: "POST",
        url: "/open-apis/bot/v1/openclaw_bot/ping",
        data: { needBotInfo: true },
        timeout: timeoutMs,
      }),
      {
        timeoutMs,
        abortSignal: options.abortSignal,
      },
    );

    if (responseResult.status === "aborted") {
      return {
        ok: false,
        appId: creds.appId,
        error: "probe aborted",
      };
    }
    if (responseResult.status === "timeout") {
      const fallback = maybeUseCachedIdentityFallback(`probe timed out after ${timeoutMs}ms`);
      if (fallback) {
        return fallback;
      }
      return setCachedProbeResult(
        cacheKey,
        {
          ok: false,
          appId: creds.appId,
          error: `probe timed out after ${timeoutMs}ms`,
        },
        PROBE_ERROR_TTL_MS,
      );
    }

    const response = responseResult.value;
    if (options.abortSignal?.aborted) {
      return {
        ok: false,
        appId: creds.appId,
        error: "probe aborted",
      };
    }

    if (response.code !== 0) {
      const errorMessage = `API error: ${response.msg || `code ${response.code}`}`;
      const fallback = maybeUseCachedIdentityFallback(errorMessage);
      if (fallback) {
        return fallback;
      }
      return setCachedProbeResult(
        cacheKey,
        {
          ok: false,
          appId: creds.appId,
          error: errorMessage,
        },
        PROBE_ERROR_TTL_MS,
      );
    }

    const botInfo = response.data?.pingBotInfo;
    return setCachedProbeResult(
      cacheKey,
      {
        ok: true,
        appId: creds.appId,
        botName: botInfo?.botName,
        botOpenId: botInfo?.botID,
      },
      PROBE_SUCCESS_TTL_MS,
    );
  } catch (err) {
    const formattedError = formatErrorMessage(err);
    const fallback = maybeUseCachedIdentityFallback(formattedError);
    if (fallback) {
      return fallback;
    }
    return setCachedProbeResult(
      cacheKey,
      {
        ok: false,
        appId: creds.appId,
        error: formattedError,
      },
      PROBE_ERROR_TTL_MS,
    );
  }
}

/** Clear the probe cache (for testing). */
export function clearProbeCache(): void {
  probeCache.clear();
}
