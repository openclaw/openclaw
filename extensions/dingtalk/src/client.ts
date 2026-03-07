/**
 * DingTalk Stream SDK client wrapper
 *
 * Provides:
 * - DWClient instance creation and caching
 * - Access Token acquisition and cache management
 */

import { DWClient } from "dingtalk-stream";
import { resolveDingtalkCredentials, type DingtalkConfig } from "./config.js";
import { dingtalkLogger } from "./logger.js";

// ============================================================================
// DWClient Wrapper
// ============================================================================

interface DingtalkClientOptions {
  clientId: string;
  clientSecret: string;
}

/** Cached client instance */
let cachedClient: DWClient | null = null;
/** Cached config (used to compare if client needs to be rebuilt) */
let cachedConfig: { clientId: string; clientSecret: string } | null = null;

/**
 * Create DingTalk Stream client
 *
 * If a client instance with the same config already exists, returns the cached instance.
 *
 * @param opts Client configuration options
 * @returns DWClient instance
 */
export function createDingtalkClient(opts: DingtalkClientOptions): DWClient {
  // Check if cache is available
  if (
    cachedClient &&
    cachedConfig &&
    cachedConfig.clientId === opts.clientId &&
    cachedConfig.clientSecret === opts.clientSecret
  ) {
    return cachedClient;
  }

  // Create new client
  const client = new DWClient({
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
  });

  // Update cache
  cachedClient = client;
  cachedConfig = {
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
  };

  return client;
}

/**
 * Create DingTalk Stream client from config
 *
 * @param cfg DingTalk configuration
 * @returns DWClient instance
 * @throws Error if credentials not configured
 */
export function createDingtalkClientFromConfig(cfg: DingtalkConfig): DWClient {
  const creds = resolveDingtalkCredentials(cfg);
  if (!creds) {
    throw new Error("DingTalk credentials not configured (clientId, clientSecret required)");
  }
  return createDingtalkClient(creds);
}

/**
 * Clear client cache
 *
 * Used for testing or scenarios requiring forced client rebuild
 */
export function clearClientCache(): void {
  cachedClient = null;
  cachedConfig = null;
}

// ============================================================================
// Access Token Management
// ============================================================================

/** DingTalk OAuth API endpoint */
const DINGTALK_OAUTH_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken";

/** Token request timeout (milliseconds) */
const TOKEN_REQUEST_TIMEOUT = 10000;

/** Token refresh buffer (milliseconds) - refresh 5 minutes early */
const TOKEN_REFRESH_BUFFER = 5 * 60 * 1000;

/** Token cache structure */
interface TokenCache {
  /** Access token */
  accessToken: string;
  /** Expiration timestamp (milliseconds) */
  expiresAt: number;
  /** Associated clientId (for multi-account scenarios) */
  clientId: string;
}

/** Token cache (indexed by clientId) */
const tokenCacheMap = new Map<string, TokenCache>();

/**
 * Get DingTalk Access Token
 *
 * Implements token caching and auto-refresh:
 * - If cached token is not expired (5 minutes early), return cached token
 * - Otherwise fetch new token from DingTalk OAuth endpoint
 *
 * @param clientId DingTalk application AppKey
 * @param clientSecret DingTalk application AppSecret
 * @returns Access Token string
 * @throws Error if token acquisition fails
 */
export async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const now = Date.now();
  const cached = tokenCacheMap.get(clientId);
  const startTime = Date.now();

  // Check if cache is valid (refresh 5 minutes early)
  if (cached && cached.expiresAt > now + TOKEN_REFRESH_BUFFER) {
    const elapsed = Date.now() - startTime;
    dingtalkLogger.info?.(`[PERF] getAccessToken (cached): ${elapsed}ms`);
    return cached.accessToken;
  }

  // Fetch new token from DingTalk OAuth endpoint
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT);

  try {
    const response = await fetch(DINGTALK_OAUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        appKey: clientId,
        appSecret: clientSecret,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to get DingTalk access token: HTTP ${response.status} - ${errorText}`,
      );
    }

    const data = (await response.json()) as {
      accessToken: string;
      expireIn: number;
    };

    if (!data.accessToken) {
      throw new Error("DingTalk OAuth response missing accessToken");
    }

    // Cache token (expiration time = current time + expireIn seconds)
    const expiresAt = now + data.expireIn * 1000;
    tokenCacheMap.set(clientId, {
      accessToken: data.accessToken,
      expiresAt,
      clientId,
    });

    const elapsed = Date.now() - startTime;
    dingtalkLogger.info?.(
      `[PERF] getAccessToken (fetched): ${elapsed}ms, expires in ${data.expireIn}s`,
    );
    return data.accessToken;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`DingTalk access token request timed out after ${TOKEN_REQUEST_TIMEOUT}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Get Access Token from config
 *
 * @param cfg DingTalk configuration
 * @returns Access Token string
 * @throws Error if credentials not configured or token acquisition fails
 */
export async function getAccessTokenFromConfig(cfg: DingtalkConfig): Promise<string> {
  const creds = resolveDingtalkCredentials(cfg);
  if (!creds) {
    throw new Error("DingTalk credentials not configured (clientId, clientSecret required)");
  }
  return getAccessToken(creds.clientId, creds.clientSecret);
}

/**
 * Clear Token cache
 *
 * @param clientId Optional, specify clientId to clear. If not specified, clear all cache
 */
export function clearTokenCache(clientId?: string): void {
  if (clientId) {
    tokenCacheMap.delete(clientId);
  } else {
    tokenCacheMap.clear();
  }
}

/**
 * Check if Token is cached and valid
 *
 * Used for testing and diagnostics
 *
 * @param clientId DingTalk application AppKey
 * @returns Whether there is a valid cached token
 */
export function isTokenCached(clientId: string): boolean {
  const cached = tokenCacheMap.get(clientId);
  if (!cached) return false;
  return cached.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER;
}

/**
 * Get Token cache info (for testing)
 *
 * @param clientId DingTalk application AppKey
 * @returns Token cache info or undefined
 */
export function getTokenCacheInfo(clientId: string): TokenCache | undefined {
  return tokenCacheMap.get(clientId);
}
