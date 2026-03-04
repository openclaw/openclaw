/**
 * QQ Bot getAppAccessToken.
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html
 */

const QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();

function cacheKey(appId: string): string {
  return appId;
}

export async function getQQAccessToken(params: {
  appId: string;
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
}): Promise<string> {
  const { appId, clientSecret, fetch: fetcher = globalThis.fetch } = params;
  if (!appId || !clientSecret) {
    throw new Error("QQ: appId and clientSecret are required for access_token");
  }
  const key = cacheKey(appId);
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now + REFRESH_BEFORE_EXPIRY_MS) {
    return existing.accessToken;
  }

  const res = await fetcher(QQ_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId, clientSecret }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QQ token API error ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number | string };
  const accessToken = data.access_token;
  if (!accessToken) {
    throw new Error("QQ token API did not return access_token");
  }
  const expiresIn =
    (typeof data.expires_in === "string" ? parseInt(data.expires_in, 10) : data.expires_in) ?? 7200;
  cache.set(key, {
    accessToken,
    expiresAt: now + expiresIn * 1000,
  });
  return accessToken;
}

export function clearQQTokenCache(): void {
  cache.clear();
}
