/** Applies the same provider normalization to registry and live-test models. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import type { PluginMetadataSnapshotOwnerMaps } from "../plugins/plugin-metadata-snapshot.types.js";
import { normalizeModelCompat } from "../plugins/provider-model-compat.js";
import { createProviderModelNormalizer } from "../plugins/provider-model-normalization.js";

type NormalizeDiscoveredModelOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  providerMetadataOwners?: PluginMetadataSnapshotOwnerMaps;
};

/** The caller owns one synchronous catalog pass; no provider selection survives it. */
export function createDiscoveredAgentModelNormalizer(
  agentDir: string,
  options?: NormalizeDiscoveredModelOptions,
): (model: Model) => Model {
  const normalize = createProviderModelNormalizer({
    ...(options?.config !== undefined ? { config: options.config } : {}),
    ...(options?.workspaceDir !== undefined ? { workspaceDir: options.workspaceDir } : {}),
  });
  return (model) =>
    normalizeModelCompat(
      normalize({
        provider: model.provider,
        modelId: model.id,
        model,
        agentDir,
      }),
      options?.providerMetadataOwners,
    );
}
