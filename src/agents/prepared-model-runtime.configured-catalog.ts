import type { ModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import type { InlineModelEntry } from "./embedded-agent-runner/model.inline-provider.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";
import { resolveModelCatalogIdentityKey } from "./openai-model-routes.js";
import type { PreparedModelRuntimeCatalogFacts } from "./prepared-model-runtime.catalog-contract.js";
import type { PreparedConfiguredRuntimeModel } from "./prepared-model-runtime.types.js";
import type { ModelRegistry } from "./sessions/model-registry.js";

type ConfiguredCatalogAgentFacts = {
  input: { config: OpenClawConfig };
  configuredModelRefs: readonly ModelCatalogRef[];
};

type ConfiguredCatalogWorkspaceFacts = {
  pluginMetadataSnapshot: PluginMetadataSnapshot;
  inlineProviderModels: readonly InlineModelEntry[];
};

function createConfiguredModelCatalogSnapshot(params: {
  agentFacts: ConfiguredCatalogAgentFacts;
  workspaceFacts: ConfiguredCatalogWorkspaceFacts;
  templateModelRegistry: ModelRegistry;
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
}): ModelCatalogSnapshot {
  const replace = params.agentFacts.input.config.models?.mode === "replace";
  const configuredEntries = dedupeByKey(
    [
      ...buildConfiguredModelCatalog({
        cfg: params.agentFacts.input.config,
        catalog:
          params.agentFacts.input.config.models?.mode === "replace"
            ? []
            : params.templateModelRegistry.getAll().map(modelCatalogRowToEntry),
        manifestPlugins: params.workspaceFacts.pluginMetadataSnapshot,
      }),
      ...(replace
        ? []
        : params.configuredRuntimeModels.map(({ model }) => modelCatalogRowToEntry(model))),
      ...(replace
        ? []
        : params.agentFacts.configuredModelRefs.flatMap(({ provider, modelId }) => {
            const model = params.templateModelRegistry.find(provider, modelId);
            return model ? [modelCatalogRowToEntry(model)] : [];
          })),
    ],
    resolveModelCatalogIdentityKey,
  );
  const staticEntries = (replace ? [] : params.configuredRuntimeModels).map(({ model }) =>
    modelCatalogRowToEntry(model),
  );
  return {
    entries: configuredEntries,
    routeVariants: configuredEntries,
    resolvedConfiguredModelRefs: params.configuredRuntimeModels.map(({ provider, modelId }) => ({
      provider,
      model: modelId,
    })),
    ...(staticEntries.length > 0 ? { staticEntries } : {}),
  };
}

export function prepareConfiguredRuntimeFacts(params: {
  agentFacts: ConfiguredCatalogAgentFacts;
  workspaceFacts: ConfiguredCatalogWorkspaceFacts;
  templateModelRegistry: ModelRegistry;
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
}): PreparedModelRuntimeCatalogFacts {
  return {
    templateModelRegistry: params.templateModelRegistry,
    modelCatalog: createConfiguredModelCatalogSnapshot(params),
    configuredRuntimeModels: params.configuredRuntimeModels,
    inlineProviderModels: params.workspaceFacts.inlineProviderModels,
  };
}

/** Startup can expose captured rows; full refresh overlays only configured membership. */
export function prepareCapturedRuntimeFacts(
  params: Parameters<typeof prepareConfiguredRuntimeFacts>[0],
): PreparedModelRuntimeCatalogFacts {
  const facts = prepareConfiguredRuntimeFacts(params);
  if (params.agentFacts.input.config.models?.mode === "replace") {
    return facts;
  }
  const entries = dedupeByKey(
    [
      ...facts.modelCatalog.entries,
      ...params.templateModelRegistry.getAll().map(modelCatalogRowToEntry),
    ],
    resolveModelCatalogIdentityKey,
  );
  return { ...facts, modelCatalog: { ...facts.modelCatalog, entries, routeVariants: entries } };
}
