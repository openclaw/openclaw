import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ModelRegistry as CoreModelRegistry } from "../../llm/model-registry.js";
import type { Model } from "../../llm/types.js";
import type { PluginMetadataSnapshotOwnerMaps } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { loadAuthProfileStoreForRuntime, resolveAuthProfileOrder } from "../auth-profiles.js";
import { externalCliDiscoveryForProviderAuth } from "../auth-profiles/external-cli-discovery.js";
import { createSelectedAuthProfileUnavailableError } from "../auth-profiles/selection-error.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import { resolveAgentHarnessPolicy } from "../harness/policy.js";
import { normalizeStaticProviderModelId } from "../model-ref-shared.js";
import { normalizeProviderId } from "../model-selection.js";
import {
  buildSuppressedBuiltInModelError,
  shouldUnconditionallySuppress,
} from "../model-suppression.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../openai-routing.js";
import { buildConfiguredFallbackModel } from "./model.configured-fallback.js";
import {
  applyConfiguredProviderOverrides,
  findInlineModelMatch,
  mergeStaticCatalogInlineModel,
  resolveConfiguredProviderConfig,
  shouldSuppressConfiguredModel,
  type StaticCatalogFallbackModel,
} from "./model.configured-overrides.js";
import type { InlineModelEntry } from "./model.inline-provider.js";
import {
  resolveRuntimeHooks,
  normalizeResolvedModel,
  type ProviderRuntimeHooks,
} from "./model.provider-hooks.js";
import {
  resolveBundledStaticCatalogModel,
  resolveManifestModelCatalogProviderAliasMetadata,
  type ManifestModelCatalogProviderAliasMetadata,
} from "./model.static-catalog.js";

type ExplicitModelResolution =
  | { kind: "resolved"; model: Model; source: "configured" }
  | { kind: "resolved"; dropOnRuntimeMiss: boolean; model: Model; source: "registry" }
  | { kind: "suppressed" | "unavailable"; error?: string };

function getRegistryProviderMetadataOwners(
  modelRegistry: CoreModelRegistry,
): PluginMetadataSnapshotOwnerMaps | undefined {
  return (
    modelRegistry as CoreModelRegistry & {
      getProviderMetadataOwners?: () => PluginMetadataSnapshotOwnerMaps | undefined;
    }
  ).getProviderMetadataOwners?.();
}

