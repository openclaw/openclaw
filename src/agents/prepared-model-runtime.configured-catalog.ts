import type { ModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { groupPluginRecords as groupRecords } from "../plugins/record-groups.js";
import { dedupeByKey, indexFirstByKey } from "../shared/dedupe-by-key.js";
import { copyContextWindowOption, modelCatalogRowToEntry } from "./model-catalog-entry.js";
import { overlayCatalogMetadata } from "./model-catalog-metadata.js";
import { assignProviderModelOrder } from "./model-catalog-order.js";
import { createPreparedModelCatalogProviderNormalizer } from "./model-catalog-provider-normalizer.js";
import { loadManifestModelCatalog } from "./model-catalog.js";
import { modelTransportRoutesMatch } from "./model-compat-catalog.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";
import { createModelCatalogIdentityKeyResolver } from "./openai-model-routes.js";
import type { PreparedModelRuntimeCatalogFacts } from "./prepared-model-runtime.catalog-contract.js";
import type { PreparedConfiguredRuntimeModel } from "./prepared-model-runtime.types.js";
import type { ModelRegistry } from "./sessions/model-registry.js";

type ConfiguredRuntimeFactsInput = {
  agentFacts: {
    input: { config: OpenClawConfig; env?: NodeJS.ProcessEnv };
    configuredModelRefs: readonly ModelCatalogRef[];
  };
  workspaceFacts: {
    pluginMetadataSnapshot: PluginMetadataSnapshot;
  };
  templateModelRegistry: ModelRegistry;
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
};

export function prepareConfiguredRuntimeFacts(params: ConfiguredRuntimeFactsInput) {
  return prepareRuntimeFacts(params, false);
}

/** Startup exposes captured rows; full refresh overlays only configured membership. */
export function prepareCapturedRuntimeFacts(params: ConfiguredRuntimeFactsInput) {
  return prepareRuntimeFacts(params, true);
}

function prepareRuntimeFacts(
  params: ConfiguredRuntimeFactsInput,
  includeCapturedRows: boolean,
): PreparedModelRuntimeCatalogFacts {
  const templateModelRegistry = params.templateModelRegistry;
  const replace = params.agentFacts.input.config.models?.mode === "replace";
  const keyOf = createModelCatalogIdentityKeyResolver();
  const runtimeEntries = (replace ? [] : params.configuredRuntimeModels).map(({ model }) =>
    modelCatalogRowToEntry(model),
  );
  const runtimeByIdentity = groupRecords(runtimeEntries, keyOf);
  const capturedEntries = replace ? [] : templateModelRegistry.getAll().map(modelCatalogRowToEntry);
  const catalogByIdentity = indexFirstByKey([...capturedEntries, ...runtimeEntries], keyOf);
  const configuredEntries = dedupeByKey(
    [
      ...buildConfiguredModelCatalog({
        cfg: params.agentFacts.input.config,
        catalog: catalogByIdentity,
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
  const facts = {
    templateModelRegistry,
    modelCatalog,
    configuredRuntimeModels: params.configuredRuntimeModels,
  };
  if (!includeCapturedRows || replace) {
    return facts;
  }
  const normalizeProvider = createPreparedModelCatalogProviderNormalizer(
    params.workspaceFacts.pluginMetadataSnapshot,
    params.agentFacts.input.config,
    params.agentFacts.input.env,
  );
  const manifestCatalog = loadManifestModelCatalog({
    config: params.agentFacts.input.config,
    metadataSnapshot: params.workspaceFacts.pluginMetadataSnapshot,
  });
  const declaredByIdentity = indexFirstByKey(
    manifestCatalog.filter((entry) => entry.inference !== undefined),
    keyOf,
  );
  // Preserve raw identities for configured membership before publishing canonical provider aliases.
  for (const entry of capturedEntries) {
    const provider = normalizeProvider(entry.provider);
    if (provider !== entry.provider) {
      entry.provider = provider;
      // Both the configured alias and its canonical row may expose these mutable options.
      if (entry.contextWindows) {
        entry.contextWindows = entry.contextWindows.map(copyContextWindowOption);
      }
    }
  }
  const entries = dedupeByKey(
    [
      ...facts.modelCatalog.entries.map((entry) => {
        const declared = declaredByIdentity.get(keyOf(entry));
        // Configured membership must retain the exact route's inference contract.
        // Route changes clear its capabilities without promoting typed rows to chat.
        return declared
          ? { ...entry, inference: overlayCatalogMetadata(declared, entry).inference }
          : entry;
      }),
      // Typed-only rows have no conversational registry Model. Carry their canonical
      // manifest facts into the same prepared generation instead of inventing chat defaults.
      ...manifestCatalog.filter((entry) => entry.inference?.chat === false),
      ...capturedEntries,
    ],
    keyOf,
  );
  const orderedEntries = assignProviderModelOrder(entries, manifestCatalog, {
    appendUnknown: false,
  });
  return {
    ...facts,
    modelCatalog: { ...facts.modelCatalog, entries: orderedEntries, routeVariants: orderedEntries },
  };
}
