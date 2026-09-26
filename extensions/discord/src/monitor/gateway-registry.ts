import type { GatewayPlugin } from "../internal/gateway.js";

/**
 * Module-level registry of active Discord GatewayPlugin instances.
 * Bridges the gap between agent tool handlers (which only have REST access)
 * and the gateway WebSocket (needed for operations like updatePresence).
 * Follows the same pattern as presence-cache.ts.
 */
const gatewayRegistry = new Map<string, GatewayPlugin>();

// Sentinel key for the default (unnamed) account. Uses a prefix that cannot
// collide with user-configured account IDs.
const DEFAULT_ACCOUNT_KEY = "\0__default__";

function resolveAccountKey(accountId?: string): string {
  return accountId ?? DEFAULT_ACCOUNT_KEY;
}

export function registerGateway(accountId: string | undefined, gateway: GatewayPlugin): void {
  gatewayRegistry.set(resolveAccountKey(accountId), gateway);
}

export function unregisterGateway(accountId?: string): void {
  gatewayRegistry.delete(resolveAccountKey(accountId));
}

export function getGateway(accountId?: string): GatewayPlugin | undefined {
  return gatewayRegistry.get(resolveAccountKey(accountId));
}

export function clearGateways(): void {
  gatewayRegistry.clear();
}