export function resolveExplicitModelWithRegistry(params: {
  provider: string;
  modelId: string;
  modelRegistry: CoreModelRegistry;
  cfg?: OpenClawConfig;
  agentDir?: string;
  manifestAlias: ManifestModelCatalogProviderAliasMetadata;
  workspaceDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
  preparedInlineProviderModels?: readonly InlineModelEntry[];
  preparedCatalogModel?: ProviderRuntimeModel;
  getStaticCatalogModel?: () => StaticCatalogFallbackModel | undefined;
}): ExplicitModelResolution | undefined {
  const { provider, modelId, modelRegistry, cfg, agentDir, workspaceDir, runtimeHooks } = params;
  // Competing activated owners cannot lend either model or transport authority.
  if (params.manifestAlias.ambiguous) {
    return { kind: "unavailable" };
  }
  if (shouldUnconditionallySuppress({ provider, id: modelId, config: cfg, workspaceDir })) {
    return { kind: "suppressed" };
  }
  const providerMetadataOwners = getRegistryProviderMetadataOwners(modelRegistry);
  const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
  const inlineMatch = findInlineModelMatch({
    providers: cfg?.models?.providers ?? {},
    preparedModels: params.preparedInlineProviderModels,
    provider,
    modelId,
  });
  const inlineModel = inlineMatch?.api ? inlineMatch : undefined;
  const registryModel = params.preparedCatalogModel ?? modelRegistry.find(provider, modelId);
  const staticCatalogModel = inlineModel ? params.getStaticCatalogModel?.() : undefined;
  // Inline config owns transport and sizing; the captured catalog owns its lower price schedule.
  const discoveredModel = inlineModel
    ? {
        ...mergeStaticCatalogInlineModel(staticCatalogModel, inlineModel as Model),
        cost: registryModel?.cost ?? staticCatalogModel?.cost ?? inlineModel.cost,
      }
    : registryModel;
  if (!discoveredModel) {
    // An authored row without transport cannot borrow provider fallback authority.
    if (inlineMatch) {
      return undefined;
    }
    const error = buildSuppressedBuiltInModelError({
      provider,
      id: modelId,
      config: cfg,
      baseUrl: providerConfig?.baseUrl,
      workspaceDir,
    });
    return error ? { kind: "suppressed", error } : undefined;
  }
  const overriddenModel = applyConfiguredProviderOverrides({
    provider,
    discoveredModel,
    providerConfig,
    modelId,
    cfg,
    manifestAlias: params.manifestAlias,
    providerMetadataOwners,
    runtimeHooks,
    workspaceDir,
    preferDiscoveredTransport: Boolean(inlineModel),
    staticCatalogModel,
    getStaticCatalogModel: params.getStaticCatalogModel,
  });
  if (!overriddenModel) {
    return undefined;
  }
  const model = normalizeResolvedModel({
    provider,
    cfg,
    agentDir,
    workspaceDir,
    model: overriddenModel,
    runtimeHooks,
  });
  // Suppression follows the normalized model-level route, including custom endpoint overrides.
  if (
    !inlineModel ||
    shouldSuppressConfiguredModel({ provider, modelId, cfg, workspaceDir, baseUrl: model.baseUrl })
  ) {
    const error = buildSuppressedBuiltInModelError({
      provider,
      id: modelId,
      config: cfg,
      baseUrl: model.baseUrl,
      workspaceDir,
    });
    if (error) {
      return { kind: "suppressed", error };
    }
  }
  return inlineModel
    ? { kind: "resolved", source: "configured", model }
    : {
        kind: "resolved",
        source: "registry",
        model,
        dropOnRuntimeMiss:
          normalizeProviderId(provider) === "openai" &&
          modelId.trim().toLowerCase() === "gpt-5.3-codex-spark" &&
          !(providerConfig?.baseUrl ?? discoveredModel.baseUrl),
      };
}

export function resolveDynamicModelAuthProfile(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  authProfileId?: string;
  authProfileMode?: AuthProfileCredential["type"] | "aws-sdk";
  preferredProfile?: string;
}): {
  authProfileId?: string;
  authProfileMode?: AuthProfileCredential["type"] | "aws-sdk";
} {
  const explicitProfileId = params.authProfileId?.trim() || undefined;
  // A prepared mode is authoritative; model discovery does not reselect its credentials.
  if (params.authProfileMode) {
    return {
      ...(explicitProfileId ? { authProfileId: explicitProfileId } : {}),
      authProfileMode: params.authProfileMode,
    };
  }
  const store = loadAuthProfileStoreForRuntime(params.agentDir, {
    readOnly: true,
    migrationProvider: params.provider,
    allowKeychainPrompt: false,
    profileId: explicitProfileId,
    config: params.cfg,
    externalCli: externalCliDiscoveryForProviderAuth({
      cfg: params.cfg,
      provider: params.provider,
      profileId: explicitProfileId,
      preferredProfile: params.preferredProfile,
    }),
  });
  const profileId =
    explicitProfileId ??
    listOpenAIAuthProfileProvidersForAgentRuntime({
      provider: params.provider,
      config: params.cfg,
    }).flatMap((provider) =>
      resolveAuthProfileOrder({
        cfg: params.cfg,
        store,
        provider,
        preferredProfile: params.preferredProfile,
        forModel: params.modelId,
      }),
    )[0];
  if (!profileId) {
    return {};
  }
  const credential = store.profiles[profileId];
  const configuredMode = params.cfg?.auth?.profiles?.[profileId]?.mode;
  if (explicitProfileId && !credential && configuredMode !== "aws-sdk") {
    // Credential-scoped discovery cannot distinguish a missing model after its profile is removed.
    throw createSelectedAuthProfileUnavailableError({
      provider: params.provider,
      modelId: params.modelId,
      profileId,
    });
  }
  return {
    authProfileId: profileId,
    ...(credential?.type || configuredMode
      ? { authProfileMode: credential?.type ?? configuredMode }
      : {}),
  };
}

