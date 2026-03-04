/**
 * WeChat Official Account access_token.
 * @see https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/Get_access_token.html
 */

const WECHAT_TOKEN_URL =
  "https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=APPID&secret=SECRET";
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();

function cacheKey(appId: string): string {
  return appId;
}

export async function getWeChatMPAccessToken(params: {
  appId: string;
  appSecret: string;
  fetch?: typeof globalThis.fetch;
}): Promise<string> {
  const { appId, appSecret, fetch: fetcher = globalThis.fetch } = params;
  if (!appId || !appSecret) {
    throw new Error("WeChat MP: appId and appSecret are required for access_token");
  }
  const key = cacheKey(appId);
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now + REFRESH_BEFORE_EXPIRY_MS) {
    return existing.accessToken;
  }

  const url = WECHAT_TOKEN_URL.replace("APPID", encodeURIComponent(appId)).replace(
    "SECRET",
    encodeURIComponent(appSecret),
  );
  const res = await fetcher(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WeChat MP token API error ${res.status}: ${text}`);
  }
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    errcode?: number;
    errmsg?: string;
  };
  if (data.errcode && data.errcode !== 0) {
    throw new Error(`WeChat MP token API: ${data.errcode} ${data.errmsg ?? ""}`);
  }
  const accessToken = data.access_token;
  if (!accessToken) {
    throw new Error("WeChat MP token API did not return access_token");
  }
  const expiresIn = (data.expires_in ?? 7200) * 1000;
  cache.set(key, { accessToken, expiresAt: now + expiresIn });
  return accessToken;
}

export function clearWeChatMPTokenCache(): void {
  cache.clear();
}
