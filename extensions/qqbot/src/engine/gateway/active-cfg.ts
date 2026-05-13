/**
 * Active runtime config provider for the QQBot engine.
 *
 * Routing must re-evaluate `bindings[]` on every inbound message so that
 * peer/account binding edits made via the CLI take effect without
 * restarting the gateway. The provider hides the per-event lookup
 * behind a typed seam and falls back to the startup snapshot when the
 * runtime registry is not yet (or no longer) populated.
 *
 * Issue #69546.
 */

import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";

export type GatewayCfg = object;

export type GatewayCfgLoader = () => GatewayCfg | undefined;

export interface ActiveCfgProvider {
  getActiveCfg(): GatewayCfg;
}

export interface ActiveCfgProviderOptions {
  fallback: GatewayCfg;
  load?: GatewayCfgLoader;
}

export function createActiveCfgProvider(options: ActiveCfgProviderOptions): ActiveCfgProvider {
  const load = options.load ?? defaultGatewayCfgLoader;
  const fallback = options.fallback;
  return {
    getActiveCfg(): GatewayCfg {
      return resolveActiveCfg(load, fallback);
    },
  };
}

export function resolveActiveCfg(load: GatewayCfgLoader, fallback: GatewayCfg): GatewayCfg {
  let fresh: GatewayCfg | undefined;
  try {
    fresh = load();
  } catch {
    return fallback;
  }
  return fresh ?? fallback;
}

function defaultGatewayCfgLoader(): GatewayCfg | undefined {
  return getRuntimeConfig();
}
