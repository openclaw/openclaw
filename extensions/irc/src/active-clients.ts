import type { IrcClient } from "./client.js";

/**
 * Registry of active IRC clients from the monitor.
 * Keyed by accountId. Allows sendMessageIrc to use the persistent
 * monitor client instead of creating a transient connection.
 */
const activeClients = new Map<string, IrcClient>();

export function setActiveClient(accountId: string, client: IrcClient): void {
  activeClients.set(accountId, client);
}

export function getActiveClient(accountId: string): IrcClient | undefined {
  const client = activeClients.get(accountId);
  if (client && client.isReady()) {
    return client;
  }
  return undefined;
}

export function removeActiveClient(accountId: string): void {
  activeClients.delete(accountId);
}

/**
 * Only remove the active client if it matches the expected instance.
 * Prevents a stopping monitor from deregistering a newer monitor's
 * healthy client during reconnect races.
 */
export function removeActiveClientIfMatch(accountId: string, expected: IrcClient): void {
  if (activeClients.get(accountId) === expected) {
    activeClients.delete(accountId);
  }
}
