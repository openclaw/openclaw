import type { ClaworksRuntime } from "@claworks/runtime";
import type { ClaworksBridge } from "./bridge.js";

type ClaworksRobotRuntimeStore = {
  runtime: ClaworksRuntime | null;
  bridge: ClaworksBridge | null;
};

const STORE_KEY = Symbol.for("claworks-robot.runtime-store");

function getStore(): ClaworksRobotRuntimeStore {
  const g = globalThis as typeof globalThis & {
    [STORE_KEY]?: ClaworksRobotRuntimeStore;
  };
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = { runtime: null, bridge: null };
  }
  return g[STORE_KEY];
}

/**
 * Process-global store keyed by `Symbol.for("claworks-robot.runtime-store")`.
 *
 * Contract: the gateway may load this plugin twice (route registration pass + full
 * service pass). Both module instances must read/write the same runtime + bridge refs.
 * See `runtime-store.test.ts` and `scripts/claworks-gateway-e2e.mjs`.
 */
export function getClaworksRobotRuntime(): ClaworksRuntime | null {
  return getStore().runtime;
}

export function setClaworksRobotRuntime(runtime: ClaworksRuntime | null): void {
  getStore().runtime = runtime;
}

export function getClaworksRobotBridge(): ClaworksBridge | null {
  return getStore().bridge;
}

export function setClaworksRobotBridge(bridge: ClaworksBridge | null): void {
  getStore().bridge = bridge;
}

/** Drop refs and remove the global slot (stop/shutdown + tests). */
export function clearClaworksRobotRuntimeStore(): void {
  const g = globalThis as typeof globalThis & {
    [STORE_KEY]?: ClaworksRobotRuntimeStore;
  };
  const store = g[STORE_KEY];
  if (store) {
    store.runtime = null;
    store.bridge = null;
  }
  delete g[STORE_KEY];
}

export function resetClaworksRobotRuntimeStoreForTest(): void {
  clearClaworksRobotRuntimeStore();
}
