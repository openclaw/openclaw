import { raceWithTimeoutAndAbort } from "./async.js";
import { createFeishuClient } from "./client.js";
const probeCache = /* @__PURE__ */ new Map();
const PROBE_SUCCESS_TTL_MS = 10 * 60 * 1e3;
const PROBE_ERROR_TTL_MS = 60 * 1e3;
const MAX_PROBE_CACHE_SIZE = 64;
const FEISHU_PROBE_REQUEST_TIMEOUT_MS = 1e4;
function setCachedProbeResult(cacheKey, result, ttlMs) {
  probeCache.set(cacheKey, { result, expiresAt: Date.now() + ttlMs });
  if (probeCache.size > MAX_PROBE_CACHE_SIZE) {
    const oldest = probeCache.keys().next().value;
    if (oldest !== void 0) {
      probeCache.delete(oldest);
    }
  }
  return result;
}
async function probeFeishu(creds, options = {}) {
  if (!creds?.appId || !creds?.appSecret) {
    return {
      ok: false,
      error: "missing credentials (appId, appSecret)"
    };
  }
  if (options.abortSignal?.aborted) {
    return {
      ok: false,
      appId: creds.appId,
      error: "probe aborted"
    };
  }
  const timeoutMs = options.timeoutMs ?? FEISHU_PROBE_REQUEST_TIMEOUT_MS;
  const cacheKey = creds.accountId ?? `${creds.appId}:${creds.appSecret.slice(0, 8)}`;
  const cached = probeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }
  try {
    const client = createFeishuClient(creds);
    const responseResult = await raceWithTimeoutAndAbort(
      client.request({
        method: "GET",
        url: "/open-apis/bot/v3/info",
        data: {},
        timeout: timeoutMs
      }),
      {
        timeoutMs,
        abortSignal: options.abortSignal
      }
    );
    if (responseResult.status === "aborted") {
      return {
        ok: false,
        appId: creds.appId,
        error: "probe aborted"
      };
    }
    if (responseResult.status === "timeout") {
      return setCachedProbeResult(
        cacheKey,
        {
          ok: false,
          appId: creds.appId,
          error: `probe timed out after ${timeoutMs}ms`
        },
        PROBE_ERROR_TTL_MS
      );
    }
    const response = responseResult.value;
    if (options.abortSignal?.aborted) {
      return {
        ok: false,
        appId: creds.appId,
        error: "probe aborted"
      };
    }
    if (response.code !== 0) {
      return setCachedProbeResult(
        cacheKey,
        {
          ok: false,
          appId: creds.appId,
          error: `API error: ${response.msg || `code ${response.code}`}`
        },
        PROBE_ERROR_TTL_MS
      );
    }
    const bot = response.bot || response.data?.bot;
    return setCachedProbeResult(
      cacheKey,
      {
        ok: true,
        appId: creds.appId,
        botName: bot?.bot_name,
        botOpenId: bot?.open_id
      },
      PROBE_SUCCESS_TTL_MS
    );
  } catch (err) {
    return setCachedProbeResult(
      cacheKey,
      {
        ok: false,
        appId: creds.appId,
        error: err instanceof Error ? err.message : String(err)
      },
      PROBE_ERROR_TTL_MS
    );
  }
}
function clearProbeCache() {
  probeCache.clear();
}
export {
  FEISHU_PROBE_REQUEST_TIMEOUT_MS,
  clearProbeCache,
  probeFeishu
};
