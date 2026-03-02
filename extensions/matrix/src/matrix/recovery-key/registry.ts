import type { RecoveryKeyHandler } from "./handler.js";
import type { RecoveryKeyStore } from "./store.js";

const DEFAULT_ACCOUNT = "default";

const handlerRegistry = new Map<string, RecoveryKeyHandler>();
const storeRegistry = new Map<string, RecoveryKeyStore>();

function resolveAccountKey(accountId?: string | null): string {
  return accountId?.trim() || DEFAULT_ACCOUNT;
}

/** Register a recovery key handler for an account. */
export function registerMatrixRecoveryKeyHandler(
  handler: RecoveryKeyHandler,
  accountId?: string | null,
): void {
  handlerRegistry.set(resolveAccountKey(accountId), handler);
}

/** Retrieve the recovery key handler for an account. */
export function getMatrixRecoveryKeyHandler(
  accountId?: string | null,
): RecoveryKeyHandler | undefined {
  return handlerRegistry.get(resolveAccountKey(accountId));
}

/** Unregister the recovery key handler for an account (cleanup on shutdown). */
export function unregisterMatrixRecoveryKeyHandler(accountId?: string | null): void {
  handlerRegistry.delete(resolveAccountKey(accountId));
  storeRegistry.delete(resolveAccountKey(accountId));
}

/** Register a verification store for status queries. */
export function registerMatrixVerificationStore(
  store: RecoveryKeyStore,
  accountId?: string | null,
): void {
  storeRegistry.set(resolveAccountKey(accountId), store);
}

/** Get the verification store for an account. */
export function getMatrixVerificationStore(
  accountId?: string | null,
): RecoveryKeyStore | undefined {
  return storeRegistry.get(resolveAccountKey(accountId));
}
