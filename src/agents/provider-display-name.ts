import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveMergedModelProviderConfig } from "../config/model-provider-config.js";
import { runtimeConfigPublication } from "../config/runtime-config-publication.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshotRuntime } from "../plugins/plugin-metadata-snapshot.runtime.js";
import type { PluginMetadataSnapshotOwnerMaps } from "../plugins/plugin-metadata-snapshot.types.js";
import bundledProviderNames from "../shared/provider-names.generated.json" with { type: "json" };

export type ProviderDisplayNameSources = {
  /** Explicit config wins; configless Gateway callers use the published runtime config. */
  config?: OpenClawConfig;
  /** Selected metadata generation. Omission reads the current snapshot, never discovers plugins. */
  owners?: Pick<PluginMetadataSnapshotOwnerMaps, "providerNames">;
  /** Authored label from an older third-party plugin without manifest names. */
  fallbackName?: string;
};

/**
 * Operator name, then installed manifest name, then the bundled manifest projection.
 * Unnamed custom providers retain their exact id. Displaying an error must never
 * start plugin discovery or depend on the metadata system having started successfully.
 */
export function resolveProviderDisplayName(
  provider: string,
  sources: ProviderDisplayNameSources = {},
): string {
  const config = sources.config ?? runtimeConfigPublication.current?.config;
  const configured = resolveMergedModelProviderConfig(config, provider)?.name?.trim();
  if (configured) {
    return configured;
  }
  const owners =
    sources.owners ??
    getCurrentPluginMetadataSnapshotRuntime({
      config,
      allowWorkspaceScopedSnapshot: true,
    })?.owners;
  const id = normalizeProviderId(provider);
  const bundled: Readonly<Record<string, string>> = bundledProviderNames;
  return (
    owners?.providerNames?.get(id) ??
    (Object.hasOwn(bundled, id) ? bundled[id]! : undefined) ??
    (sources.fallbackName?.trim() || provider)
  );
}
