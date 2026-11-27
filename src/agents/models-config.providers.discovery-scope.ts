/** Resolves the plugin-owned provider scope for configured and live catalog discovery. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resolveOwningPluginIdsForProviderRef } from "../plugins/providers.js";

export type ProviderDiscoveryScope = ReadonlyMap<string, readonly string[]>;

export function resolveImplicitProviderDiscoveryScope(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "owners">;
  providerDiscoveryProviderIds?: readonly string[];
}): ProviderDiscoveryScope | undefined {
  const { config, workspaceDir, pluginMetadataSnapshot } = params;
  const env = params.env ?? process.env;
  let providerIds: string[];
  if (params.providerDiscoveryProviderIds !== undefined) {
    providerIds = normalizeStringEntries([...params.providerDiscoveryProviderIds])
      .map(normalizeProviderId)
      .filter(Boolean);
  } else {
    const live =
      env.OPENCLAW_LIVE_TEST === "1" || env.OPENCLAW_LIVE_GATEWAY === "1" || env.LIVE === "1";
    if (!live) {
      return undefined;
    }
    const rawValues = [
      env.OPENCLAW_LIVE_PROVIDERS?.trim(),
      env.OPENCLAW_LIVE_GATEWAY_PROVIDERS?.trim(),
    ].filter((value): value is string => Boolean(value && value !== "all"));
    if (rawValues.length === 0) {
      return undefined;
    }
    providerIds = normalizeStringEntries(rawValues.flatMap((value) => value.split(",")))
      .map(normalizeProviderId)
      .filter(Boolean);
    if (providerIds.length === 0) {
      return undefined;
    }
  }

  const providerIdsByPluginId = new Map<string, string[]>();
  for (const id of new Set(providerIds)) {
    const metadataOwners = new Set<string>();
    if (pluginMetadataSnapshot) {
      for (const ownerMap of [
        pluginMetadataSnapshot.owners.providers,
        pluginMetadataSnapshot.owners.modelCatalogProviders,
        pluginMetadataSnapshot.owners.setupProviders,
        pluginMetadataSnapshot.owners.cliBackends,
      ]) {
        if (!ownerMap) {
          continue;
        }
        for (const [ownedId, pluginIds] of ownerMap) {
          if (normalizeProviderId(ownedId) === id) {
            for (const pluginId of pluginIds) {
              metadataOwners.add(pluginId);
            }
          }
        }
      }
    }
    const owners =
      metadataOwners.size > 0
        ? [...metadataOwners].toSorted((left, right) => left.localeCompare(right))
        : (resolveOwningPluginIdsForProviderRef({ provider: id, config, workspaceDir, env }) ?? []);
    for (const pluginId of owners.length > 0 ? owners : [id]) {
      const ownedProviderIds = providerIdsByPluginId.get(pluginId) ?? [];
      if (!ownedProviderIds.includes(id)) {
        ownedProviderIds.push(id);
        providerIdsByPluginId.set(pluginId, ownedProviderIds);
      }
    }
  }
  return new Map(
    [...providerIdsByPluginId.entries()].toSorted(([left], [right]) => left.localeCompare(right)),
  );
}
