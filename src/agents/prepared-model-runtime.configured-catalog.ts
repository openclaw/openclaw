import type { ModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import type { InlineModelEntry } from "./embedded-agent-runner/model.inline-provider.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { resolveModelCatalogIdentityKey } from "./openai-model-routes.js";
import type { PreparedModelRuntimeCatalogFacts } from "./prepared-model-runtime.catalog-contract.js";
import type { PreparedConfiguredRuntimeModel } from "./prepared-model-runtime.configured.js";
import type { ModelRegistry } from "./sessions/model-registry.js";

type ConfiguredCatalogAgentFacts = {
  input: { config: OpenClawConfig };
  configuredModelRefs: readonly ModelCatalogRef[];
};

type ConfiguredCatalogWorkspaceFacts = {
  configuredCatalogEntries: readonly ModelCatalogEntry[];
  inlineProviderModels: readonly InlineModelEntry[];
};

function createConfiguredModelCatalogSnapshot(params: {
  agentFacts: ConfiguredCatalogAgentFacts;
  workspaceFacts: ConfiguredCatalogWorkspaceFacts;
  templateModelRegistry: ModelRegistry;
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
}): ModelCatalogSnapshot {
  const entries = new Map<string, ModelCatalogEntry>();
  const addEntry = (entry: ModelCatalogEntry) => {
    const key = resolveModelCatalogIdentityKey(entry);
    if (!entries.has(key)) {
      entries.set(key, entry);
    }
  };
  for (const entry of params.workspaceFacts.configuredCatalogEntries) {
    addEntry(entry);
  }
  for (const configured of params.configuredRuntimeModels) {
    addEntry(modelCatalogRowToEntry(configured.model));
  }
  for (const { provider, modelId } of params.agentFacts.configuredModelRefs) {
    const model = params.templateModelRegistry.find(provider, modelId);
    if (model) {
      addEntry(modelCatalogRowToEntry(model));
    }
  }
  const configuredEntries = [...entries.values()];
  const staticEntries = params.configuredRuntimeModels.map(({ model }) =>
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
