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
const tokenManagerCache = new Map<string, TokenManager>();

/**
 * Get or create a token manager for a DingTalk account.
 * Token managers are cached by accountId to reuse access tokens.
 */
export function getOrCreateTokenManager(
  account: ResolvedDingTalkAccount,
  logger?: StreamLogger
): TokenManager {
  const existing = tokenManagerCache.get(account.accountId);
  if (existing) {
    return existing;
  }

  const manager = createTokenManagerFromAccount(account, logger);
  tokenManagerCache.set(account.accountId, manager);
  return manager;
}

/**
 * Invalidate token manager for a specific account.
 * Call this when credentials are rotated.
 */
export function invalidateTokenManager(accountId: string): void {
  const manager = tokenManagerCache.get(accountId);
  if (manager) {
    manager.invalidate();
    tokenManagerCache.delete(accountId);
  }
}

/**
 * Clear all token managers.
 * Useful for cleanup or testing.
 */
export function clearTokenManagers(): void {
  for (const manager of tokenManagerCache.values()) {
    manager.invalidate();
  }
  tokenManagerCache.clear();
  clearAllTokens();
}
