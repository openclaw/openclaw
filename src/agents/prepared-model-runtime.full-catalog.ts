import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { Model } from "../llm/types.js";
import { resolvePreparedProviderStaticConfigs } from "../plugins/provider-discovery.js";
import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import { discoverModels } from "./agent-model-discovery.js";
import { getPreparedRuntimeAuthMaterializations } from "./auth-profiles/runtime-materializations.js";
import {
  buildInlineProviderModels,
  completeInlineProviderModel,
} from "./embedded-agent-runner/model.inline-provider.js";
import { loadBundledProviderStaticCatalogContextModels } from "./embedded-agent-runner/model.static-catalog.js";
import { createPreparedConfiguredRuntimeModelLookup } from "./embedded-agent-runner/model.static-id.js";
import { augmentPreparedModelCatalogWithAgentHarness } from "./harness/model-catalog.js";
import {
  enrichHarnessRows,
  modelCatalogRouteVariantKey,
  modelCatalogRowToEntry,
} from "./model-catalog-entry.js";
import { loadManifestModelProviderConfigs } from "./model-catalog-manifest.js";
import { overlayCatalogMetadata } from "./model-catalog-metadata.js";
import { createPreparedModelCatalogProviderNormalizer } from "./model-catalog-provider-normalizer.js";
import { buildPreparedModelCatalogSnapshot } from "./model-catalog.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { modelTransportRoutesMatch } from "./model-compat-catalog.js";
import { createModelCatalogIdentityKeyResolver } from "./openai-model-routes.js";
import {
  copyPreparedModelFullCatalogAuth,
  bindPreparedModelRuntimeAuth,
} from "./prepared-model-runtime-auth.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogAccess,
  PreparedModelRuntimeCatalogFacts,
  PreparedModelRuntimeCatalogSource,
} from "./prepared-model-runtime.catalog-contract.js";
import {
  completeConfiguredRuntimeModels,
  prepareConfiguredModelAliases,
} from "./prepared-model-runtime.configured-completion.js";
import { acquirePreparedMediaCapabilityProviders } from "./prepared-model-runtime.plugin-generation.js";
import type {
  PreparedRuntimeCapabilityModel,
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimePluginGeneration,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";

const fullModelCatalogSnapshots = new WeakSet<ModelCatalogSnapshot>();

/** Builds complete inventory before generation-specific runtime capability projection. */
export async function prepareFullCatalogFacts(
  agentFacts: Parameters<typeof completeConfiguredRuntimeModels>[0] &
    Pick<PreparedModelRuntimeAgentFacts, "templateAuthStorage" | "credentials">,
  pluginGeneration: PreparedModelRuntimePluginGeneration,
  catalogMode: PreparedModelRuntimeCatalogMode,
  catalogSource: PreparedModelRuntimeCatalogSource,
  options: { includeNative?: boolean; providerIds?: readonly string[] } = {},
): Promise<PreparedModelRuntimeCatalogFacts & { catalogModels: readonly Model[] }> {
  const prepare = async () => {
    const { env, input, templateAuthStorage } = agentFacts;
    const { pluginMetadataSnapshot, pluginRegistry, preparedStaticProviderCatalog } =
      pluginGeneration;
    const observedProviders = new Set(
      catalogSource.providerOutcomes?.map(({ provider }) => normalizeProviderId(provider)),
    );
    const templateModelRegistry = discoverModels(templateAuthStorage, input.agentDir, {
      config: input.config,
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
      pluginMetadataSnapshot,
      ...(catalogMode === "static" ? { normalizeModels: false } : {}),
      includePluginCatalogs: true,
      modelsJsonContents: catalogSource.modelsJsonContents,
      pluginCatalogs: catalogSource.pluginCatalogs,
      staticProviderConfigs: Object.fromEntries(
        Object.entries(resolvePreparedProviderStaticConfigs(preparedStaticProviderCatalog)).filter(
          ([provider]) => !observedProviders.has(normalizeProviderId(provider)),
        ),
      ),
    });
    const catalogModels = templateModelRegistry.getAll();
    const snapshot = await buildPreparedModelCatalogSnapshot({
      agentDir: input.agentDir,
      authCredentials: agentFacts.credentials,
      config: input.config,
      models: catalogModels,
      metadataSnapshot: pluginMetadataSnapshot,
      providerOutcomes: catalogSource.providerOutcomes,
      includeProviderPluginAugmentation: catalogMode === "live",
      providerIds: options.providerIds,
      ...(input.env ? { env: input.env } : {}),
      ...(input.readOnly ? { readOnly: true } : {}),
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    });
    const modelCatalog =
      catalogMode === "live" && options.includeNative !== false
        ? await augmentPreparedModelCatalogWithAgentHarness({ input, snapshot, pluginRegistry })
        : snapshot;
    const providerStaticModels =
      input.config.models?.mode === "replace"
        ? []
        : (pluginGeneration.providerStaticModels ??
          (await loadBundledProviderStaticCatalogContextModels({
            cfg: input.config,
            env,
            metadataSnapshot: pluginMetadataSnapshot,
            registeredProviders: pluginGeneration.pluginRegistry?.providers,
            providerIds: options.providerIds,
            ...(preparedStaticProviderCatalog ? { preparedStaticProviderCatalog } : {}),
            ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
          })));
    // Signed-in providers keep their known manifest rows when the account listing fails.
    const credentialProviders = Object.keys(agentFacts.credentials).map(normalizeProviderId);
    const scopedProviders =
      options.providerIds && new Set(options.providerIds.map(normalizeProviderId));
    const manifestStaticModels = Object.entries(
      loadManifestModelProviderConfigs({
        config: input.config,
        metadataSnapshot: pluginMetadataSnapshot,
        providerIds: credentialProviders.filter(
          (provider) => scopedProviders?.has(provider) ?? true,
        ),
      }),
    ).flatMap(([provider, providerConfig]) =>
      buildInlineProviderModels(
        { [provider]: providerConfig },
        { providerMetadataOwners: pluginMetadataSnapshot.owners },
      ).map((model) => completeInlineProviderModel(model, providerConfig)),
    );
    const configuredRuntimeModels = completeConfiguredRuntimeModels(
      agentFacts,
      pluginGeneration,
      templateModelRegistry,
    );
    const providerOutcomes = catalogSource.providerOutcomes ?? [];
    const normalizeProvider = createPreparedModelCatalogProviderNormalizer(
      pluginMetadataSnapshot,
      input.config,
      input.env,
    );
    const completeModelCatalog: ModelCatalogSnapshot = {
      ...modelCatalog,
      staticEntries:
        input.config.models?.mode === "replace"
          ? []
          : dedupeByKey(
              // Static hooks also answer runtime provider aliases; publish canonical rows once.
              [...providerStaticModels, ...manifestStaticModels].map((model) => {
                const entry = modelCatalogRowToEntry(model);
                entry.provider = normalizeProvider(entry.provider);
                return entry;
              }),
              createModelCatalogIdentityKeyResolver(),
            ),
      ...(providerOutcomes.length > 0 ? { providerOutcomes } : {}),
    };
    if (catalogMode === "live") {
      fullModelCatalogSnapshots.add(completeModelCatalog);
    }
    return {
      templateModelRegistry,
      catalogModels,
      modelCatalog: completeModelCatalog,
      configuredRuntimeModels,
      inlineProviderModels: pluginGeneration.inlineProviderModels,
    };
  };
  return withPluginRuntimeGenerationScope(
    {
      metadataSnapshot: pluginGeneration.pluginMetadataSnapshot,
      pluginRegistry: pluginGeneration.pluginRegistry,
    },
    prepare,
  );
}

/** Reprojects retained inventory without carrying capabilities from a retired runtime. */
export function materializePreparedModelCatalog(
  snapshot: ModelCatalogSnapshot,
  runtimeCapabilityModels: readonly PreparedRuntimeCapabilityModel[],
  configuredStaticEntries: ModelCatalogSnapshot["staticEntries"] = [],
  acceptedDiscoveryProviders: ReadonlySet<string> = new Set(),
): ModelCatalogSnapshot {
  // Preserve inventory reads before capability preparation when the snapshot has accessors.
  const materialized = { ...snapshot };
  const sourceEntries = snapshot.entries;
  const sourceRoutes = [...sourceEntries, ...snapshot.routeVariants];
  // The inventory owner has already validated source, account and generation. Only a
  // provider-marked unknown-model estimate may yield to that accepted inventory;
  // curated static metadata and authored caps keep their existing minimum semantics.
  const supersedingEntry = (entry: ModelCatalogSnapshot["entries"][number]) =>
    acceptedDiscoveryProviders.has(normalizeProviderId(entry.provider)) &&
    entry.contextWindowSource === "synthetic"
      ? sourceRoutes.find(
          (accepted) =>
            !accepted.nativeRuntime &&
            accepted.provider === entry.provider &&
            accepted.id === entry.id &&
            Boolean(accepted.api) &&
            accepted.api === entry.api &&
            modelTransportRoutesMatch(accepted, entry) &&
            // Only a reported limit grants replacement: a real prompt limit, or a native
            // window that is not itself a provider estimate.
            (accepted.contextTokens ??
              (accepted.contextWindowSource === "synthetic" ? undefined : accepted.contextWindow) ??
              0) > 0,
        )
      : undefined;
  const identityKey = createModelCatalogIdentityKeyResolver();
  // Re-enrich exact harness observations from this API generation, not a pre-await projection.
  const hostRows = enrichHarnessRows(Object.values(snapshot.nativeHostRows ?? {}).flat(), snapshot);
  const runtimeByKey = new Map(
    runtimeCapabilityModels.map(({ provider, modelId, model }) => [
      identityKey({ provider, id: modelId }),
      modelCatalogRowToEntry(model),
    ]),
  );
  const project = (entries: ModelCatalogSnapshot["entries"]) =>
    entries.map((entry) => {
      const runtime = runtimeByKey.get(identityKey(entry));
      if (!runtime) {
        return entry;
      }
      const thinkingPolicyProvider = runtime.provider;
      if (entry.configuredReasoning !== undefined) {
        return { ...entry, thinkingPolicyProvider };
      }
      const params =
        runtime.params || entry.params ? { ...runtime.params, ...entry.params } : undefined;
      const compat =
        runtime.compat || entry.compat ? { ...runtime.compat, ...entry.compat } : undefined;
      // A superseded provider estimate cannot replace accepted thinking metadata.
      return {
        ...entry,
        thinkingPolicyProvider,
        ...(runtime.reasoning !== undefined &&
        (entry.reasoning === undefined || !supersedingEntry(runtime))
          ? { reasoning: runtime.reasoning }
          : {}),
        ...(params ? { params } : {}),
        ...(compat ? { compat } : {}),
      };
    });
  materialized.entries = project(
    hostRows.length
      ? dedupeByKey(
          [...sourceEntries.filter((entry) => entry.nativeRuntime), ...hostRows, ...sourceEntries],
          identityKey,
        )
      : sourceEntries,
  );
  materialized.routeVariants = project(
    hostRows.length
      ? dedupeByKey([...hostRows, ...snapshot.routeVariants], (entry) =>
          modelCatalogRouteVariantKey(entry, identityKey(entry)),
        )
      : snapshot.routeVariants,
  );
  if (snapshot.staticEntries || configuredStaticEntries.length > 0) {
    materialized.staticEntries = project(
      dedupeByKey(
        [...configuredStaticEntries, ...(snapshot.staticEntries ?? [])].flatMap((entry) => {
          const accepted = supersedingEntry(entry);
          if (!accepted) {
            return [entry];
          }
          const promptCap = asPositiveFiniteNumber(entry.contextTokens);
          const {
            contextWindow: _syntheticWindow,
            contextWindowSource: _syntheticSource,
            contextCapacitySource: _unacceptedCapacity,
            contextTokens: _configuredPrompt,
            reasoning: fallbackReasoning,
            ...configuredMetadata
          } = entry;
          const reportedPrompt = asPositiveFiniteNumber(accepted.contextTokens);
          return [
            overlayCatalogMetadata(accepted, {
              ...configuredMetadata,
              ...(entry.configuredReasoning !== undefined ? { reasoning: fallbackReasoning } : {}),
              ...(promptCap !== undefined
                ? { contextTokens: Math.min(promptCap, reportedPrompt ?? promptCap) }
                : {}),
            }),
          ];
        }),
        identityKey,
      ),
    );
  }
  if (isPreparedModelCatalogFull(snapshot)) {
    markPreparedModelCatalogFull(materialized);
  }
  copyPreparedModelFullCatalogAuth(snapshot, materialized);
  return materialized;
}

/** Reports whether a catalog came from the complete prepared-catalog build path. */
export const isPreparedModelCatalogFull = (snapshot: ModelCatalogSnapshot): boolean =>
  fullModelCatalogSnapshots.has(snapshot);

/** Restores process-local provenance after a complete catalog crosses a worker boundary. */
export function markPreparedModelCatalogFull(snapshot: ModelCatalogSnapshot): ModelCatalogSnapshot {
  fullModelCatalogSnapshots.add(snapshot);
  return snapshot;
}

export function createPreparedModelRuntimeSnapshot(
  catalogOwner: PreparedModelRuntimeSnapshot["catalogOwner"],
  agentFacts: PreparedModelRuntimeAgentFacts,
  pluginGeneration: PreparedModelRuntimePluginGeneration,
  catalogFacts: PreparedModelRuntimeCatalogFacts,
  catalogAccess: PreparedModelRuntimeCatalogAccess,
  publishedConfig = agentFacts.input.config,
): PreparedModelRuntimeSnapshot {
  const { credentials, input } = agentFacts;
  const {
    mediaCapabilityProviders,
    mediaCapabilityProviderSource,
    messageToolCatalog,
    pluginMetadataSnapshot,
    pluginRegistry,
  } = pluginGeneration;
  const { configuredRuntimeModels, inlineProviderModels, templateModelRegistry } = catalogFacts;
  const modelCatalog = materializePreparedModelCatalog(
    catalogFacts.modelCatalog,
    agentFacts.runtimeCapabilityModels,
    input.config.models?.mode === "replace"
      ? []
      : configuredRuntimeModels.map(({ model }) => modelCatalogRowToEntry(model)),
  );
  prepareModelCatalogThinkingPolicies({
    catalog: modelCatalog,
    metadataSnapshot: pluginMetadataSnapshot,
    pluginRegistry,
  });
  const snapshot: PreparedModelRuntimeSnapshot = Object.freeze({
    catalogOwner,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    agentDir: input.agentDir,
    activeProjectKeys: [],
    ...(input.inheritedAuthDir ? { inheritedAuthDir: input.inheritedAuthDir } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    config: publishedConfig,
    observationConfig: input.config,
    isCurrent: catalogAccess.isCurrent,
    accountCatalog: catalogAccess.accountCatalog,
    authModes: catalogAccess.initialAuth.authModes,
    metadataSnapshot: pluginMetadataSnapshot,
    allowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
    ...(pluginRegistry ? { pluginRegistry } : {}),
    ...(messageToolCatalog ? { messageToolCatalog } : {}),
    ...(mediaCapabilityProviders ? { mediaCapabilityProviders } : {}),
    ...(mediaCapabilityProviderSource && mediaCapabilityProviders
      ? {
          acquireMediaCapabilityProviders: () =>
            acquirePreparedMediaCapabilityProviders(
              mediaCapabilityProviderSource,
              mediaCapabilityProviders,
              pluginRegistry ?? mediaCapabilityProviderSource.registry,
            ),
        }
      : {}),
    modelCatalog: catalogAccess.withRefreshStatus(modelCatalog),
    readFullModelCatalog: catalogAccess.readFullModelCatalog,
    recheckNativeLogin: catalogAccess.recheckNativeLogin,
    refreshExpiredModelCatalog: catalogAccess.refreshExpiredModelCatalog,
    readPublishedModels: catalogAccess.readPublishedModels,
    loadFullModelCatalog: catalogAccess.loadFullModelCatalog,
    loadNativeModelCatalog: catalogAccess.loadNativeModelCatalog,
    configuredRuntimeModels,
    configuredModelAliases: prepareConfiguredModelAliases(
      agentFacts,
      pluginGeneration,
      templateModelRegistry,
      configuredRuntimeModels,
    ),
    findConfiguredRuntimeModel: createPreparedConfiguredRuntimeModelLookup(
      configuredRuntimeModels,
      pluginMetadataSnapshot,
    ),
    inlineProviderModels,
    createStores: () => {
      // Runtime keys and session extensions mutate per-run stores; parsed inputs stay shared.
      const authStorage = AuthStorage.inMemory(credentials);
      return { authStorage, modelRegistry: templateModelRegistry.fork(authStorage) };
    },
    routeModelResolutionMemo: new Map<string, Promise<Model>>(),
  });
  bindPreparedModelRuntimeAuth(snapshot, {
    labels: catalogAccess.initialAuth.providerAuthLabels,
    store: catalogAccess.initialAuth.authStore,
    load: catalogAccess.loadAuth,
    materializations: Object.freeze([...getPreparedRuntimeAuthMaterializations(input.agentDir)]),
  });
  return snapshot;
}
