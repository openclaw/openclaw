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

export type GatewayCfg = unknown;

export type GatewayCfgFetcher = () => GatewayCfg | undefined;

export interface ActiveCfgProvider {
  getActiveCfg(): GatewayCfg;
}

export interface ActiveCfgProviderOptions {
  fallback: GatewayCfg;
  fetch?: GatewayCfgFetcher;
}

export function createActiveCfgProvider(options: ActiveCfgProviderOptions): ActiveCfgProvider {
  const fetch = options.fetch ?? defaultGatewayCfgFetcher;
  const fallback = options.fallback;
  return {
    getActiveCfg(): GatewayCfg {
      return resolveActiveCfg(fetch, fallback);
    },
  };
}

export function resolveActiveCfg(fetch: GatewayCfgFetcher, fallback: GatewayCfg): GatewayCfg {
  let fresh: GatewayCfg | undefined;
  try {
    fresh = fetch();
  } catch {
    return fallback;
  }
  return fresh ?? fallback;
}

function defaultGatewayCfgFetcher(): GatewayCfg | undefined {
  return getRuntimeConfig();
}
