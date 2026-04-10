import { BskyAgent } from "@atproto/api";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

/**
 * The DID of the Bluesky central chat service.
 * All chat.bsky.* lexicon calls must be proxied through this service.
 */
export const CHAT_SERVICE_DID = "did:web:api.bsky.chat";

/**
 * Base URL of the Bluesky chat service used for direct API calls with service tokens.
 */
export const CHAT_SERVICE_URL = "https://api.bsky.chat";

type CachedToken = {
  token: string;
  /** Absolute ms timestamp after which the token must not be used */
  expiresAt: number;
};

/**
 * Per-agent token cache: `${did}:${lxm}` → CachedToken.
 * Tokens are valid for 30 min; we cache for 25 min to avoid races.
 */
const tokenCache = new Map<string, CachedToken>();
const TOKEN_TTL_MS = 25 * 60 * 1000;

function tokenCacheKey(did: string, lxm: string): string {
  return `${did}:${lxm}`;
}

/**
 * Obtain a short-lived service auth JWT for a specific chat lexicon method.
 * Results are cached for 25 minutes (tokens expire at 30 min).
 */
export async function getChatServiceToken(agent: BskyAgent, lxm: string): Promise<string> {
  const did = agent.session?.did;
  if (!did) {
    throw new Error("Bluesky agent has no active session; login required before fetching tokens");
  }
  const key = tokenCacheKey(did, lxm);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  logVerbose(`Bluesky: fetching service auth token for ${lxm}`);
  const res = await agent.api.com.atproto.server.getServiceAuth({
    aud: CHAT_SERVICE_DID,
    lxm,
  });
  const token = res.data.token;
  tokenCache.set(key, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

/** Evict all cached tokens for a given DID (call after re-login). */
export function evictChatServiceTokens(did: string): void {
  for (const key of tokenCache.keys()) {
    if (key.startsWith(`${did}:`)) {
      tokenCache.delete(key);
    }
  }
}

/** Evict the cached token for a specific DID + lexicon method. */
function evictChatServiceToken(did: string, lxm: string): void {
  tokenCache.delete(tokenCacheKey(did, lxm));
}

/**
 * Make a GET request to a chat.bsky.* lexicon endpoint using a fresh service token.
 * The token is scoped to the specific lexicon method (lxm).
 */
export async function chatApiGet<T>(
  agent: BskyAgent,
  lxm: string,
  params: Record<string, string | number | undefined>,
): Promise<T> {
  const did = agent.session?.did ?? "";
  const url = new URL(`${CHAT_SERVICE_URL}/xrpc/${lxm}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) {
      url.searchParams.set(k, String(v));
    }
  }
  const urlStr = url.toString();

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getChatServiceToken(agent, lxm);
    const res = await fetch(urlStr, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && attempt === 0) {
      // Token expired server-side — evict cache and retry once
      evictChatServiceToken(did, lxm);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable)");
      throw new Error(`Bluesky chat API GET ${lxm} failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<T>;
  }
  throw new Error(`Bluesky chat API GET ${lxm} failed after token refresh`);
}

/**
 * Make a POST request to a chat.bsky.* lexicon endpoint using a fresh service token.
 */
export async function chatApiPost<T>(agent: BskyAgent, lxm: string, body: unknown): Promise<T> {
  const did = agent.session?.did ?? "";
  const bodyStr = JSON.stringify(body);

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getChatServiceToken(agent, lxm);
    const res = await fetch(`${CHAT_SERVICE_URL}/xrpc/${lxm}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: bodyStr,
    });
    if (res.status === 401 && attempt === 0) {
      // Token expired server-side — evict cache and retry once
      evictChatServiceToken(did, lxm);
      continue;
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "(unreadable)");
      throw new Error(`Bluesky chat API POST ${lxm} failed (${res.status}): ${bodyText}`);
    }
    return res.json() as Promise<T>;
  }
  throw new Error(`Bluesky chat API POST ${lxm} failed after token refresh`);
}

/** Login to a Bluesky PDS and return an authenticated agent. */
export async function loginBluesky(params: {
  handle: string;
  appPassword: string;
  pdsUrl: string;
}): Promise<BskyAgent> {
  const agent = new BskyAgent({ service: params.pdsUrl });
  await agent.login({ identifier: params.handle, password: params.appPassword });
  return agent;
}
