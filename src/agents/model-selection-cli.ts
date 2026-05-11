import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import { resolvePluginSetupCliBackendRuntime } from "../plugins/setup-registry.runtime.js";
import { normalizeProviderId } from "./model-selection-normalize.js";

// Per-config memoization for isCliProvider lookups. The third branch below
// (`resolvePluginSetupCliBackendRuntime`) executes the owning plugin's setup
// register callback to discover declared CLI backends; that work scales the
// `openclaw status` / `openclaw doctor` session-summary loop linearly with
// session count and dominates command runtime past ~30 sessions (the
// `buildSessionRows` hot path in `commands/status.summary.ts` resolves the
// runtime label for every row).
//
// The result of `isCliProvider(provider, cfg)` depends only on the normalized
// provider id and the live config object. Config objects are passed by
// reference and treated as immutable for the lifetime of a command, so a
// WeakMap keyed by the config and a Map keyed by the normalized provider id
// gives correct memoization without retaining configs that the runtime has
// already released. A null/undefined config is keyed separately on a sentinel
// because WeakMap requires object keys.
const NULL_CONFIG_KEY: object = Object.freeze({});

function configCacheKey(cfg: OpenClawConfig | undefined): object {
  return cfg ?? NULL_CONFIG_KEY;
}

const isCliProviderCache = new WeakMap<object, Map<string, boolean>>();

export function __resetIsCliProviderCacheForTest(): void {
  isCliProviderCache.delete(NULL_CONFIG_KEY);
}

function computeIsCliProvider(normalized: string, cfg: OpenClawConfig | undefined): boolean {
  const backends = cfg?.agents?.defaults?.cliBackends ?? {};
  if (Object.keys(backends).some((key) => normalizeProviderId(key) === normalized)) {
    return true;
  }
  const cliBackends = resolveRuntimeCliBackends();
  if (cliBackends.some((backend) => normalizeProviderId(backend.id) === normalized)) {
    return true;
  }
  if (resolvePluginSetupCliBackendRuntime({ backend: normalized, config: cfg })) {
    return true;
  }
  return false;
}

export function isCliProvider(provider: string, cfg?: OpenClawConfig): boolean {
  const normalized = normalizeProviderId(provider);
  const key = configCacheKey(cfg);
  let perConfig = isCliProviderCache.get(key);
  if (perConfig) {
    const cached = perConfig.get(normalized);
    if (cached !== undefined) {
      return cached;
    }
  } else {
    perConfig = new Map();
    isCliProviderCache.set(key, perConfig);
  }
  const result = computeIsCliProvider(normalized, cfg);
  perConfig.set(normalized, result);
  return result;
}
