/**
 * Detects providers whose model selections are backed by CLI runtimes.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import { isInstalledPluginEnabled } from "../plugins/installed-plugin-index.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "../plugins/runtime-state.js";
import { normalizeProviderId } from "./model-ref-shared.js";

export type CliProviderClassifier = (provider: string) => boolean;

function resolveSetupCliBackendSnapshot(
  config?: OpenClawConfig,
  metadataSnapshot?: PluginMetadataSnapshot,
) {
  if (metadataSnapshot) {
    return metadataSnapshot;
  }
  const workspaceDir = getActivePluginRegistryWorkspaceDirFromState();
  return resolvePluginMetadataSnapshot({
    ...(config ? { config } : {}),
    env: process.env,
    ...(workspaceDir ? { workspaceDir } : {}),
    allowWorkspaceScopedCurrent: true,
  });
}

/** Prepare one CLI-provider lookup for request paths that classify multiple models. */
export function prepareCliProviderClassifier(cfg?: OpenClawConfig): CliProviderClassifier {
  const runtimeIds = resolveRuntimeCliBackends("metadata").map((backend) => backend.id);
  const snapshot = resolveSetupCliBackendSnapshot(cfg);
  const providers = new Set(
    [
      ...runtimeIds,
      ...snapshot.plugins.flatMap((plugin) => {
        const ids = plugin.cliBackends.concat(plugin.setup?.cliBackends ?? []);
        return ids.length > 0 &&
          isInstalledPluginEnabled(snapshot.index, plugin.id, cfg, process.env)
          ? ids
          : [];
      }),
    ].map(normalizeProviderId),
  );
  return (provider) => providers.has(normalizeProviderId(provider));
}

/** Return true when a provider id resolves to a configured or plugin CLI backend. */
export function isCliProvider(
  provider: string,
  cfg?: OpenClawConfig,
  metadataSnapshot?: PluginMetadataSnapshot | null,
): boolean {
  const normalized = normalizeProviderId(provider);
  const cliBackends = resolveRuntimeCliBackends("metadata");
  if (cliBackends.some((backend) => normalizeProviderId(backend.id) === normalized)) {
    return true;
  }
  // An admitted projection's missing metadata cannot trigger setup discovery.
  if (metadataSnapshot === null) {
    return false;
  }
  const snapshot = resolveSetupCliBackendSnapshot(cfg, metadataSnapshot);
  // The immutable owner map preserves declaration order; only activation uses live policy.
  const pluginId = snapshot.owners.cliBackends
    .get(normalized)
    ?.find((id) => isInstalledPluginEnabled(snapshot.index, id, cfg, process.env));
  const plugin = pluginId ? snapshot.byPluginId.get(pluginId) : undefined;
  if (!plugin) {
    return false;
  }
  const backendId = [...plugin.cliBackends, ...(plugin.setup?.cliBackends ?? [])].find(
    (id) => normalizeProviderId(id) === normalized,
  );
  return Boolean(backendId);
}
