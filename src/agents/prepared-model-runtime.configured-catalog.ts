import type { ModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import type { InlineModelEntry } from "./embedded-agent-runner/model.inline-provider.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { modelTransportRoutesMatch } from "./model-compat-catalog.js";
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
  const runtimeEntries = params.configuredRuntimeModels.map(({ model }) =>
    modelCatalogRowToEntry(model),
  );
  const capturedEntries = params.templateModelRegistry.getAll().map(modelCatalogRowToEntry);
  const catalog = capturedEntries.map((entry) => {
    const donor = runtimeEntries.find(
      (candidate) =>
        resolveModelCatalogIdentityKey(candidate) === resolveModelCatalogIdentityKey(entry) &&
        modelTransportRoutesMatch(candidate, entry),
    );
    return entry.contextWindows || !donor
      ? entry
      : Object.assign({}, entry, {
          contextWindows: donor.contextWindows,
          contextWindowDefault: donor.contextWindowDefault,
        });
  });
  const configuredEntries = dedupeByKey(
    [
      ...buildConfiguredModelCatalog({
        cfg: params.agentFacts.input.config,
        catalog:
          params.agentFacts.input.config.models?.mode === "replace"
            ? []
            : [...catalog, ...runtimeEntries],
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
