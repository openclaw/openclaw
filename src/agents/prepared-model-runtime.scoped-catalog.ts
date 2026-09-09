import type { ProviderCatalogOutcome } from "../plugins/provider-catalog.types.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { createPreparedModelCatalogProviderNormalizer } from "./model-catalog-provider-normalizer.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { ensureOpenClawModelsJson, planOpenClawModelsJsonSource } from "./models-config.js";
import { loadPersistedPluginModelCatalogsReadOnly } from "./plugin-model-catalog.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogSource,
} from "./prepared-model-runtime.catalog-contract.js";
import {
  captureModelsJsonContents,
  prepareWorkspaceBuildGroup,
} from "./prepared-model-runtime.facts.js";
import {
  materializePreparedModelCatalog,
  prepareFullCatalogFacts,
} from "./prepared-model-runtime.full-catalog.js";
import type {
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";

const MODEL_RUNTIME_PROVIDER_DISCOVERY_TIMEOUT_MS = 5_000;

async function prepareScopedReadOnlyModelCatalogWithMode(
  input: PreparedModelRuntimeInput,
  providerDiscoveryProviderIds: readonly string[],
  catalogMode: PreparedModelRuntimeCatalogMode,
): Promise<ModelCatalogSnapshot> {
  const scopedInput = input.readOnly ? input : { ...input, readOnly: true };
  const { agentFacts, pluginGeneration } = await prepareWorkspaceBuildGroup(
    [scopedInput],
    catalogMode,
    { providerDiscoveryProviderIds },
  );
  const agentFactsForInput = agentFacts[0];
  if (!agentFactsForInput) {
    throw new Error("scoped prepared model catalog facts are missing");
  }
  const catalogSource = await prepareAgentCatalogSource(
    agentFactsForInput,
    pluginGeneration,
    catalogMode,
    false,
    catalogMode === "live" ? { providerDiscoveryProviderIds } : {},
  );
  const { modelCatalog, configuredRuntimeModels } = await prepareFullCatalogFacts(
    agentFactsForInput,
    pluginGeneration,
    catalogMode,
    catalogSource,
  );
  return materializePreparedModelCatalog(
    modelCatalog,
    agentFactsForInput.runtimeCapabilityModels,
    configuredRuntimeModels,
  );
}

/** Builds a request-scoped read-only catalog without executing live provider discovery. */
export function prepareScopedReadOnlyModelCatalog(
  input: PreparedModelRuntimeInput,
  providerDiscoveryProviderIds: readonly string[],
): Promise<ModelCatalogSnapshot> {
  return prepareScopedReadOnlyModelCatalogWithMode(input, providerDiscoveryProviderIds, "static");
}

/** Builds a request-scoped read-only catalog with live discovery for selected providers. */
export function prepareScopedReadOnlyLiveModelCatalog(
  input: PreparedModelRuntimeInput,
  providerDiscoveryProviderIds: readonly string[],
): Promise<ModelCatalogSnapshot> {
  return prepareScopedReadOnlyModelCatalogWithMode(input, providerDiscoveryProviderIds, "live");
}

export async function prepareAgentCatalogSource(
  agentFacts: PreparedModelRuntimeAgentFacts,
  pluginGeneration: PreparedModelRuntimePluginGeneration,
  catalogMode: PreparedModelRuntimeCatalogMode,
  persist = true,
  sourceOptions: {
    authStore?: AuthProfileStore;
    providerDiscoveryProviderIds?: readonly string[];
  } = {},
): Promise<PreparedModelRuntimeCatalogSource> {
  const { env, input, providerIds } = agentFacts;
  const normalizeProvider = createPreparedModelCatalogProviderNormalizer(
    pluginGeneration.pluginMetadataSnapshot,
    input.config,
    env,
  );
  const providerOutcomes = new Map<string, ProviderCatalogOutcome>();
  const recordProviderOutcome = (outcome: ProviderCatalogOutcome) => {
    const provider = normalizeProvider(outcome.provider);
    if (provider) {
      providerOutcomes.set(`${provider}\0${outcome.profileId ?? ""}`, { ...outcome, provider });
    }
  };
  const resultOutcomes = () =>
    [...providerOutcomes.values()].toSorted(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        (left.profileId ?? "").localeCompare(right.profileId ?? ""),
    );
  const options = {
    pluginMetadataSnapshot: pluginGeneration.pluginMetadataSnapshot,
    providerDiscoveryProviderIds: sourceOptions.providerDiscoveryProviderIds ?? providerIds,
    ...(pluginGeneration.preparedStaticProviderCatalog
      ? { preparedStaticProviderCatalog: pluginGeneration.preparedStaticProviderCatalog }
      : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    ...(input.env ? { env } : {}),
    ...(catalogMode === "static"
      ? {
          providerDiscoveryEntriesOnly: true as const,
        }
      : {
          providerDiscoveryTimeoutMs: MODEL_RUNTIME_PROVIDER_DISCOVERY_TIMEOUT_MS,
        }),
  };
  const prepareSource = async () => {
    if (!persist) {
      const source = await planOpenClawModelsJsonSource(input.config, input.agentDir, {
        ...options,
        ...(sourceOptions.authStore ? { authStore: sourceOptions.authStore } : {}),
        ...(catalogMode === "live" ? { onProviderCatalogOutcome: recordProviderOutcome } : {}),
      });
      return {
        modelsJsonContents: source.modelsJsonContents,
        pluginCatalogs: source.pluginCatalogs,
        providerOutcomes: resultOutcomes(),
      };
    }
    if (!input.readOnly) {
      await ensureOpenClawModelsJson(input.config, input.agentDir, {
        ...options,
        ...(catalogMode === "live" ? { onProviderCatalogOutcome: recordProviderOutcome } : {}),
      });
    }
    // Capture immediately after the serialized write. Another owner may share this directory and
    // publish a different workspace generation before full-catalog parsing begins.
    return {
      modelsJsonContents: captureModelsJsonContents(input.agentDir),
      pluginCatalogs: loadPersistedPluginModelCatalogsReadOnly(input.agentDir),
      providerOutcomes: resultOutcomes(),
    };
  };
  const { pluginMetadataSnapshot: metadataSnapshot, pluginRegistry } = pluginGeneration;
  // Read-only inventories can request live discovery without preparing a runtime registry.
  return pluginRegistry
    ? withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, prepareSource)
    : prepareSource();
}
