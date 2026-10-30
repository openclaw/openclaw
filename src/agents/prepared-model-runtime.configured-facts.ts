import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildInlineProviderModels } from "./embedded-agent-runner/model.inline-provider.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";
import type { PreparedModelRuntimePluginGeneration } from "./prepared-model-runtime.types.js";

export function prepareConfiguredModelFacts(
  config: OpenClawConfig,
  pluginMetadataSnapshot: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"],
): Pick<PreparedModelRuntimePluginGeneration, "inlineProviderModels" | "configuredCatalogEntries"> {
  return {
    inlineProviderModels: buildInlineProviderModels(config.models?.providers ?? {}, {
      providerMetadataOwners: pluginMetadataSnapshot.owners,
    }),
    configuredCatalogEntries: buildConfiguredModelCatalog({
      cfg: config,
      manifestPlugins: pluginMetadataSnapshot,
    }),
  };
}
