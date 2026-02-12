/**
 * DingTalk Access Token Manager.
 * Handles token caching with automatic refresh before expiration.
 */

import type { ResolvedDingTalkAccount } from "../accounts.js";
import type { StreamLogger } from "../stream/types.js";

/**
 * Cached token entry.
 */
interface CachedToken {
  accessToken: string;
  expireAt: number; // Unix timestamp ms
}

/**
 * Token manager interface.
 */
export interface TokenManager {
  getToken(): Promise<string>;
  invalidate(): void;
}

/**
 * Token manager options.
 */
export interface TokenManagerOptions {
  clientId: string;
  clientSecret: string;
  apiBase: string;
  logger?: StreamLogger;
}

// Refresh token 5 minutes before expiry
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Default token TTL if not provided (2 hours)
const DEFAULT_TOKEN_TTL_SECONDS = 7200;

/**
 * Global token cache keyed by clientId.
 */
const tokenCache = new Map<string, CachedToken>();

/**
 * Pending token fetch promises to prevent duplicate requests.
 */
const pendingFetches = new Map<string, Promise<string>>();

/**
 * Fetch a new access token from DingTalk OAuth API.
 */
async function fetchAccessToken(opts: TokenManagerOptions): Promise<string> {
  const { clientId, clientSecret, apiBase, logger } = opts;
  const url = `${apiBase}/v1.0/oauth2/accessToken`;

  logger?.debug?.({ clientId }, "Fetching new access token");

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appKey: clientId,
      appSecret: clientSecret,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => "");
    logger?.error?.(
      { status: resp.status, error: errorText.slice(0, 200) },
      "Failed to get access token",
    );
    throw new Error(`Failed to get access token: HTTP ${resp.status} - ${errorText.slice(0, 200)}`);
  }

  const data = (await resp.json()) as {
    accessToken?: string;
    expireIn?: number;
  };

  if (!data.accessToken) {
    logger?.error?.({ data }, "Invalid access token response");
    throw new Error("Invalid access token response: missing accessToken");
  }

  // Cache the token
  const expireIn = data.expireIn ?? DEFAULT_TOKEN_TTL_SECONDS;
  tokenCache.set(clientId, {
    accessToken: data.accessToken,
    expireAt: Date.now() + expireIn * 1000,
  });

  logger?.debug?.({ clientId, expireIn }, "Access token obtained and cached");

  return data.accessToken;
}

/**
 * Get access token with caching and automatic refresh.
 */
async function getAccessTokenWithCache(opts: TokenManagerOptions): Promise<string> {
  const { clientId } = opts;
  const now = Date.now();

  // Check cache
  const cached = tokenCache.get(clientId);
  if (cached && cached.expireAt - now > TOKEN_REFRESH_MARGIN_MS) {
    return cached.accessToken;
  }

  // Check for pending fetch
  const pending = pendingFetches.get(clientId);
  if (pending) {
    return pending;
  }

  // Start new fetch
  const fetchPromise = fetchAccessToken(opts);
  pendingFetches.set(clientId, fetchPromise);

  try {
    return await fetchPromise;
  } finally {
    pendingFetches.delete(clientId);
  }
}

/**
 * Create a token manager for a DingTalk account.
 */
export function createTokenManager(opts: TokenManagerOptions): TokenManager {
  const { clientId } = opts;

  return {
    getToken: () => getAccessTokenWithCache(opts),
    invalidate: () => {
      tokenCache.delete(clientId);
    },
  };
}

/**
 * Create a token manager from a resolved DingTalk account.
 */
export function createTokenManagerFromAccount(
  account: ResolvedDingTalkAccount,
  logger?: StreamLogger,
): TokenManager {
  return createTokenManager({
    clientId: account.clientId,
    clientSecret: account.clientSecret,
    apiBase: account.apiBase,
    logger,
  });
}

/**
 * Clear all cached tokens.
 * Useful for testing or when credentials are rotated.
 */
export function clearAllTokens(): void {
  tokenCache.clear();
}

/**
 * Invalidate token for a specific client.
 */
export function invalidateToken(clientId: string): void {
  tokenCache.delete(clientId);
}
