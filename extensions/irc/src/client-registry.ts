/**
 * Live IRC client registry.
 *
 * `monitorIrcProvider` registers the active client here after connecting and
 * unregisters it on shutdown. `sendMessageIrc` consults the registry first so
 * outbound messages are delivered over the existing connection rather than
 * opening a redundant transient connection with the same nick.
 */
import type { IrcClient } from "./client.js";

const registry = new Map<string, IrcClient>();

/**
 * Register a live IRC client for an account.
 * Overwrites any previous entry for the same accountId.
 */
export function registerIrcClient(accountId: string, client: IrcClient): void {
  registry.set(accountId, client);
}

/**
 * Unregister the live IRC client for an account (called on monitor shutdown).
 */
export function unregisterIrcClient(accountId: string): void {
  registry.delete(accountId);
}

/**
 * Look up the live IRC client for an account.
 * Returns `undefined` if no client is currently registered or if the
 * registered client is no longer ready.
 */
export function getLiveIrcClient(accountId: string): IrcClient | undefined {
  const client = registry.get(accountId);
  if (!client) {
    return undefined;
  }
  if (!client.isReady()) {
    registry.delete(accountId);
    return undefined;
  }
  return client;
}
