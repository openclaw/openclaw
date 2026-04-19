/** Yuanbao HTTP request base layer — token cache, signature, auth headers, and HTTP utilities. */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getOpenclawVersion, getOperationSystem, getPluginVersion } from "../../infra/env.js";
import { createLog } from "../../logger.js";
import type { ResolvedYuanbaoAccount } from "../../types.js";

export type SignTokenData = {
  bot_id: string;
  duration: number;
  product: string;
  source: string;
  token: string;
};

export type AuthHeaders = {
  "X-ID": string;
  "X-Token": string;
  "X-Source": string;
  "X-Route-Env"?: string;
  "X-AppVersion": string;
  "X-OperationSystem": string;
  "X-Instance-Id": string;
  "X-Bot-Version": string;
};

export type CosUploadConfig = {
  bucketName: string;
  region: string;
  location: string;
  encryptTmpSecretId: string;
  encryptTmpSecretKey: string;
  encryptToken: string;
  startTime: number;
  expiredTime: number;
  resourceUrl: string;
  resourceID?: string;
};

export type Log = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
};

type CacheEntry = {
  data: SignTokenData;
  expiresAt: number;
};

export const SIGN_TOKEN_PATH = "/api/v5/robotLogic/sign-token";
export const UPLOAD_INFO_PATH = "/api/resource/genUploadInfo";
export const DOWNLOAD_INFO_PATH = "/api/resource/v1/download";

const RETRYABLE_SIGN_CODE = 10099;
const SIGN_MAX_RETRIES = 3;
const SIGN_RETRY_DELAY_MS = 1000;

const CACHE_REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Max safe setTimeout delay (ms): ~24 days, prevents 32-bit overflow
const MAX_SAFE_TIMEOUT_MS = 24 * 24 * 3600 * 1000;

const HTTP_AUTH_RETRY_MAX = 1;

const tokenCacheMap = new Map<string, CacheEntry>();

const tokenFetchPromises = new Map<string, Promise<SignTokenData>>();

const tokenRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function clearSignTokenCache(accountId: string): void {
  tokenCacheMap.delete(accountId);
  const timer = tokenRefreshTimers.get(accountId);
  if (timer) {
    clearTimeout(timer);
    tokenRefreshTimers.delete(accountId);
  }
}

export function clearAllSignTokenCache(): void {
  tokenCacheMap.clear();
  for (const timer of tokenRefreshTimers.values()) {
    clearTimeout(timer);
  }
  tokenRefreshTimers.clear();
}

export function getTokenStatus(accountId: string): {
  status: "valid" | "expired" | "refreshing" | "none";
  expiresAt: number | null;
} {
  if (tokenFetchPromises.has(accountId)) {
    return { status: "refreshing", expiresAt: tokenCacheMap.get(accountId)?.expiresAt ?? null };
  }
  const cached = tokenCacheMap.get(accountId);
  if (!cached) {
    return { status: "none", expiresAt: null };
  }
  return {
    status: cached.expiresAt > Date.now() ? "valid" : "expired",
    expiresAt: cached.expiresAt,
  };
}

export function getCachedBotId(accountId: string): string | undefined {
  const cached = tokenCacheMap.get(accountId);
  if (!cached || cached.expiresAt <= Date.now()) {
    return undefined;
  }
  return cached.data.bot_id || undefined;
}

function computeSignature(params: {
  nonce: string;
  timestamp: string;
  appKey: string;
  appSecret: string;
}): string {
  const plain = params.nonce + params.timestamp + params.appKey + params.appSecret;
  return createHmac("sha256", params.appSecret).update(plain).digest("hex");
}

export function verifySignature(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(actual, "hex");
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}