function resolvePluginDynamicModelWithRegistry(
  params: ResolveModelWithPreparedRegistryParams,
): Model | undefined {
  const { provider, modelId, modelRegistry, cfg, agentDir, workspaceDir } = params;
  const runtimeHooks = params.runtimeHooks ?? resolveRuntimeHooks();
  const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
  let pluginDynamicModel = params.preparedDynamicModel;
  if (!pluginDynamicModel) {
    // Prepared models already consumed discovery inputs; only a sync hook needs them again.
    const agentHarnessPolicy = resolveAgentHarnessPolicy({ provider, modelId, config: cfg });
    const inferredAgentRuntimeId =
      agentHarnessPolicy.runtimeSource !== "implicit" ||
      cfg?.plugins?.entries?.codex?.enabled === true
        ? agentHarnessPolicy.runtime
        : undefined;
    const agentRuntimeId = params.agentRuntimeId ?? inferredAgentRuntimeId;
    pluginDynamicModel = runtimeHooks.runProviderDynamicModel({
      provider,
      config: cfg,
      workspaceDir,
      context: {
        config: cfg,
        agentDir,
        workspaceDir,
        ...(agentRuntimeId ? { agentRuntimeId } : {}),
        provider,
        modelId,
        modelRegistry,
        providerConfig,
        ...resolveDynamicModelAuthProfile(params),
      },
    }) as ProviderRuntimeModel | undefined;
  }
  if (!pluginDynamicModel) {
    return undefined;
  }
  const overriddenDynamicModel = applyConfiguredProviderOverrides({
    provider,
    discoveredModel: pluginDynamicModel,
    providerConfig,
    modelId,
    cfg,
    manifestAlias: params.manifestAlias,
    providerMetadataOwners: getRegistryProviderMetadataOwners(modelRegistry),
    runtimeHooks,
    workspaceDir,
    preferDiscoveredModelMetadata: shouldCompareProviderRuntimeResolvedModel({
      ...params,
      runtimeHooks,
    }),
    getStaticCatalogModel: params.getStaticCatalogModel,
  });
  if (!overriddenDynamicModel) {
    return undefined;
  }
  return normalizeResolvedModel({
    provider,
    cfg,
    agentDir,
    workspaceDir,
    model: overriddenDynamicModel,
    runtimeHooks,
  });
}

export function resolveRuntimePreferredSuppressedModel(
  params: ResolveModelWithPreparedRegistryParams,
): Model | undefined {
  const runtimeHooks = params.runtimeHooks ?? resolveRuntimeHooks();
  if (!shouldCompareProviderRuntimeResolvedModel({ ...params, runtimeHooks })) {
    return undefined;
  }
  return resolvePluginDynamicModelWithRegistry({ ...params, runtimeHooks });
}

function shouldDropRuntimePreferredExplicitMiss(params: {
  provider: string;
  modelId: string;
  explicitModel: ExplicitModelResolution;
}): boolean {
  return (
    params.explicitModel.kind === "resolved" &&
    params.explicitModel.source === "registry" &&
    params.explicitModel.dropOnRuntimeMiss
  );
}

export function shouldCompareProviderRuntimeResolvedModel(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  runtimeHooks: ProviderRuntimeHooks;
}): boolean {
  return (
    params.runtimeHooks.shouldPreferProviderRuntimeResolvedModel?.({
      provider: params.provider,
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      context: {
        provider: params.provider,
        modelId: params.modelId,
        config: params.cfg,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
      },
    }) ?? false
  );
}

