import type { ModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { dedupeByKey, indexFirstByKey } from "../shared/dedupe-by-key.js";
import type { InlineModelEntry } from "./embedded-agent-runner/model.inline-provider.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import { overlayCatalogMetadata } from "./model-catalog-metadata.js";
import { assignProviderModelOrder } from "./model-catalog-order.js";
import { loadManifestModelCatalog } from "./model-catalog.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { modelTransportRoutesMatch } from "./model-compat-catalog.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";
import { createModelCatalogIdentityKeyResolver } from "./openai-model-routes.js";
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

export function prepareConfiguredRuntimeFacts(params: {
  agentFacts: ConfiguredCatalogAgentFacts;
  workspaceFacts: ConfiguredCatalogWorkspaceFacts;
  templateModelRegistry: ModelRegistry;
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
}): PreparedModelRuntimeCatalogFacts {
  const templateModelRegistry = params.templateModelRegistry;
  const replace = params.agentFacts.input.config.models?.mode === "replace";
  const keyOf = createModelCatalogIdentityKeyResolver();
  const runtimeEntries = (replace ? [] : params.configuredRuntimeModels).map(({ model }) =>
    modelCatalogRowToEntry(model),
  );
  const runtimeByIdentity = new Map<string, ModelCatalogEntry[]>();
  for (const entry of runtimeEntries) {
    const key = keyOf(entry);
    const donors = runtimeByIdentity.get(key) ?? [];
    donors.push(entry);
    runtimeByIdentity.set(key, donors);
  }
  const catalog = [
    ...(replace ? [] : params.templateModelRegistry.getAll().map(modelCatalogRowToEntry)),
    ...runtimeEntries,
  ];
  const catalogByIdentity = indexFirstByKey(catalog, keyOf);
  const configuredEntries = dedupeByKey(
    [
      ...buildConfiguredModelCatalog({
        cfg: params.agentFacts.input.config,
        catalog,
        manifestPlugins: params.workspaceFacts.pluginMetadataSnapshot,
      }).map((entry) => {
        const key = keyOf(entry);
        const accepted = catalogByIdentity.get(key);
        if (!accepted || !modelTransportRoutesMatch(accepted, entry)) {
          return entry;
        }
        const donor = accepted.contextWindows
          ? accepted
          : runtimeByIdentity
              .get(key)
              ?.find((candidate) => modelTransportRoutesMatch(candidate, accepted));
        return donor?.contextWindows
          ? overlayCatalogMetadata(entry, {
              ...entry,
              contextWindows: donor.contextWindows,
              contextWindowDefault: donor.contextWindowDefault,
            })
          : entry;
      }),
      ...runtimeEntries,
      ...(replace
        ? []
        : params.agentFacts.configuredModelRefs.flatMap(({ provider, modelId }) => {
            const model = params.templateModelRegistry.find(provider, modelId);
            return model ? [modelCatalogRowToEntry(model)] : [];
          })),
    ],
    keyOf,
  );
  const modelCatalog = {
    entries: configuredEntries,
    routeVariants: configuredEntries,
    ...(runtimeEntries.length > 0 ? { staticEntries: runtimeEntries } : {}),
  };
  return {
    templateModelRegistry,
    modelCatalog,
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
    createModelCatalogIdentityKeyResolver(),
  );
  const orderedEntries = assignProviderModelOrder(
    entries,
    loadManifestModelCatalog({
      config: params.agentFacts.input.config,
      metadataSnapshot: params.workspaceFacts.pluginMetadataSnapshot,
    }),
    { appendUnknown: false },
  );
  return {
    ...facts,
    modelCatalog: { ...facts.modelCatalog, entries: orderedEntries, routeVariants: orderedEntries },
  };
}
