import axios from "axios";
import type { ResolvedDingtalkAccount } from "./types.js";

// 钉钉 API 基础 URL / DingTalk API base URLs
const DINGTALK_API_BASE = "https://api.dingtalk.com";
const DINGTALK_OAPI_BASE = "https://oapi.dingtalk.com";

// AccessToken 缓存 / AccessToken cache
type TokenCacheEntry = {
  accessToken: string;
  expiresAt: number;
};

const tokenCache = new Map<string, TokenCacheEntry>();
const oauth2TokenCache = new Map<string, TokenCacheEntry>();

// AccessToken 提前刷新余量（秒） / Token refresh buffer (seconds)
const TOKEN_REFRESH_BUFFER_S = 300;

/**
 * 获取钉钉 AccessToken（带缓存） / Get DingTalk AccessToken (with cache)
 *
 * GET https://oapi.dingtalk.com/gettoken?appkey={clientId}&appsecret={clientSecret}
 */
export async function getAccessToken(account: ResolvedDingtalkAccount): Promise<string> {
  const cacheKey = `${account.accountId}:${account.clientId ?? ""}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.accessToken;
  }

  if (!account.clientId || !account.clientSecret) {
    throw new Error(`DingTalk credentials not configured for account "${account.accountId}"`);
  }

  const res = await axios.get(`${DINGTALK_OAPI_BASE}/gettoken`, {
    params: {
      appkey: account.clientId,
      appsecret: account.clientSecret,
    },
  });

  if (res.status !== 200 || !res.data?.access_token) {
    throw new Error(`Failed to get DingTalk access token: ${JSON.stringify(res.data)}`);
  }

  const accessToken: string = res.data.access_token;
  const expiresIn: number = res.data.expires_in ?? 7200;

  tokenCache.set(cacheKey, {
    accessToken,
    expiresAt: Date.now() + (expiresIn - TOKEN_REFRESH_BUFFER_S) * 1000,
  });

  return accessToken;
}

/**
 * New-style OAuth2 token via POST /v1.0/oauth2/accessToken.
 * Some v1.0 APIs (e.g. messageFiles/download) may require this token type.
 */
export async function getOAuth2AccessToken(account: ResolvedDingtalkAccount): Promise<string> {
  const cacheKey = `${account.accountId}:${account.clientId ?? ""}`;
  const cached = oauth2TokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.accessToken;
  }

  if (!account.clientId || !account.clientSecret) {
    throw new Error(`DingTalk credentials not configured for account "${account.accountId}"`);
  }

  const res = await axios.post(`${DINGTALK_API_BASE}/v1.0/oauth2/accessToken`, {
    appKey: account.clientId,
    appSecret: account.clientSecret,
  });

  if (res.status !== 200 || !res.data?.accessToken) {
    throw new Error(`Failed to get DingTalk OAuth2 access token: ${JSON.stringify(res.data)}`);
  }

  const accessToken: string = res.data.accessToken;
  const expiresIn: number = res.data.expireIn ?? 7200;

  oauth2TokenCache.set(cacheKey, {
    accessToken,
    expiresAt: Date.now() + (expiresIn - TOKEN_REFRESH_BUFFER_S) * 1000,
  });

  return accessToken;
}

/**
 * 调用钉钉新版 API (api.dingtalk.com) / Call DingTalk new API (api.dingtalk.com)
 */
export async function callDingtalkApi<T = unknown>(params: {
  account: ResolvedDingtalkAccount;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  data?: unknown;
  params?: Record<string, string>;
}): Promise<T> {
  const accessToken = await getAccessToken(params.account);
  const res = await axios({
    method: params.method,
    url: `${DINGTALK_API_BASE}${params.path}`,
    data: params.data,
    params: params.params,
    headers: {
      "x-acs-dingtalk-access-token": accessToken,
      "Content-Type": "application/json",
    },
  });
  return res.data as T;
}

/**
 * 调用钉钉旧版 API (oapi.dingtalk.com) / Call DingTalk legacy API (oapi.dingtalk.com)
 */
export async function callDingtalkOapi<T = unknown>(params: {
  account: ResolvedDingtalkAccount;
  method: "GET" | "POST";
  path: string;
  data?: unknown;
  queryParams?: Record<string, string>;
}): Promise<T> {
  const accessToken = await getAccessToken(params.account);
  const res = await axios({
    method: params.method,
    url: `${DINGTALK_OAPI_BASE}${params.path}`,
    data: params.data,
    params: {
      access_token: accessToken,
      ...params.queryParams,
    },
    headers: {
      "Content-Type": "application/json",
    },
  });
  return res.data as T;
}

/**
 * 清除 AccessToken 缓存 / Clear AccessToken cache
 */
export function clearTokenCache(accountId?: string): void {
  if (accountId) {
    for (const key of tokenCache.keys()) {
      if (key.startsWith(`${accountId}:`)) tokenCache.delete(key);
    }
    for (const key of oauth2TokenCache.keys()) {
      if (key.startsWith(`${accountId}:`)) oauth2TokenCache.delete(key);
    }
  } else {
    tokenCache.clear();
    oauth2TokenCache.clear();
  }
}
