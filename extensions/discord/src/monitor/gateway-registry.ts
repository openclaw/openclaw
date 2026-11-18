import type { GatewayPluginContract } from "../internal/plugin-contract.js";

/**
 * Module-level registry of active Discord GatewayPlugin instances.
 * Bridges the gap between agent tool handlers (which only have REST access)
 * and the gateway WebSocket (needed for operations like updatePresence).
 * Follows the same pattern as presence-cache.ts.
 */
const gatewayRegistry = new Map<string, GatewayPluginContract>();

// Sentinel key for the default (unnamed) account. Uses a prefix that cannot
// collide with user-configured account IDs.
const DEFAULT_ACCOUNT_KEY = "\0__default__";

export function registerGateway(
  accountId: string | undefined,
  gateway: GatewayPluginContract,
): void {
  gatewayRegistry.set(accountId ?? DEFAULT_ACCOUNT_KEY, gateway);
}

export function unregisterGateway(accountId?: string): void {
  gatewayRegistry.delete(accountId ?? DEFAULT_ACCOUNT_KEY);
}

export function getGateway(accountId?: string): GatewayPluginContract | undefined {
  return gatewayRegistry.get(accountId ?? DEFAULT_ACCOUNT_KEY);
}

export function clearGateways(): void {
  gatewayRegistry.clear();
}
