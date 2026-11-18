import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveMergedModelProviderConfig } from "../config/model-provider-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getCurrentPluginMetadataSnapshotRequiredRuntime as getCurrentPluginMetadataSnapshot,
  loadPluginMetadataSnapshotRuntime as loadPluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot-required.js";
import type { PluginMetadataSnapshotOwnerMaps } from "../plugins/plugin-metadata-snapshot.types.js";

export type ProviderDisplayNameSources = {
  config?: OpenClawConfig;
  /**
   * Owner maps of an already selected metadata snapshot. Omitted, the current snapshot
   * is read and plugin metadata is loaded when none is published; pass the owners you
   * hold (or `{}`) where a lookup must not start discovery.
   */
  owners?: Pick<PluginMetadataSnapshotOwnerMaps, "providerNames">;
};

/**
 * Name of a model provider as a person would recognise it ("Google Vertex AI").
 *
 * The operator's configured name wins, then the name the owning plugin's manifest
 * declares in `providerNames`. A provider the operator defined without a name has
 * only its id, which is returned unchanged; every bundled provider has a manifest
 * name (`src/plugins/contracts/provider-display-names.contract.test.ts`).
 */
export function resolveProviderDisplayName(
  provider: string,
  sources: ProviderDisplayNameSources = {},
): string {
  const configured = resolveMergedModelProviderConfig(sources.config, provider)?.name?.trim();
  if (configured) {
    return configured;
  }
  const owners =
    sources.owners ??
    getCurrentPluginMetadataSnapshot({ allowWorkspaceScopedSnapshot: true })?.owners ??
    loadPluginMetadataSnapshot({ config: {} }).owners;
  return owners.providerNames?.get(normalizeProviderId(provider)) ?? provider;
}
