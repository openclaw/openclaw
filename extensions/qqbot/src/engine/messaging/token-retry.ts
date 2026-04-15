/**
 * Token-retry wrapper — automatically retry an API call once when the
 * access token appears to have expired (HTTP 401 or token-related error).
 *
 * This replaces `sendWithTokenRetry` from `reply-dispatcher.ts` with a
 * framework-independent implementation that works with the core
 * `TokenManager`.
 */

import type { TokenManager } from "../api/token.js";
import type { ApiLogger } from "../types.js";

/**
 * Execute `sendFn(token)` and retry once if the error looks like a token
 * expiration (401, "token", "access_token" in the error message).
 *
 * On the retry path the cached token is cleared first, forcing a fresh
 * fetch from the QQ Open Platform.
 *
 * @param tokenManager - TokenManager instance for token operations.
 * @param appId - QQ Bot application ID.
 * @param clientSecret - QQ Bot client secret.
 * @param sendFn - Async function that receives a token and performs the API call.
 * @param logger - Optional logger for retry diagnostics.
 * @returns The result of `sendFn`.
 */
export async function sendWithTokenRetry<T>(
  tokenManager: TokenManager,
  appId: string,
  clientSecret: string,
  sendFn: (token: string) => Promise<T>,
  logger?: ApiLogger,
): Promise<T> {
  try {
    const token = await tokenManager.getAccessToken(appId, clientSecret);
    return await sendFn(token);
  } catch (err) {
    const errMsg = String(err);
    if (isTokenExpiredError(errMsg)) {
      logger?.info?.(`[token-retry:${appId}] Token may be expired, refreshing...`);
      tokenManager.clearCache(appId);
      const newToken = await tokenManager.getAccessToken(appId, clientSecret);
      return await sendFn(newToken);
    }
    throw err;
  }
}

/** Determine whether an error message indicates a token expiration. */
function isTokenExpiredError(msg: string): boolean {
  return msg.includes("401") || msg.includes("token") || msg.includes("access_token");
}