export function normalizeProviderModelRef(params: {
  provider: string;
  modelId: string;
  modelIdSource?: "input" | "selected";
  cfg?: OpenClawConfig;
  workspaceDir?: string;
}): {
  provider: string;
  model: string;
  manifestAlias: ManifestModelCatalogProviderAliasMetadata;
} {
  const manifestAlias = resolveManifestModelCatalogProviderAliasMetadata({
    provider: params.provider,
    modelId: params.modelId,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
  });
  return {
    provider: manifestAlias.provider,
    model:
      params.modelIdSource === "selected"
        ? params.modelId
        : normalizeStaticProviderModelId(
            normalizeProviderId(manifestAlias.provider),
            params.modelId,
          ),
    manifestAlias,
  };
}

type ResolveModelWithRegistryParams = {
  provider: string;
  modelId: string;
  modelRegistry: CoreModelRegistry;
  cfg?: OpenClawConfig;
  agentDir?: string;
  agentRuntimeId?: string;
  workspaceDir?: string;
  authProfileId?: string;
  authProfileMode?: AuthProfileCredential["type"] | "aws-sdk";
  preferredProfile?: string;
  runtimeHooks?: ProviderRuntimeHooks;
  skipConfiguredFallback?: boolean;
};

type ResolveModelWithPreparedRegistryParams = ResolveModelWithRegistryParams & {
  manifestAlias: ManifestModelCatalogProviderAliasMetadata;
  preparedDynamicModel?: ProviderRuntimeModel;
  getStaticCatalogModel?: () => StaticCatalogFallbackModel | undefined;
};

export function resolveModelWithPreparedRegistry(
  params: ResolveModelWithPreparedRegistryParams,
): Model | undefined {
  const runtimeHooks = params.runtimeHooks ?? resolveRuntimeHooks();
  const explicitModel = resolveExplicitModelWithRegistry(params);
  if (explicitModel?.kind === "unavailable") {
    return undefined;
  }
  if (explicitModel?.kind === "suppressed") {
    return resolveRuntimePreferredSuppressedModel(params);
  }
  if (explicitModel?.kind === "resolved") {
    if (!shouldCompareProviderRuntimeResolvedModel({ ...params, runtimeHooks })) {
      return explicitModel.model;
    }
    return (
      resolvePluginDynamicModelWithRegistry(params) ??
      (shouldDropRuntimePreferredExplicitMiss({
        provider: params.provider,
        modelId: params.modelId,
        explicitModel,
      })
        ? undefined
        : explicitModel.model)
    );
  }
  const pluginDynamicModel = resolvePluginDynamicModelWithRegistry(params);
  if (pluginDynamicModel) {
    return pluginDynamicModel;
  }
  return params.skipConfiguredFallback
    ? undefined
    : buildConfiguredFallbackModel({
        ...params,
        providerMetadataOwners: getRegistryProviderMetadataOwners(params.modelRegistry),
      });
}

export function resolveModelWithRegistry(
  params: ResolveModelWithRegistryParams,
): Model | undefined {
  const workspaceDir = params.workspaceDir ?? params.cfg?.agents?.defaults?.workspace;
  const normalizedRef = normalizeProviderModelRef({ ...params, workspaceDir });
  let staticCatalogResolved = false;
  let staticCatalogModel: StaticCatalogFallbackModel | undefined;
  const getStaticCatalogModel = () => {
    if (!staticCatalogResolved) {
      staticCatalogResolved = true;
      staticCatalogModel = resolveBundledStaticCatalogModel({
        provider: normalizedRef.provider,
        modelId: normalizedRef.model,
        cfg: params.cfg,
        workspaceDir,
        includeRuntimeDiscovery: true,
      });
    }
    return staticCatalogModel;
  };
  return resolveModelWithPreparedRegistry({
    ...params,
    provider: normalizedRef.provider,
    modelId: normalizedRef.model,
    manifestAlias: normalizedRef.manifestAlias,
    getStaticCatalogModel,
    ...(workspaceDir !== undefined ? { workspaceDir } : {}),
  });
}