async function doFetchSignToken(
  account: ResolvedYuanbaoAccount,
  log?: Log,
): Promise<SignTokenData> {
  const mlog = createLog("http", log);
  const { appKey, appSecret, apiDomain } = account;
  if (!appKey || !appSecret) {
    throw new Error("sign-token failed: missing appKey or appSecret");
  }

  const url = `https://${apiDomain}${SIGN_TOKEN_PATH}`;

  for (let attempt = 0; attempt <= SIGN_MAX_RETRIES; attempt++) {
    const nonce = randomBytes(16).toString("hex");
    const bjTime = new Date(Date.now() + 8 * 3600000);
    const timestamp = bjTime
      .toISOString()
      .replace("Z", "+08:00")
      .replace(/\.\d{3}/, "");
    const signature = computeSignature({ nonce, timestamp, appKey, appSecret });
    const body = { app_key: appKey, nonce, signature, timestamp };

    mlog.info(
      `signing token: url=${url}${attempt > 0 ? ` (retry ${attempt}/${SIGN_MAX_RETRIES})` : ""}`,
    );
    mlog.info("sign-token params", body);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-AppVersion": getPluginVersion(),
      "X-OperationSystem": getOperationSystem(),
      "X-Instance-Id": "16",
      "X-Bot-Version": getOpenclawVersion(),
    };

    if (account.config?.routeEnv) {
      headers["x-route-env"] = account.config.routeEnv;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`sign-token HTTP error: ${response.status} ${response.statusText}`);
    }

    const result = (await response.json()) as { code: number; data: SignTokenData; msg: string };

    if (result.code === 0) {
      mlog.info(`sign-token success: bot_id=${result.data.bot_id}`);
      return result.data;
    }

    if (result.code === RETRYABLE_SIGN_CODE && attempt < SIGN_MAX_RETRIES) {
      mlog.warn(`sign-token retryable: code=${result.code}, retrying in ${SIGN_RETRY_DELAY_MS}ms`);
      await new Promise((r) => setTimeout(r, SIGN_RETRY_DELAY_MS));
      continue;
    }

    throw new Error(`sign-token error: code=${result.code}, msg=${result.msg}`);
  }

  throw new Error("sign-token failed: max retries exceeded");
}

function scheduleTokenRefresh(
  account: ResolvedYuanbaoAccount,
  durationSec: number,
  log?: Log,
): void {
  const mlog = createLog("http", log);
  const existing = tokenRefreshTimers.get(account.accountId);
  if (existing) {
    clearTimeout(existing);
  }

  // Clamp: min 60s, max MAX_SAFE_TIMEOUT_MS (prevent setTimeout 32-bit integer overflow)
  const rawMs = durationSec * 1000 - CACHE_REFRESH_MARGIN_MS;
  const refreshAfterMs = Math.min(Math.max(rawMs, 60_000), MAX_SAFE_TIMEOUT_MS);
  const clampedHint = rawMs > MAX_SAFE_TIMEOUT_MS ? ", clamped to max safe timeout" : "";
  mlog.info(
    `[${account.accountId}][token-timer] scheduled refresh: ` +
      `${Math.round(refreshAfterMs / 1000)}s later (duration=${durationSec}s, ` +
      `margin=${CACHE_REFRESH_MARGIN_MS / 1000}s${clampedHint})`,
  );

  const timer = setTimeout(async () => {
    tokenRefreshTimers.delete(account.accountId);
    try {
      mlog.info(
        `[${account.accountId}][token-timer] scheduled refresh triggered, re-signing token`,
      );
      await forceRefreshSignToken(account, log);
      mlog.info(`[${account.accountId}][token-timer] scheduled refresh done`);
    } catch (err) {
      mlog.error(
        `[${account.accountId}][token-timer] scheduled refresh failed: ${String(err)}, retrying in 30s`,
      );
      // Retry after short delay on scheduled refresh failure to avoid losing the timer
      const retryTimer = setTimeout(async () => {
        tokenRefreshTimers.delete(account.accountId);
        try {
          await forceRefreshSignToken(account, log);
          mlog.info(`[${account.accountId}][token-timer] scheduled refresh retry succeeded`);
        } catch (retryErr) {
          mlog.error(
            `[${account.accountId}][token-timer] scheduled refresh retry also failed: ${String(retryErr)}, waiting for next request to trigger refresh`,
          );
        }
      }, 30_000);
      tokenRefreshTimers.set(account.accountId, retryTimer);
    }
  }, refreshAfterMs);

  tokenRefreshTimers.set(account.accountId, timer);
}

export async function getSignToken(
  account: ResolvedYuanbaoAccount,
  log?: Log,
): Promise<SignTokenData> {
  // Static token takes priority
  if (account.token) {
    return {
      bot_id: account.botId || "",
      duration: 0,
      product: "yuanbao",
      source: "bot",
      token: account.token,
    };
  }

  const tlog = createLog("http", log);

  const cached = tokenCacheMap.get(account.accountId);
  if (cached && cached.expiresAt > Date.now()) {
    const remainSec = Math.round((cached.expiresAt - Date.now()) / 1000);
    tlog.info(`[${account.accountId}] using cached token (${remainSec}s remaining)`);
    return cached.data;
  }

  // Singleflight: reuse in-flight request if one exists
  let fetchPromise = tokenFetchPromises.get(account.accountId);
  if (fetchPromise) {
    tlog.info(`[${account.accountId}] sign-token in progress, waiting for existing request`);
    return fetchPromise;
  }

  fetchPromise = (async () => {
    try {
      const data = await doFetchSignToken(account, log);
      const ttlMs = data.duration > 0 ? data.duration * 1000 : 0;
      if (ttlMs > 0) {
        tokenCacheMap.set(account.accountId, { data, expiresAt: Date.now() + ttlMs });
        scheduleTokenRefresh(account, data.duration, log);
      }
      return data;
    } finally {
      tokenFetchPromises.delete(account.accountId);
    }
  })();

  tokenFetchPromises.set(account.accountId, fetchPromise);
  return fetchPromise;
}

