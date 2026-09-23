/**
 * Detects providers whose model selections are backed by CLI runtimes.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  resolvePluginSetupCliBackendDescriptor,
  resolvePluginSetupCliBackendIds,
} from "../plugins/setup-registry.runtime.js";
import { normalizeProviderId } from "./model-ref-shared.js";

export type CliProviderClassifier = (provider: string) => boolean;

/** Prepare one CLI-provider lookup for request paths that classify multiple models. */
export function prepareCliProviderClassifier(cfg?: OpenClawConfig): CliProviderClassifier {
  const providers = new Set(
    [
      ...resolveRuntimeCliBackends("metadata").map((backend) => backend.id),
      ...resolvePluginSetupCliBackendIds({ config: cfg }),
    ].map(normalizeProviderId),
  );
  return (provider) => providers.has(normalizeProviderId(provider));
}

/** Return true when a provider id resolves to a configured or plugin CLI backend. */
export function isCliProvider(
  provider: string,
  cfg?: OpenClawConfig,
  metadataSnapshot?: PluginMetadataSnapshot,
): boolean {
  const normalized = normalizeProviderId(provider);
  const cliBackends = resolveRuntimeCliBackends("metadata");
  if (cliBackends.some((backend) => normalizeProviderId(backend.id) === normalized)) {
    return true;
  }
  if (
    resolvePluginSetupCliBackendDescriptor({ backend: normalized, config: cfg, metadataSnapshot })
  ) {
    return true;
  }
  return false;
}
