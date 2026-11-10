import { AsyncLocalStorage } from "node:async_hooks";
/**
 * In-process browser bridge registry keyed by sandbox session.
 *
 * The prune path uses this table to stop bridge servers when backing containers expire.
 */
import { type BrowserBridge, stopBrowserBridgeServer } from "../../plugin-sdk/browser-bridge.js";

export type CachedBrowserBridge = {
  bridge: BrowserBridge;
  containerName: string;
  authToken?: string;
  authPassword?: string;
};

export const BROWSER_BRIDGES = new Map<string, CachedBrowserBridge>();

/** Stop and remove only the cached bridge instance the caller inspected. */
export async function stopCachedBrowserBridge(
  sessionKey: string,
  expected: CachedBrowserBridge,
  assertCurrent?: () => void,
): Promise<void> {
  assertCurrent?.();
  if (BROWSER_BRIDGES.get(sessionKey) !== expected) {
    return;
  }
  await stopBrowserBridgeServer(expected.bridge.server);
  assertCurrent?.();
  if (BROWSER_BRIDGES.get(sessionKey) === expected) {
    BROWSER_BRIDGES.delete(sessionKey);
  }
}

/** Drain every cached bridge that still owns one sandbox container. */
export async function stopCachedBrowserBridgesForContainer(
  containerName: string,
  assertCurrent?: () => void,
): Promise<void> {
  for (;;) {
    const match = [...BROWSER_BRIDGES].find(([, cached]) => cached.containerName === containerName);
    if (!match) {
      return;
    }
    await stopCachedBrowserBridge(match[0], match[1], assertCurrent);
  }
}

/** Attribute newly provisioned bridges to the active embedded one-shot turn. */
const oneShotBridgeOwners = new AsyncLocalStorage<Map<string, CachedBrowserBridge>>();

export function withOneShotBrowserBridgeScope<T>(run: () => Promise<T>): Promise<T> {
  return oneShotBridgeOwners.run(new Map(), run);
}

export function trackOneShotBrowserBridge(key: string, bridge: CachedBrowserBridge): void {
  oneShotBridgeOwners.getStore()?.set(key, bridge);
}

/** Release only the current bridge generations owned by this one-shot turn. */
export async function stopOneShotBrowserBridges(): Promise<void> {
  const owned = oneShotBridgeOwners.getStore();
  if (!owned) {
    return;
  }
  const failures: unknown[] = [];
  for (const [key, bridge] of owned) {
    try {
      await stopCachedBrowserBridge(key, bridge);
    } catch (error) {
      failures.push(error);
    }
  }
  owned.clear();
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to stop one-shot sandbox browser bridges");
  }
}