export async function forceRefreshSignToken(
  account: ResolvedYuanbaoAccount,
  log?: Log,
): Promise<SignTokenData> {
  const flog = createLog("http", log);
  flog.warn(`[${account.accountId}][force-refresh] clearing cache and re-signing token`);
  clearSignTokenCache(account.accountId);
  // Also clear in-flight singleflight promise to ensure a fresh request
  tokenFetchPromises.delete(account.accountId);
  return getSignToken(account, log);
}

export async function getAuthHeaders(
  account: ResolvedYuanbaoAccount,
  log?: Log,
): Promise<AuthHeaders> {
  const data = await getSignToken(account, log);

  if (data.bot_id && !account.botId) {
    account.botId = data.bot_id;
  }

  const authHeaders: AuthHeaders = {
    "X-ID": data.bot_id || account.botId || "",
    "X-Token": data.token,
    "X-Source": data.source || "web",
    "X-AppVersion": getPluginVersion(),
    "X-OperationSystem": getOperationSystem(),
    "X-Instance-Id": "16",
    "X-Bot-Version": getOpenclawVersion(),
  };

  if (account.config?.routeEnv) {
    authHeaders["X-Route-Env"] = account.config.routeEnv;
  }

  return authHeaders;
}

export async function yuanbaoPost<T>(
  account: ResolvedYuanbaoAccount,
  path: string,
  body: unknown,
  log?: Log,
): Promise<T> {
  const plog = createLog("http", log);
  const url = `https://${account.apiDomain}${path}`;

  for (let attempt = 0; attempt <= HTTP_AUTH_RETRY_MAX; attempt++) {
    const authHeaders = await getAuthHeaders(account, log);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify(body),
    });

    // HTTP 401: token expired, force-refresh and retry once
    if (response.status === 401 && attempt < HTTP_AUTH_RETRY_MAX) {
      plog.warn(
        `[post][${account.accountId}] ${path} received 401, refreshing token and retrying (attempt=${attempt + 1})`,
      );
      await forceRefreshSignToken(account, log);
      continue;
    }

    if (!response.ok) {
      throw new Error(`[yuanbao-api][POST] ${path} HTTP ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as { code?: number; data?: T; msg?: string };

    if (json.code !== 0 && json.code !== undefined) {
      throw new Error(
        `[yuanbao-api][POST] ${path} business error: code=${json.code}, msg=${json.msg}`,
      );
    }

    plog.info(`[post][${account.accountId}] ${path} request succeeded`);
    return (json.data ?? json) as T;
  }

  throw new Error(`[yuanbao-api][POST] ${path} 401 retries exhausted`);
}

export async function yuanbaoGet<T>(
  account: ResolvedYuanbaoAccount,
  path: string,
  params?: Record<string, string>,
  log?: Log,
): Promise<T> {
  const glog = createLog("http", log);
  const url = `https://${account.apiDomain}${path}${params ? `?${new URLSearchParams(params).toString()}` : ""}`;

  for (let attempt = 0; attempt <= HTTP_AUTH_RETRY_MAX; attempt++) {
    const authHeaders = await getAuthHeaders(account, log);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
      },
    });

    // HTTP 401: token expired, force-refresh and retry once
    if (response.status === 401 && attempt < HTTP_AUTH_RETRY_MAX) {
      glog.warn(
        `[get][${account.accountId}] ${path} received 401, refreshing token and retrying (attempt=${attempt + 1})`,
      );
      await forceRefreshSignToken(account, log);
      continue;
    }

    if (!response.ok) {
      throw new Error(`[yuanbao-api][GET] ${path} HTTP ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as { code?: number; data?: T; msg?: string };

    if (json.code !== 0 && json.code !== undefined) {
      throw new Error(
        `[yuanbao-api][GET] ${path} business error: code=${json.code}, msg=${json.msg}`,
      );
    }

    return (json.data ?? json) as T;
  }

  throw new Error(`[yuanbao-api][GET] ${path} 401 retries exhausted`);
}
