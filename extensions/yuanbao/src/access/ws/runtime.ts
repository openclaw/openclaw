/**
 * WebSocket client multi-account storage
 *
 * Uses Map<accountId, WsClient> to manage concurrent connections.
 * Each account's WsClient reference is stored when the ws-gateway starts
 * and consumed by the outbound sendText path.
 */
import type { YuanbaoWsClient } from "./client.js";

const activeClients = new Map<string, YuanbaoWsClient>();

/**
 * Store a WebSocket client reference for the given account.
 */
export function setActiveWsClient(accountId: string, client: YuanbaoWsClient | null): void {
  if (client) {
    activeClients.set(accountId, client);
  } else {
    activeClients.delete(accountId);
  }
}

/**
 * Get the WebSocket client reference for the given account.
 */
export function getActiveWsClient(accountId: string): YuanbaoWsClient | null {
  return activeClients.get(accountId) ?? null;
}

/**
 * Get all active WebSocket clients.
 */
export function getAllActiveWsClients(): ReadonlyMap<string, YuanbaoWsClient> {
  return activeClients;
}
