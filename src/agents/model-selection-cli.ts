import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import { resolvePluginSetupCliBackendRuntime } from "../plugins/setup-registry.runtime.js";
import { normalizeProviderId } from "./model-selection-normalize.js";

const cliProviderResultCache = new Map<string, boolean>();

export const __testing = {
  resetCliProviderCache(): void {
    cliProviderResultCache.clear();
  },
};

function buildCliProviderCacheKey(provider: string, cfg?: OpenClawConfig): string {
  const configuredBackendKeys = Object.keys(cfg?.agents?.defaults?.cliBackends ?? {})
    .map((key) => normalizeProviderId(key))
    .sort()
    .join(",");
  return `${provider}|${configuredBackendKeys}`;
}

export function isCliProvider(provider: string, cfg?: OpenClawConfig): boolean {
  const normalized = normalizeProviderId(provider);
  const cacheKey = buildCliProviderCacheKey(normalized, cfg);
  const cached = cliProviderResultCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const backends = cfg?.agents?.defaults?.cliBackends ?? {};
  let result = false;
  if (Object.keys(backends).some((key) => normalizeProviderId(key) === normalized)) {
    result = true;
  } else {
    const cliBackends = resolveRuntimeCliBackends();
    if (cliBackends.some((backend) => normalizeProviderId(backend.id) === normalized)) {
      result = true;
    } else if (resolvePluginSetupCliBackendRuntime({ backend: normalized, config: cfg })) {
      result = true;
    }
  }

  cliProviderResultCache.set(cacheKey, result);
  return result;
}
