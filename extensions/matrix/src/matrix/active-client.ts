import type { MatrixClient } from "@vector-im/matrix-bot-sdk";

const DEFAULT_KEY = "default";

/** Map of accountId → active MatrixClient for each running account. */
const activeClients = new Map<string, MatrixClient>();

export function setActiveMatrixClient(
  client: MatrixClient | null,
  accountId?: string | null,
): void {
  const key = accountId ?? DEFAULT_KEY;
  if (client) {
    activeClients.set(key, client);
  } else {
    activeClients.delete(key);
  }
}

/**
 * Get the active client for a specific accountId.
 * Falls back to the default account if no accountId is specified.
 * If only one account is active and no accountId is given, returns that one.
 */
export function getActiveMatrixClient(accountId?: string | null): MatrixClient | null {
  const key = accountId ?? DEFAULT_KEY;
  const exact = activeClients.get(key);
  if (exact) {
    return exact;
  }
  // If no accountId specified and no default, return the only active client if there's exactly one
  if (!accountId && activeClients.size === 1) {
    return activeClients.values().next().value ?? null;
  }
  return null;
}
