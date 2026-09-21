import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { ConfiguredModelRef } from "@openclaw/model-catalog-core/configured-model-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { stableStringify } from "@openclaw/normalization-core";
import type { Result } from "@openclaw/normalization-core/result";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sha256Base64Url } from "../infra/crypto-digest.js";
import { prepareMediaCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { getPluginMetadataSnapshotCache, retainPluginCache } from "../plugins/plugin-cache.js";
import {
  getPreparedMessageToolCatalog,
  getPreparedMessageToolCatalogForRegistry,
} from "../plugins/prepared-message-tool-catalog.js";
import { resolvePreparedProviderStaticConfigs } from "../plugins/provider-discovery.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { getPluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { capturePluginLifecycleAuthority } from "../plugins/registry-lifecycle.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveRuntimeSyntheticAuthProviderRefs } from "../plugins/synthetic-auth.runtime.js";
import { prepareAmbientAgentCredentialsForDiscovery } from "./agent-auth-discovery.js";
import { discoverModelsFromCapturedSources } from "./agent-model-discovery.js";
import { withAgentRosterFactsBatch } from "./agent-scope-config.js";
import { getPreparedRuntimeAuthProfileStoreSnapshotCore } from "./auth-profiles/runtime-snapshots.js";
import { buildInlineProviderModels } from "./embedded-agent-runner/model.inline-provider.js";
import {
  createBundledStaticCatalogModelResolver,
  loadBundledProviderStaticCatalogContextModels,
} from "./embedded-agent-runner/model.static-catalog.js";
import { createStaticModelIdMatcher } from "./embedded-agent-runner/model.static-id.js";
import type { RuntimePluginLoadPurpose } from "./harness/runtime-plugin-load-plan.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import {
  buildConfiguredModelCatalog,
  parseConfiguredModelVisibilityEntries,
} from "./model-selection-shared.js";
import { prepareImplicitProviderStaticCatalog } from "./models-config.providers.implicit.js";
import {
  loadPersistedPluginModelCatalogsReadOnly,
  resolvePluginModelCatalogOwnerPluginId,
} from "./plugin-model-catalog.js";
import { prepareAgentFacts } from "./prepared-model-runtime.agent-facts.js";
import type {
  PreparedModelRuntimeAgentBaseFacts,
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogFacts,
} from "./prepared-model-runtime.catalog-contract.js";
import { prepareCapturedRuntimeFacts } from "./prepared-model-runtime.configured-catalog.js";
import { completeConfiguredRuntimeModels } from "./prepared-model-runtime.configured-completion.js";
import {
  collectPreparedModelRuntimeConfiguredRefs,
  collectConfiguredProviderIdsNeedingStaticCatalog,
  collectPreparedModelRuntimeProviderIds,
  prepareConfiguredRuntimeModels,
  prepareRuntimeCapabilityModels,
} from "./prepared-model-runtime.configured.js";
import {
  prepareWorkspacePluginRegistries,
  type PreparedInboundRegistryLoader,
} from "./prepared-model-runtime.inbound-registry.js";
import { hasSameOAuthProviderGeneration } from "./prepared-model-runtime.oauth-providers.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";
import { createPreparedPluginGeneration } from "./prepared-model-runtime.plugin-generation.js";
import {
  discardPreparedPluginGeneration,
  retainPreparedPluginRegistry,
} from "./prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "./prepared-model-runtime.resources.js";
import {
  listPreparedSyntheticAuthProviderRefs,
  prepareSyntheticAuth,
  scopeSyntheticAuthProviderRefs,
} from "./prepared-model-runtime.synthetic-auth.js";
import type {
  PreparedModelRuntimeBuildStats,
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";

type PreparedConfiguredModelRegistry = {
  oauthProviders: ReturnType<AuthStorage["getOAuthProviders"]>;
  modelRegistry: ReturnType<typeof discoverModelsFromCapturedSources>;
};

export type PreparedConfiguredModelRegistries = Map<
  PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"],
  Map<string, PreparedConfiguredModelRegistry[]>
>;

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

export async function prepareWorkspaceBuildGroup(
  inputs: readonly PreparedModelRuntimeInput[],
  catalogMode: PreparedModelRuntimeCatalogMode,
  options: {
    providerDiscoveryProviderIds?: readonly string[];
    preferBuiltPluginArtifacts?: boolean;
    includeCredentialProviders?: boolean;
    getConfiguredHarnessRuntimes?: () => readonly string[];
    getConfiguredModelFacts?: typeof prepareConfiguredModelFacts;
    basePluginIds?: readonly string[];
    onStage?: (stage: string) => void;
    signal?: AbortSignal;
    assertCurrent?: (input: PreparedModelRuntimeInput) => void;
    onBeforeAuthCapture?: (input: PreparedModelRuntimeInput) => void;
    registryResources?: PreparedModelRuntimeBuildResources;
    loadRuntimeRegistry?: PreparedModelRuntimeBuildResources["load"];
    purpose?: RuntimePluginLoadPurpose;
  } = {},
  loadInboundPluginRegistry?: PreparedInboundRegistryLoader,
  reusablePluginGeneration?: PreparedModelRuntimePluginGeneration,
  preparedPluginMetadataSnapshot?: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"],
): Promise<{
  agentFacts: PreparedModelRuntimeAgentFacts[];
  pluginGeneration: PreparedModelRuntimePluginGeneration;
  buildStats: Pick<
    PreparedModelRuntimeBuildStats,
    | "runtimePluginMs"
    | "pluginMetadataMs"
    | "staticProviderCatalogMs"
    | "ambientCredentialsMs"
    | "agentFactsMs"
    | "configuredProjectionMs"
  >;
}> {
  const input = inputs[0];
  if (!input) {
    throw new Error("prepared model runtime workspace group is empty");
  }
  const env = input.env ?? process.env;
  let workspacePluginIds: string[] = [];
  const reportStage = (stage: string) =>
    options.onStage?.(
      `${stage}; agent ${input.agentId ?? "standalone"}` +
        (workspacePluginIds.length ? `; workspace plugins ${workspacePluginIds.join(", ")}` : ""),
    );
  reportStage("workspace plugins");
  const pluginMetadataStartedAt = performance.now();
  const pluginMetadataSnapshot =
    preparedPluginMetadataSnapshot ??
    reusablePluginGeneration?.pluginMetadataSnapshot ??
    prepareOwnedPluginLoadContext(input, env, undefined);
  // Raw preparation owns its facts across awaited auth/catalog work. Successful
  // generations acquire their independent borrow before this build scope releases it.
  using _ = {
    [Symbol.dispose]: retainPluginCache(getPluginMetadataSnapshotCache(pluginMetadataSnapshot)),
  };
  const pluginMetadataMs = reusablePluginGeneration
    ? 0
    : performance.now() - pluginMetadataStartedAt;
  const runtimePluginStartedAt = performance.now();
  workspacePluginIds = pluginMetadataSnapshot.index.plugins
    .filter((plugin) => plugin.enabled && plugin.origin === "workspace")
    .map((plugin) => plugin.pluginId);
  if (workspacePluginIds.length) {
    reportStage("workspace plugins");
  }
  const preferBuiltPluginArtifacts =
    reusablePluginGeneration?.preferBuiltPluginArtifacts ??
    options.preferBuiltPluginArtifacts === true;
  await using localResources = new AsyncDisposableStack();
  const registryResources =
    options.registryResources ??
    localResources.use(new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry));
  registryResources.retainGeneration(reusablePluginGeneration);
  // Borrowing spans the caller's construction; registry acquisition is selected independently.
  const preparingRegistries = prepareWorkspacePluginRegistries(
    input,
    pluginMetadataSnapshot,
    (registry) => registryResources.retainRegistry(registry),
    loadInboundPluginRegistry,
    preferBuiltPluginArtifacts,
    reusablePluginGeneration,
    options.getConfiguredHarnessRuntimes,
    options.basePluginIds,
    options.loadRuntimeRegistry,
    options.purpose,
  );
  const { inboundPluginRegistry, runtimePluginRegistry, primaryRegistry } =
    preparingRegistries instanceof Promise ? await preparingRegistries : preparingRegistries;
  const reuseRuntimeFacts =
    reusablePluginGeneration && runtimePluginRegistry === reusablePluginGeneration.pluginRegistry;
  const resources = primaryRegistry && getPluginRegistryInspectionResources(primaryRegistry);
  const mediaCapabilityProviderSource =
    primaryRegistry && resources
      ? Object.freeze({ registry: primaryRegistry, resources })
      : undefined;
  const runtimePluginMs = performance.now() - runtimePluginStartedAt;
  prepareOwnedPluginLoadContext(
    input,
    env,
    runtimePluginRegistry,
    pluginMetadataSnapshot,
    preferBuiltPluginArtifacts,
    inboundPluginRegistry,
  );
  let preparedGeneration: PreparedModelRuntimePluginGeneration | undefined;
  const prepare = async () => {
    options.assertCurrent?.(input);
    const matchesStaticModelId = createStaticModelIdMatcher({
      manifestPlugins: pluginMetadataSnapshot,
    });
    const mediaCapabilityProviders = reuseRuntimeFacts
      ? reusablePluginGeneration.mediaCapabilityProviders
      : input.readOnly || !runtimePluginRegistry
        ? undefined
        : prepareMediaCapabilityProviders({
            cfg: input.config,
            pluginMetadataSnapshot,
            registry: runtimePluginRegistry,
          });
    const messageToolCatalog = reuseRuntimeFacts
      ? reusablePluginGeneration.messageToolCatalog
      : runtimePluginRegistry
        ? getPreparedMessageToolCatalogForRegistry(runtimePluginRegistry)
        : catalogMode === "live"
          ? getPreparedMessageToolCatalog()
          : undefined;
    const resolveManifestStaticCatalogModel = createBundledStaticCatalogModelResolver({
      cfg: input.config,
      env,
      includeRuntimeDiscovery: true,
      metadataSnapshot: pluginMetadataSnapshot,
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    });
    const configuredManifestModels = new Map<string, ProviderRuntimeModel | undefined>();
    const resolveConfiguredManifestModel = (lookup: { provider: string; modelId: string }) => {
      const key = `${normalizeProviderId(lookup.provider)}\0${lookup.modelId.trim().toLowerCase()}`;
      if (configuredManifestModels.has(key)) {
        return configuredManifestModels.get(key);
      }
      const model = resolveManifestStaticCatalogModel(lookup);
      configuredManifestModels.set(key, model);
      return model;
    };
    const configuredProviders = new Set(
      (options.providerDiscoveryProviderIds ?? []).map(normalizeProviderId).filter(Boolean),
    );
    const configuredModelRefs: ConfiguredModelRef[] = [];
    for (const candidate of inputs) {
      await nextTurn();
      options.assertCurrent?.(candidate);
      const { config, agentId } = candidate;
      for (const provider of withAgentRosterFactsBatch(config, () => {
        const refs = collectPreparedModelRuntimeConfiguredRefs(
          config,
          agentId,
          candidate.readOnly ? candidate.runtimePluginSelections : undefined,
        );
        configuredModelRefs.push(...refs);
        return [
          ...collectPreparedModelRuntimeProviderIds(config, {}, false, refs, agentId),
          ...parseConfiguredModelVisibilityEntries({ cfg: config, agentId }).providerWildcards,
        ];
      })) {
        configuredProviders.add(provider);
      }
    }
    const configuredProviderIds = [...configuredProviders].toSorted((left, right) =>
      left.localeCompare(right),
    );
    const staticCatalogProviderIds = [
      ...new Set([
        ...collectConfiguredProviderIdsNeedingStaticCatalog({
          config: input.config,
          configuredModelRefs,
          matchesStaticModelId,
          resolveStaticCatalogModel: resolveConfiguredManifestModel,
        }),
        ...(options.providerDiscoveryProviderIds ?? []).map(normalizeProviderId).filter(Boolean),
      ]),
    ].toSorted((left, right) => left.localeCompare(right));
    const staticProviderCatalogStartedAt = performance.now();
    reportStage("static provider catalog");
    let preparedStaticProviderCatalog = reusablePluginGeneration
      ? reusablePluginGeneration.preparedStaticProviderCatalog
      : catalogMode === "static"
        ? await prepareImplicitProviderStaticCatalog({
            signal: options.signal,
            config: input.config,
            env,
            pluginMetadataSnapshot,
            providerDiscoveryProviderIds: configuredProviderIds,
            staticCatalogProviderIds,
            ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
          })
        : undefined;
    if (
      catalogMode === "static" &&
      reusablePluginGeneration &&
      !reuseRuntimeFacts &&
      runtimePluginRegistry?.providers.length
    ) {
      // Selected owners may supply synthetic auth absent from startup's configured
      // providers. Carry those exact handles through refresh without rediscovery.
      preparedStaticProviderCatalog = Object.freeze({
        entries: preparedStaticProviderCatalog?.entries ?? [],
        providers: Object.freeze([
          ...new Map([
            ...(preparedStaticProviderCatalog?.providers ?? []).map(
              (provider) => [provider.id, provider] as const,
            ),
            ...runtimePluginRegistry.providers.map(
              ({ provider }) => [provider.id, provider] as const,
            ),
          ]).values(),
        ]),
      });
    }
    const staticProviderCatalogMs = reusablePluginGeneration
      ? 0
      : performance.now() - staticProviderCatalogStartedAt;
    const preparedSyntheticAuthProviders = preparedStaticProviderCatalog?.providers ?? [];
    // Static Gateway publication consumes discovery entrypoints; the run owns activation.
    const ambientCredentialsStartedAt = performance.now();
    reportStage("ambient credentials");
    const ambientCredentials = await prepareAmbientAgentCredentialsForDiscovery({
      signal: options.signal,
      config: input.config,
      env,
      authoritativeSyntheticAuthProviderRefs: pluginMetadataSnapshot.owners.cliBackends.keys(),
      syntheticAuthProviderRefs:
        catalogMode === "static"
          ? scopeSyntheticAuthProviderRefs(
              listPreparedSyntheticAuthProviderRefs(preparedSyntheticAuthProviders),
              options.providerDiscoveryProviderIds,
            )
          : scopeSyntheticAuthProviderRefs(
              resolveRuntimeSyntheticAuthProviderRefs({
                config: input.config,
                env,
                index: pluginMetadataSnapshot.index,
                registryDiagnostics: pluginMetadataSnapshot.registryDiagnostics,
                ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
              }),
              configuredProviderIds,
            ),
      ...(catalogMode === "static"
        ? {
            resolveSyntheticAuth: (provider: string) =>
              prepareSyntheticAuth({
                signal: options.signal,
                config: input.config,
                env,
                workspaceDir: input.workspaceDir,
                provider,
                providers: preparedSyntheticAuthProviders,
              }),
          }
        : {}),
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    });
    const ambientCredentialsMs = performance.now() - ambientCredentialsStartedAt;
    const agentFactsStartedAt = performance.now();
    reportStage("agent facts");
    const agentBaseFacts: PreparedModelRuntimeAgentBaseFacts[] = [];
    for (const candidate of inputs) {
      await nextTurn();
      options.assertCurrent?.(candidate);
      options.onBeforeAuthCapture?.(candidate);
      agentBaseFacts.push(
        withAgentRosterFactsBatch(candidate.config, () =>
          prepareAgentFacts(
            candidate,
            catalogMode,
            ambientCredentials,
            options.providerDiscoveryProviderIds,
            options.includeCredentialProviders,
          ),
        ),
      );
    }
    const agentFactsMs = performance.now() - agentFactsStartedAt;
    const configuredProjectionStartedAt = performance.now();
    reportStage("configured model projection");
    const providerStaticModels =
      reusablePluginGeneration?.providerStaticModels ??
      (catalogMode === "static"
        ? []
        : await loadBundledProviderStaticCatalogContextModels({
            cfg: input.config,
            env,
            metadataSnapshot: pluginMetadataSnapshot,
            registeredProviders: runtimePluginRegistry?.providers,
            ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
          }));
    const { inlineProviderModels, configuredCatalogEntries } =
      reusablePluginGeneration ??
      (options.getConfiguredModelFacts ?? prepareConfiguredModelFacts)(
        input.config,
        pluginMetadataSnapshot,
      );
    const agentFacts: PreparedModelRuntimeAgentFacts[] = [];
    for (const facts of agentBaseFacts) {
      await nextTurn();
      options.assertCurrent?.(facts.input);
      const configuredRuntimeModels = prepareConfiguredRuntimeModels({
        config: facts.input.config,
        inlineProviderModels,
        configuredModelRefs: facts.configuredModelRefs,
        metadataSnapshot: pluginMetadataSnapshot,
        ...(preparedStaticProviderCatalog ? { preparedStaticProviderCatalog } : {}),
        providerStaticModels,
        matchesStaticModelId,
        resolveStaticCatalogModel: resolveConfiguredManifestModel,
      });
      const runtimeCapabilityModels = prepareRuntimeCapabilityModels({
        config: facts.input.config,
        agentId: facts.input.agentId,
        candidates: [
          ...configuredCatalogEntries,
          ...configuredRuntimeModels.map(({ model, modelId, provider }) => ({
            ...modelCatalogRowToEntry(model),
            id: modelId,
            provider,
          })),
        ],
        resolveRuntimeModel: resolveConfiguredManifestModel,
      });
      const configuredGeneratedCatalogPluginIds = [
        ...new Set(
          (facts.input.config.models?.mode === "replace" ? [] : facts.providerIds).flatMap(
            (provider) => {
              const pluginId = resolvePluginModelCatalogOwnerPluginId({
                providerId: provider,
                pluginMetadataSnapshot,
              });
              return pluginId ? [pluginId] : [];
            },
          ),
        ),
      ].toSorted((left, right) => left.localeCompare(right));
      agentFacts.push({
        ...facts,
        configuredRuntimeModels,
        runtimeCapabilityModels,
        configuredGeneratedCatalogPluginIds,
      });
    }
    const configuredProjectionMs = performance.now() - configuredProjectionStartedAt;
    const pluginGeneration = createPreparedPluginGeneration({
      catalogMode,
      configuredCatalogEntries,
      inboundPluginRegistry,
      inlineProviderModels,
      mediaCapabilityProviders,
      mediaCapabilityProviderSource,
      messageToolCatalog,
      pluginMetadataSnapshot,
      preparedStaticProviderCatalog,
      providerStaticModels,
      preferBuiltPluginArtifacts,
      reusablePluginGeneration,
      runtimePluginRegistry,
    });
    preparedGeneration = pluginGeneration;
    return {
      agentFacts,
      buildStats: {
        runtimePluginMs,
        pluginMetadataMs,
        staticProviderCatalogMs,
        ambientCredentialsMs,
        agentFactsMs,
        configuredProjectionMs,
      },
      pluginGeneration,
    };
  };
  try {
    const run = () =>
      withPluginRuntimeGenerationScope(
        {
          metadataSnapshot: pluginMetadataSnapshot,
          pluginRegistry: runtimePluginRegistry,
        },
        prepare,
      );
    if (!mediaCapabilityProviderSource) {
      return await run();
    }
    const isSourceCurrent = capturePluginLifecycleAuthority(
      mediaCapabilityProviderSource.registry,
      undefined,
      { scopedRuntime: true },
    );
    if (!isSourceCurrent?.()) {
      throw new Error("Prepared media capability provider source is retired");
    }
    const claim = mediaCapabilityProviderSource.resources.retain();
    let outcome: Result<Awaited<ReturnType<typeof prepare>>, unknown>;
    try {
      outcome = { ok: true, value: await run() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    try {
      // The caller still owns the original inspection; construction owns its actual awaited work.
      await claim.release();
    } catch (cleanupError) {
      outcome = {
        ok: false,
        error: outcome.ok
          ? cleanupError
          : new AggregateError(
              [outcome.error, cleanupError],
              "Prepared construction and registration cleanup failed",
              { cause: outcome.error },
            ),
      };
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    if (!isSourceCurrent()) {
      throw new Error("Prepared media capability provider source is retired");
    }
    return outcome.value;
  } catch (error) {
    const cleanup = preparedGeneration ? [discardPreparedPluginGeneration(preparedGeneration)] : [];
    const results = await Promise.allSettled(cleanup);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) {
      throw new AggregateError([error, ...failures], "Prepared plugin facts and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
}

export function captureModelsJsonContents(agentDir: string): string | null {
  try {
    return fs.readFileSync(path.join(agentDir, "models.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
export const fingerprintPreparedRuntimeFacts = (value: unknown): string =>
  sha256Base64Url(stableStringify(value));

/** Record discovery scope before config projection or auth-owner publication can replace it. */
export function preparedModelInventoryKey(input: PreparedModelRuntimeInput): string {
  const { models, auth, env } = input.config;
  const plugins = normalizePluginsConfig(input.config.plugins);
  for (const entry of Object.values(plugins.entries)) {
    entry.config ??= {};
  }
  return fingerprintPreparedRuntimeFacts({
    ...input,
    config: { models, auth, env, plugins },
    env: input.env ?? process.env,
    runtimePluginSelections: undefined,
    order:
      getPreparedRuntimeAuthProfileStoreSnapshotCore(input.agentDir, input.inheritedAuthDir)
        ?.order ?? {},
  });
}
export async function prepareConfiguredRuntimeFactsBatch(params: {
  agentFacts: readonly PreparedModelRuntimeAgentFacts[];
  pluginGeneration: PreparedModelRuntimePluginGeneration;
  assertCurrent?: (input: PreparedModelRuntimeInput) => void;
  registries?: PreparedConfiguredModelRegistries;
}): Promise<{
  catalogs: Map<PreparedModelRuntimeInput, PreparedModelRuntimeCatalogFacts>;
  registryCount: number;
}> {
  const catalogs = new Map<PreparedModelRuntimeInput, PreparedModelRuntimeCatalogFacts>();
  let registryCount = 0;
  const staticProviderConfigs = resolvePreparedProviderStaticConfigs(
    params.pluginGeneration.preparedStaticProviderCatalog,
  );
  const { pluginMetadataSnapshot } = params.pluginGeneration;
  const registries: PreparedConfiguredModelRegistries = params.registries ?? new Map();
  let registriesBySource = registries.get(pluginMetadataSnapshot);
  if (!registriesBySource) {
    registriesBySource = new Map();
    registries.set(pluginMetadataSnapshot, registriesBySource);
  }
  for (const facts of params.agentFacts) {
    await nextTurn();
    params.assertCurrent?.(facts.input);
    const modelsJsonContents = captureModelsJsonContents(facts.input.agentDir);
    const oauthProviders = facts.templateAuthStorage.getOAuthProviders();
    // Root files remain authored inventory even when static preparation returned an empty result.
    const pluginCatalogs = loadPersistedPluginModelCatalogsReadOnly(
      facts.input.agentDir,
      facts.configuredGeneratedCatalogPluginIds,
    );
    const key = fingerprintPreparedRuntimeFacts({
      config: hashRuntimeConfigValue(facts.input.config),
      sourceModels: projectConfigOntoRuntimeSourceSnapshot(facts.input.config).models,
      credentials: facts.credentials,
      modelsJsonContents,
      pluginCatalogs,
      staticProviderConfigs,
    });
    const candidates = registriesBySource.get(key) ?? [];
    let prepared = candidates.find((candidate) =>
      hasSameOAuthProviderGeneration(candidate.oauthProviders, oauthProviders),
    );
    if (!prepared) {
      prepared = {
        oauthProviders,
        modelRegistry: discoverModelsFromCapturedSources(facts.templateAuthStorage, {
          config: facts.input.config,
          includePluginCatalogs: true,
          modelsJsonContents,
          pluginCatalogs,
          staticProviderConfigs,
          pluginMetadataSnapshot,
          ...(facts.input.workspaceDir ? { workspaceDir: facts.input.workspaceDir } : {}),
        }),
      };
      candidates.push(prepared);
      registriesBySource.set(key, candidates);
      registryCount += 1;
    }
    const templateModelRegistry = prepared.modelRegistry;
    const configuredRuntimeModels = completeConfiguredRuntimeModels(
      facts,
      params.pluginGeneration,
      templateModelRegistry,
    );
    catalogs.set(
      facts.input,
      prepareCapturedRuntimeFacts({
        agentFacts: facts,
        workspaceFacts: params.pluginGeneration,
        templateModelRegistry,
        configuredRuntimeModels,
      }),
    );
  }
  return { catalogs, registryCount };
}
