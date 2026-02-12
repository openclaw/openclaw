import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { ResolvedDingTalkAccount } from "./accounts.js";
import type { StreamLogger } from "./stream/types.js";
import {
  createTokenManagerFromAccount,
  clearAllTokens,
  type TokenManager,
} from "./api/token-manager.js";

let runtime: PluginRuntime | null = null;

export function setDingTalkRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getDingTalkRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("DingTalk runtime not initialized");
  }
  return runtime;
}

/**
 * Token manager cache keyed by accountId.
 */
type TokenManagerEntry = {
  manager: TokenManager;
  cacheKey: string;
};

const tokenManagerCache = new Map<string, TokenManagerEntry>();

function buildTokenManagerCacheKey(account: ResolvedDingTalkAccount): string {
  return `${account.clientId}\u0000${account.clientSecret}\u0000${account.apiBase}`;
}

/**
 * Get or create a token manager for a DingTalk account.
 * Token managers are cached by accountId to reuse access tokens.
 */
export function getOrCreateTokenManager(
  account: ResolvedDingTalkAccount,
  logger?: StreamLogger,
): TokenManager {
  const cacheKey = buildTokenManagerCacheKey(account);
  const existing = tokenManagerCache.get(account.accountId);
  if (existing && existing.cacheKey === cacheKey) {
    return existing.manager;
  }
  if (existing) {
    existing.manager.invalidate();
  }

  const manager = createTokenManagerFromAccount(account, logger);
  tokenManagerCache.set(account.accountId, { manager, cacheKey });
  return manager;
}

/**
 * Invalidate token manager for a specific account.
 * Call this when credentials are rotated.
 */
export function invalidateTokenManager(accountId: string): void {
  const entry = tokenManagerCache.get(accountId);
  if (entry) {
    entry.manager.invalidate();
    tokenManagerCache.delete(accountId);
  }
}

/**
 * Clear all token managers.
 * Useful for cleanup or testing.
 */
export function clearTokenManagers(): void {
  for (const entry of tokenManagerCache.values()) {
    entry.manager.invalidate();
  }
  tokenManagerCache.clear();
  clearAllTokens();
}
