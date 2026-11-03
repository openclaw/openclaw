/** Applies the same provider normalization to registry and live-test models. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import type { PluginMetadataSnapshotOwnerMaps } from "../plugins/plugin-metadata-snapshot.types.js";
import { ensureProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { normalizeModelCompat } from "../plugins/provider-model-compat.js";
import {
  applyProviderResolvedTransportWithPlugin,
  normalizeProviderResolvedModelWithPlugin,
} from "../plugins/provider-runtime.js";

type NormalizeDiscoveredModelOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  providerMetadataOwners?: PluginMetadataSnapshotOwnerMaps;
};

/** Applies plugin model normalization and transport hooks to discovered agent models. */
export function normalizeDiscoveredAgentModel(
  model: Model,
  agentDir: string,
  options?: NormalizeDiscoveredModelOptions,
): Model {
  const runtimeContext = {
    ...(options?.config !== undefined ? { config: options.config } : {}),
    ...(options?.workspaceDir !== undefined ? { workspaceDir: options.workspaceDir } : {}),
  };
  const { provider, id: modelId } = model;
  const runtimeHandle = ensureProviderRuntimePluginHandle({
    provider,
    modelId,
    ...runtimeContext,
  });
  const pluginNormalized =
    normalizeProviderResolvedModelWithPlugin({
      provider: model.provider,
      ...runtimeContext,
      runtimeHandle,
      context: {
        provider: model.provider,
        modelId: model.id,
        model,
        agentDir,
      },
    }) ?? model;
  const transportNormalized =
    applyProviderResolvedTransportWithPlugin({
      provider: model.provider,
      ...runtimeContext,
      // Both hooks share the row's selection unless normalization mutates its identity.
      // Replacement models retain the original lookup identity, as before.
      runtimeHandle:
        model.provider === provider && model.id === modelId ? runtimeHandle : undefined,
      context: {
        provider: model.provider,
        modelId: model.id,
        model: pluginNormalized,
        agentDir,
      },
    }) ?? pluginNormalized;
  return normalizeModelCompat(transportNormalized, options?.providerMetadataOwners);
}
