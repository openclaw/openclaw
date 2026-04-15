/**
 * 元宝 HTTP request基础层
 *
 * Contains:类型定义、Token 缓存、签名计算、鉴权头获取、通用 HTTP Utility functions。
 * 业务 API（uploadInfo / downloadUrl）见 main.ts。
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getOpenclawVersion, getOperationSystem, getPluginVersion } from "../../infra/env.js";
import { createLog } from "../../logger.js";
import type { ResolvedYuanbaoAccount } from "../../types.js";

// ============ 类型 ============

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

/** COS 上传预签配置 */
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

// ============ 常量 ============

export const SIGN_TOKEN_PATH = "/api/v5/robotLogic/sign-token";
export const UPLOAD_INFO_PATH = "/api/resource/genUploadInfo";
export const DOWNLOAD_INFO_PATH = "/api/resource/v1/download";

const RETRYABLE_SIGN_CODE = 10099;
const SIGN_MAX_RETRIES = 3;
const SIGN_RETRY_DELAY_MS = 1000;

/** 提前刷新 token 的安全裕量：过期前 5 分钟 */
const CACHE_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * setTimeout 最大安全延迟（ms）。
 * Node.js 使用 32 位有符号整数存储 setTimeout delay，
 * 超过 2^31 - 1 (≈24.8 天) 会溢出并被截断为 1ms，导致定时器立即触发。
 * 安全上限设为 24 天。
 */
const MAX_SAFE_TIMEOUT_MS = 24 * 24 * 3600 * 1000; // ~24 天

/** HTTP 401 自动重试最大次数 */
const HTTP_AUTH_RETRY_MAX = 1;

// ============ Token 缓存（按 accountId 隔离） ============

/** key: accountId */
const tokenCacheMap = new Map<string, CacheEntry>();

/**
 * 进行中的签票 Promise（singleflight）
 * 多个并发请求发现缓存过期时，只有第一个真正调用接口，其余复用同一 Promise。
 */
const tokenFetchPromises = new Map<string, Promise<SignTokenData>>();

/** 定时刷新 token 的 timer（按 accountId 隔离） */
const tokenRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 清除指定账号的 token 缓存（强制下次重新签票）
 *
 * @param accountId - 要清除缓存的Account ID
 */
export function clearSignTokenCache(accountId: string): void {
  tokenCacheMap.delete(accountId);
  const timer = tokenRefreshTimers.get(accountId);
  if (timer) {
    clearTimeout(timer);
    tokenRefreshTimers.delete(accountId);
  }
}

/**
 * 清除所有账号的 token 缓存
 */
export function clearAllSignTokenCache(): void {
  tokenCacheMap.clear();
  for (const timer of tokenRefreshTimers.values()) {
    clearTimeout(timer);
  }
  tokenRefreshTimers.clear();
}

/**
 * 查看 token 缓存状态（用于监控/调试）
 *
 * @param accountId - Account ID
 * @returns 缓存状态对象：status 为当前状态，expiresAt 为过期时间戳（无缓存时为 null）
 */
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

/**
 * 从签票缓存中获取 bot_id（同步，仅在已签过票且缓存有效时返回）
 *
 * @param accountId - Account ID
 * @returns 缓存中的 bot_id，若无缓存或已过期则返回 undefined
 */
export function getCachedBotId(accountId: string): string | undefined {
  const cached = tokenCacheMap.get(accountId);
  if (!cached || cached.expiresAt <= Date.now()) {
    return undefined;
  }
  return cached.data.bot_id || undefined;
}

// ============ 签票（内部） ============

function computeSignature(params: {
  nonce: string;
  timestamp: string;
  appKey: string;
  appSecret: string;
}): string {
  const plain = params.nonce + params.timestamp + params.appKey + params.appSecret;
  return createHmac("sha256", params.appSecret).update(plain).digest("hex");
}

/**
 * 使用恒定时间比较验证 HMAC 签名，防止时序攻击。
 * 使用 === 比较签名字符串时，JavaScript 引擎会在发现第一个不匹配的字符时立即返回 false，攻击者可以通过测量响应时间逐字节推断出正确的签名值。
 *
 * @param expected - 预期签名（hex 字符串）
 * @param actual - 待验证的实际签名（hex 字符串）
 * @returns 签名匹配时返回 true
 */
