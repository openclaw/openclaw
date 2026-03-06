import type { ResolvedLanxinAccount } from "./types.js";

type TokenCacheEntry = {
  token: string;
  expiresAt: number;
};

const tokenCache = new Map<string, TokenCacheEntry>();
const TOKEN_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

function buildTokenUrl(account: ResolvedLanxinAccount): URL {
  const url = new URL("apptoken/create", account.apiBaseUrl);
  url.searchParams.set("grant_type", "client_credential");
  url.searchParams.set("appid", account.appId ?? "");
  url.searchParams.set("secret", account.appSecret ?? "");
  return url;
}

function cacheKey(account: ResolvedLanxinAccount): string {
  return `${account.accountId}:${account.apiBaseUrl}:${account.appId ?? ""}`;
}

export async function getLanxinValidToken(account: ResolvedLanxinAccount): Promise<string> {
  if (!account.appId || !account.appSecret) {
    throw new Error("Lanxin credentials are missing");
  }
  const key = cacheKey(account);
  const now = Date.now();
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > now + TOKEN_SKEW_MS) {
    return cached.token;
  }

  const response = await fetch(buildTokenUrl(account), {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Lanxin token request failed: HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    errCode?: number;
    errMsg?: string;
    data?: { app_token?: string; expires_in?: number };
  };
  if (data.errCode !== 0 || !data.data?.app_token) {
    throw new Error(
      `Lanxin token request returned errCode=${data.errCode ?? "unknown"} errMsg=${data.errMsg ?? "unknown"}`,
    );
  }
  const ttlMs = Math.max(60_000, (data.data.expires_in ?? DEFAULT_TTL_MS / 1000) * 1000);
  tokenCache.set(key, { token: data.data.app_token, expiresAt: now + ttlMs });
  return data.data.app_token;
}
