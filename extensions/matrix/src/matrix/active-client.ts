import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";

/** Per-account active client registry. */
const activeClients = new Map<string, MatrixClient>();

/**
 * Legacy single-client getter — returns the default account's client
 * or the first available client when no default is registered.
 */
export function getActiveMatrixClient(accountId?: string | null): MatrixClient | null {
  const key = normalizeAccountId(accountId);
  const exact = activeClients.get(key);
  if (exact) {
    return exact;
  }
  // Fallback: if asking for default and there's exactly one client, return it.
  if (key === DEFAULT_ACCOUNT_ID && activeClients.size === 1) {
    return activeClients.values().next().value ?? null;
  }
  return null;
}

export function setActiveMatrixClient(
  client: MatrixClient | null,
  accountId?: string | null,
): void {
  const key = normalizeAccountId(accountId);
  if (client) {
    activeClients.set(key, client);
  } else {
    activeClients.delete(key);
  }
}

/** Return all registered account IDs with active clients. */
export function listActiveMatrixAccountIds(): string[] {
  return [...activeClients.keys()];
}