export function verifySignature(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(actual, "hex");
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * 内部实现：发起签票 HTTP request，支持自动重试（最多 SIGN_MAX_RETRIES 次）。
 *
 * @param account - 账号配置，需包含 appKey、appSecret、apiDomain
 * @param log - 可选日志对象
 * @returns 签票数据（含 token、bot_id 等字段）
 */
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

// ============ 公开：获取 token ============

/**
 * 安排 token 定时刷新。
 *
 * 根据服务端返回的 token 有效期（duration），在到期前 {@link CACHE_REFRESH_MARGIN_MS} 自动重新签票，
 * 保证后续请求始终持有有效 token。刷新失败时会在 30s 后做一次重试，避免 timer 丢失。
 *
 * > Note:`setTimeout` 使用 32 位有符号整数存储延迟，超过 ~24.8 天会溢出为 1ms。
 * > 因此 delay 会被 clamp 到 {@link MAX_SAFE_TIMEOUT_MS}。
 *
 * @param account     - 已解析的元宝账号配置，用于标识缓存 key 和签票参数
 * @param durationSec - 服务端返回的 token 有效期（秒），用于计算下次刷新时间
 * @param log         - 可选的Logger instance，用于记录刷新流程和异常信息
 */
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

  // clamp: 最小 60s，最大 MAX_SAFE_TIMEOUT_MS（防止 setTimeout 32 位整数溢出）
  const rawMs = durationSec * 1000 - CACHE_REFRESH_MARGIN_MS;
  const refreshAfterMs = Math.min(Math.max(rawMs, 60_000), MAX_SAFE_TIMEOUT_MS);
  const clampedHint = rawMs > MAX_SAFE_TIMEOUT_MS ? ", clamped to max safe timeout" : "";
  mlog.info(
    `[${account.accountId}][token-timer] scheduled refresh: ` +
      `${Math.round(refreshAfterMs / 1000)}s 后 (duration=${durationSec}s, ` +
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
      // 定时刷新失败后安排一次短延迟重试，避免 timer 丢失导致再无自动刷新
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

/**
 * 获取签票数据（基于 duration 缓存 + singleflight 并发安全）
 *
 * - 静态 token：直接返回，不走缓存也不调用接口
 * - 缓存命中：直接返回
 * - 缓存未命中/过期：调用接口，并发请求复用同一 Promise
 *
 * @param account - 账号配置（含 appKey/appSecret 或 token）
 * @param log - 可选日志对象
 * @returns 签票数据
 */
export async function getSignToken(
  account: ResolvedYuanbaoAccount,
  log?: Log,
): Promise<SignTokenData> {
  // 静态 token 优先
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

  // Singleflight：已有进行中的请求则复用
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

/**
 * 强制刷新 token（清缓存后重新签票），用于鉴权失败场景。
 *
 * @param account - 账号配置
 * @param log - 可选日志对象
 * @returns 签票数据
 */
export async function forceRefreshSignToken(
  account: ResolvedYuanbaoAccount,
  log?: Log,
): Promise<SignTokenData> {
  const flog = createLog("http", log);
  flog.warn(`[${account.accountId}][force-refresh] clearing cache and re-signing token`);
  clearSignTokenCache(account.accountId);
  // 同时清除进行中的 singleflight promise，确保真正发起新请求而非复用可能已过期的旧结果
  tokenFetchPromises.delete(account.accountId);
  return getSignToken(account, log);
}

/**
 * 获取鉴权请求头（X-ID / X-Token / X-Source），同时回填 account.botId
 */
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

// ============ 内部 HTTP 工具 ============

/**
 * 以 POST 方式调用元宝 API，自动附加鉴权头，统一处理 HTTP 和业务错误。
 *
 * @param account - 账号配置（用于拼接域名和获取鉴权头）
 * @param path - API 路径（如 /api/v5/robotLogic/sign-token）
 * @param body - 请求体（将被 JSON 序列化）
 * @param log - 可选日志对象
 * @returns 响应 data 字段（若无 data 则返回整个响应体）
 */
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

    // HTTP 401: token 过期，强制刷新后重试一次
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

/**
 * 以 GET 方式调用元宝 API，自动附加鉴权头，统一处理 HTTP 和业务错误。
 *
 * @param account - 账号配置（用于拼接域名和获取鉴权头）
 * @param path - API 路径（如 /api/v5/robotLogic/query）
 * @param params - 可选查询参数，将序列化为 URL query string
 * @param log - 可选日志对象
 * @returns 响应 data 字段（若无 data 则返回整个响应体）
 */
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

    // HTTP 401: token 过期，强制刷新后重试一次
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
