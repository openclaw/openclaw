/**
 * Detects providers whose model selections are backed by CLI runtimes.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import { resolvePluginSetupCliBackendDescriptor } from "../plugins/setup-registry.runtime.js";
import { normalizeProviderId } from "./model-selection-normalize.js";

/** Return true when a provider id resolves to a configured or plugin CLI backend. */
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
  if (resolvePluginSetupCliBackendDescriptor({ backend: normalized, config: cfg })) {
    return true;
  }
  return false;
}

/**
 * Resolve the user-facing integration label for a model entry. Returns "CLI"
 * when the model is pinned to a CLI backend via `agentRuntime.id` in user
 * config, otherwise undefined. Intended for picker/status display only —
 * never used as a routing key.
 */
export function resolveModelRuntimeLabel(
  provider: string,
  modelId: string,
  cfg?: OpenClawConfig,
): string | undefined {
  const modelKey = `${provider}/${modelId}`;
  const runtimeId = cfg?.agents?.defaults?.models?.[modelKey]?.agentRuntime?.id;
  if (runtimeId && isCliProvider(runtimeId, cfg)) {
    return "CLI";
  }
  return undefined;
}
