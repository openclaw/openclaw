/**
 * Multi-account registry for Matrix recovery key handlers.
 * Allows CLI and gateway RPC to access handler instances per account.
 */

import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { RecoveryKeyHandler } from "./handler.js";
import type { RecoveryKeyStore } from "./store.js";

const handlers = new Map<string, RecoveryKeyHandler>();
const stores = new Map<string, RecoveryKeyStore>();

/**
 * Register the recovery key handler instance (called by monitor on startup).
 * @param handler - The recovery key handler instance to register
 * @param accountId - Optional account identifier (defaults to "default")
 */
export function registerMatrixRecoveryKeyHandler(
  handler: RecoveryKeyHandler,
  accountId?: string | null,
): void {
  const normalizedId = normalizeAccountId(accountId);
  handlers.set(normalizedId, handler);
  stores.set(normalizedId, handler.getStore());
}

/**
 * Get the registered recovery key handler instance for the specified account.
 * @param accountId - Optional account identifier (defaults to "default")
 * @returns The handler instance or null if not registered
 */
export function getMatrixRecoveryKeyHandler(accountId?: string | null): RecoveryKeyHandler | null {
  const normalizedId = normalizeAccountId(accountId);
  return handlers.get(normalizedId) ?? null;
}

/**
 * Unregister the recovery key handler for the specified account (called on shutdown).
 * @param accountId - Optional account identifier (defaults to "default")
 * @returns True if an account was unregistered, false if it was not found
 */
export function unregisterMatrixRecoveryKeyHandler(accountId?: string | null): boolean {
  const normalizedId = normalizeAccountId(accountId);
  const hadHandler = handlers.delete(normalizedId);
  stores.delete(normalizedId);
  return hadHandler;
}

/**
 * Get the verification store for the specified account.
 * @param accountId - Optional account identifier (defaults to "default")
 * @returns The verification store or null if not registered
 */
export function getMatrixVerificationStore(accountId?: string | null): RecoveryKeyStore | null {
  const normalizedId = normalizeAccountId(accountId);
  return stores.get(normalizedId) ?? null;
}

/**
 * List all registered account identifiers.
 * @returns Array of account IDs that have registered handlers
 */
export function listRegisteredAccounts(): string[] {
  return Array.from(handlers.keys());
}
