import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import { resolvePluginSetupCliBackendRuntime } from "../plugins/setup-registry.runtime.js";
import { normalizeProviderId } from "./model-selection-normalize.js";

// `isCliProvider` checks three sources in order:
//   1. `cfg.agents.defaults.cliBackends` — declared on the live config.
//   2. `resolveRuntimeCliBackends()`     — the *active* plugin runtime registry.
//   3. `resolvePluginSetupCliBackendRuntime` — setup-manifest lookup, which
//      executes the owning plugin's `setup` register callback on every call
//      to discover declared CLI backends. ~29 ms / call on a clean install
//      with the bundled plugin set.
//
// `openclaw status` / `openclaw doctor` resolve a runtime label for every
// session row in `commands/status.summary.ts`'s `buildSessionRows`, which
// turns the third branch into an O(N × 29 ms) cost and pushes the command
// past `--timeout` once the session store grows past ~30 entries.
//
// Only the third branch is memoizable: (1) reads the live config directly
// and is microsecond-cheap; (2) reads the active runtime plugin registry
// which can change as plugins finish loading mid-process — caching its
// answer per `(cfg, provider)` would lock in a stale `false` once a CLI
// backend becomes available later. (3) depends on the on-disk setup
// manifest set, which is stable for the lifetime of a process unless the
// caller installs/updates plugins. New plugin installs typically reload
// the active config, producing a new config reference; the `WeakMap` key
// boundary naturally invalidates the cache then.
//
// A null/undefined `cfg` is keyed on a frozen sentinel because `WeakMap`
// requires object keys.
const NULL_CONFIG_KEY: object = Object.freeze({});

function configCacheKey(cfg: OpenClawConfig | undefined): object {
  return cfg ?? NULL_CONFIG_KEY;
}

const setupCliBackendCache = new WeakMap<object, Map<string, boolean>>();

export function __resetIsCliProviderCacheForTest(): void {
  setupCliBackendCache.delete(NULL_CONFIG_KEY);
}

function isMemoizedSetupCliBackend(normalized: string, cfg: OpenClawConfig | undefined): boolean {
  const key = configCacheKey(cfg);
  let perConfig = setupCliBackendCache.get(key);
  if (perConfig) {
    const cached = perConfig.get(normalized);
    if (cached !== undefined) {
      return cached;
    }
  } else {
    perConfig = new Map();
    setupCliBackendCache.set(key, perConfig);
  }
  const result = Boolean(resolvePluginSetupCliBackendRuntime({ backend: normalized, config: cfg }));
  perConfig.set(normalized, result);
  return result;
}

export function isCliProvider(provider: string, cfg?: OpenClawConfig): boolean {
  const normalized = normalizeProviderId(provider);
  const backends = cfg?.agents?.defaults?.cliBackends ?? {};
  if (Object.keys(backends).some((key) => normalizeProviderId(key) === normalized)) {
    return true;
  }
  const cliBackends = resolveRuntimeCliBackends();
  if (cliBackends.some((backend) => normalizeProviderId(backend.id) === normalized)) {
    return true;
  }
  return isMemoizedSetupCliBackend(normalized, cfg);
}
