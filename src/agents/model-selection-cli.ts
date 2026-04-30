import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import { resolvePluginSetupCliBackendRuntime } from "../plugins/setup-registry.runtime.js";
import { normalizeProviderId } from "./model-selection-normalize.js";

const setupCliBackendProviderCache = new Map<string, boolean>();

function shouldUseSetupCliBackendProviderCache(): boolean {
  return !(process.env.VITEST || process.env.NODE_ENV === "test");
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
  if (shouldUseSetupCliBackendProviderCache()) {
    const cached = setupCliBackendProviderCache.get(normalized);
    if (cached !== undefined) {
      return cached;
    }
  }
  const matched = Boolean(resolvePluginSetupCliBackendRuntime({ backend: normalized }));
  if (shouldUseSetupCliBackendProviderCache()) {
    setupCliBackendProviderCache.set(normalized, matched);
  }
  return matched;
}
