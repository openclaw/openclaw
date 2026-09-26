/** Applies the same provider normalization to registry and live-test models. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import type { PluginMetadataSnapshotOwnerMaps } from "../plugins/plugin-metadata-snapshot.types.js";
import { normalizeModelCompat } from "../plugins/provider-model-compat.js";
import {
  applyProviderResolvedTransportWithPlugin,
  normalizeProviderResolvedModelWithPlugin,
} from "../plugins/provider-runtime.js";
import { isRecord } from "../utils.js";

type NormalizeDiscoveredModelOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  providerMetadataOwners?: PluginMetadataSnapshotOwnerMaps;
};

/** Applies plugin model normalization and transport hooks to discovered agent models. */
export function normalizeDiscoveredAgentModel(
  value: Model,
  agentDir: string,
  options?: NormalizeDiscoveredModelOptions,
): Model {
  if (!isRecord(value)) {
    return value;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.provider !== "string"
  ) {
    return value;
  }
  const model = value;
  const runtimeContext = {
    ...(options?.config !== undefined ? { config: options.config } : {}),
    ...(options?.workspaceDir !== undefined ? { workspaceDir: options.workspaceDir } : {}),
  };
  const pluginNormalized =
    normalizeProviderResolvedModelWithPlugin({
      provider: model.provider,
      modelId: model.id,
      ...runtimeContext,
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
      modelId: model.id,
      ...runtimeContext,
      context: {
        provider: model.provider,
        modelId: model.id,
        model: pluginNormalized,
        agentDir,
      },
    }) ?? pluginNormalized;
  if (
    !isRecord(transportNormalized) ||
    typeof transportNormalized.id !== "string" ||
    typeof transportNormalized.name !== "string" ||
    typeof transportNormalized.provider !== "string" ||
    typeof transportNormalized.api !== "string"
  ) {
    return value;
  }
  return normalizeModelCompat(transportNormalized, options?.providerMetadataOwners);
}
