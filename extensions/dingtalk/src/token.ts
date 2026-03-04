/**
 * DingTalk access_token for OpenAPI (e.g. send message when sessionWebhook expired).
 * @see https://open-dingtalk.github.io/developerpedia/docs/develop/permission/single_to_multi/new_get_app_token/
 */

const DINGTALK_TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/corpId/token".replace(
  "corpId",
  "{corpId}",
);

const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000; // refresh 5 min before expiry

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();

function cacheKey(corpId: string, clientId: string): string {
  return `${corpId}:${clientId}`;
}

export async function getDingTalkAccessToken(params: {
  corpId: string;
  appKey: string;
  appSecret: string;
  fetch?: typeof globalThis.fetch;
}): Promise<string> {
  const { corpId, appKey, appSecret, fetch: fetcher = globalThis.fetch } = params;
  if (!corpId || !appKey || !appSecret) {
    throw new Error("DingTalk: corpId, appKey and appSecret are required for access_token");
  }
  const key = cacheKey(corpId, appKey);
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now + REFRESH_BEFORE_EXPIRY_MS) {
    return existing.accessToken;
  }

  const url = DINGTALK_TOKEN_URL.replace("{corpId}", encodeURIComponent(corpId));
  const res = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: appKey,
      client_secret: appSecret,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DingTalk token API error ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  const accessToken = data.access_token;
  if (!accessToken) {
    throw new Error("DingTalk token API did not return access_token");
  }
  const expiresIn = (data.expires_in ?? 7200) * 1000;
  cache.set(key, {
    accessToken,
    expiresAt: now + expiresIn,
  });
  return accessToken;
}

/** Clear token cache (e.g. for tests). */
export function clearDingTalkTokenCache(): void {
  cache.clear();
}
