import { prepareModelForSimpleCompletion } from "@openclaw/ai/transports";
/**
 * Simple completion runtime preparation.
 *
 * Resolves agent model selection, auth, runtime policy, and missing-auth errors before simple completions run.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { bindModelLlmRuntime } from "../llm/model-runtime-binding.js";
import type { Model } from "../llm/types.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  attachModelProviderRuntimePluginHandle,
  resolveProviderRuntimePluginHandle,
} from "../plugins/provider-hook-runtime.js";
import { prepareProviderRuntimeAuth } from "../plugins/provider-runtime.runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "./agent-scope.js";
import { ensureAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintResolvedProviderAuth,
} from "./execution-auth-binding.js";
import {
  createAgentRuntimeMetadataPluginIdScope,
  type AgentHarnessPluginSelection,
} from "./harness/runtime-plugin-load-plan.js";
import {
  applySecretRefHeaderSentinels,
  applyLocalNoAuthHeaderOverride,
  formatMissingAuthError,
  getApiKeyForModelCore,
  type ResolvedProviderAuth,
} from "./model-auth.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import { resolveModelRouteIntent } from "./model-runtime-policy.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "./model-selection.js";
import { resolveOpenAIModelRoutes } from "./openai-model-routes.js";
import {
  acquireAgentRunPreparedModelRuntime,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.js";
import { resolveProviderModelRouteAuthRequirement } from "./provider-model-route-auth.js";
import { applyPreparedRuntimeAuthToModel } from "./provider-request-config.js";
import { protectPreparedProviderRuntimeAuth } from "./provider-runtime-auth-protection.js";
import { materializePreparedRuntimeModel } from "./runtime-plan/materialize-model.js";
import { prepareAgentRuntimeAuth } from "./runtime-plan/prepare-auth.js";
import {
  resolvePreparedRuntimeAuthAttempts,
  resolvePreparedRuntimeModelAuth,
} from "./runtime-plan/resolve-auth.js";
import type { AgentRuntimeAuthPlan } from "./runtime-plan/types.js";
import { getModelRegistryRuntime } from "./sessions/model-registry-runtime.js";
import {
  createPreparedSimpleCompletionResolverContext,
  type PreparedSimpleCompletionResolverContext,
  type SimpleCompletionModelResolver,
} from "./simple-completion-scope.js";
import type {
  AgentSimpleCompletionSelection,
  PreparedSimpleCompletionModel,
  PreparedSimpleCompletionModelForAgent,
  PrepareSimpleCompletionModelForAgentParams,
} from "./simple-completion.types.js";
import { resolveUtilityModelRefForAgent } from "./utility-model.js";

type AllowedMissingApiKeyMode = ResolvedProviderAuth["mode"];

type SimpleCompletionSelectionParams = {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  modelRef?: string;
  useUtilityModel?: boolean;
  manifestPlugins?:
    | PluginMetadataSnapshot["plugins"]
    | Pick<PluginMetadataSnapshot, "plugins" | "owners">;
};

type SimpleCompletionSelectionRequest = {
  selection: AgentSimpleCompletionSelection;
  shorthandModelId?: string;
};

function resolveSimpleCompletionSelectionRequest(
  params: SimpleCompletionSelectionParams,
): SimpleCompletionSelectionRequest | null {
  const fallbackRef = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    manifestPlugins: params.manifestPlugins,
  });
  // Utility routing derives a provider-declared small model when unset and
  // treats an explicit empty utilityModel as "use the primary" (disabled).
  const modelRef =
    params.modelRef?.trim() ||
    (params.useUtilityModel
      ? resolveUtilityModelRefForAgent({
          cfg: params.cfg,
          agentId: params.agentId,
          primaryProvider: fallbackRef.provider,
          ...(params.manifestPlugins
            ? {
                metadataSnapshot:
                  "plugins" in params.manifestPlugins
                    ? params.manifestPlugins
                    : { plugins: params.manifestPlugins },
              }
            : {}),
        })
      : undefined) ||
    resolveAgentEffectiveModelPrimary(params.cfg, params.agentId);
  const split = modelRef ? splitTrailingAuthProfile(modelRef) : null;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: fallbackRef.provider || DEFAULT_PROVIDER,
    manifestPlugins: params.manifestPlugins,
  });
  const resolved = split
    ? resolveModelRefFromString({
        cfg: params.cfg,
        agentId: params.agentId,
        raw: split.model,
        defaultProvider: fallbackRef.provider || DEFAULT_PROVIDER,
        aliasIndex,
        manifestPlugins: params.manifestPlugins,
      })
    : null;
  const provider = resolved?.ref.provider ?? fallbackRef.provider;
  const modelId = resolved?.ref.model ?? fallbackRef.model;
  if (!provider || !modelId) {
    return null;
  }
  return {
    selection: {
      provider,
      modelId,
      profileId: split?.profile || undefined,
      agentDir: params.agentDir?.trim() || resolveAgentDir(params.cfg, params.agentId),
    },
    ...(split && !split.model.includes("/") ? { shorthandModelId: split.model } : {}),
  };
}

export function resolveSimpleCompletionSelectionForAgent(
  params: SimpleCompletionSelectionParams,
): AgentSimpleCompletionSelection | null {
  return resolveSimpleCompletionSelectionRequest(params)?.selection ?? null;
}

export type PrepareSimpleCompletionModelParams = {
  cfg: OpenClawConfig | undefined;
  agentId?: string;
  provider: string;
  modelId: string;
  modelIdSource?: "input" | "selected";
  agentDir?: string;
  profileId?: string;
  preferredProfile?: string;
  allowMissingApiKeyModes?: ReadonlyArray<AllowedMissingApiKeyMode>;
  allowBundledStaticCatalogFallback?: boolean;
  skipAgentDiscovery?: boolean;
  bindAuthOwner?: boolean;
  modelResolver?: SimpleCompletionModelResolver;
  signal?: AbortSignal;
  /** Internal caller-owned generation. Public plugin callers use the agent helper below. */
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  workspaceDir?: string;
  agentRuntimeId?: string;
};

/** Prepares a model within the exact generation already held by its caller. */
export async function prepareSimpleCompletionModel(
  params: PrepareSimpleCompletionModelParams & {
    preparedModelRuntime: PreparedModelRuntimeSnapshot;
  },
): Promise<PreparedSimpleCompletionModel> {
  params.signal?.throwIfAborted();
  const config = params.cfg ?? {};
  const preparedModelRuntime = params.preparedModelRuntime;
  const context = createPreparedSimpleCompletionResolverContext({
    preparedModelRuntime,
    workspaceDir:
      params.workspaceDir ??
      preparedModelRuntime.workspaceDir ??
      resolveAgentWorkspaceDir(config, params.agentId ?? resolveDefaultAgentId(config)),
    modelResolver: params.modelResolver,
    agentRuntimeId: params.agentRuntimeId,
  });
  const prepared = await withPluginRuntimeGenerationScope(preparedModelRuntime, () =>
    prepareSimpleCompletionModelCore(
      { ...params, agentDir: preparedModelRuntime.agentDir },
      context,
    ),
  );
  params.signal?.throwIfAborted();
  return prepared;
}

async function prepareSimpleCompletionModelCore(
  params: PrepareSimpleCompletionModelParams,
  context: PreparedSimpleCompletionResolverContext,
): Promise<PreparedSimpleCompletionModel> {
  const { modelResolver, workspaceDir } = context;
  const resolved = await modelResolver(
    params.provider,
    params.modelId,
    params.agentDir,
    params.cfg,
    {
      modelIdSource: params.modelIdSource,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.allowBundledStaticCatalogFallback !== undefined
        ? { allowBundledStaticCatalogFallback: params.allowBundledStaticCatalogFallback }
        : {}),
      ...(params.skipAgentDiscovery ? { skipAgentDiscovery: true } : {}),
      authProfileId: params.profileId,
      preferredProfile: params.preferredProfile,
    },
  );
  if (!resolved.model) {
    return {
      error: resolved.error ?? `Unknown model: ${params.provider}/${params.modelId}`,
    };
  }
  const initialModel = resolved.model;
  let resolvedModel = initialModel;
  let authStore: AuthProfileStore | undefined;
  let auth: ResolvedProviderAuth;
  try {
    authStore =
      params.bindAuthOwner || initialModel.provider === "openai"
        ? ensureAuthProfileStore(params.agentDir, {
            readOnly: true,
            allowKeychainPrompt: false,
            config: params.cfg,
            profileId: params.profileId,
          })
        : undefined;

    const primaryModel = params.cfg
      ? resolveDefaultModelForAgent({
          cfg: params.cfg,
          agentId: params.agentId,
          allowManifestNormalization: false,
          allowPluginNormalization: false,
        })
      : undefined;
    const resolveProfileAuthMode = (profileId: string) => authStore?.profiles[profileId]?.type;
    const routeIntent = params.agentRuntimeId
      ? { runtimeId: params.agentRuntimeId, source: "explicit" as const }
      : resolveModelRouteIntent({
          config: params.cfg,
          provider: initialModel.provider,
          modelId: initialModel.id,
          agentId: params.agentId,
          primaryModel,
          resolveProfileAuthMode,
        });
    const routeResolution = resolveOpenAIModelRoutes({
      provider: initialModel.provider,
      modelId: initialModel.id,
      api: initialModel.api,
      baseUrl: initialModel.baseUrl,
      config: params.cfg,
      agentId: params.agentId,
      routeIntent,
      resolveProfileAuthMode,
      pinnedAuthRequirement: resolveProviderModelRouteAuthRequirement(
        params.profileId ? authStore?.profiles[params.profileId]?.type : undefined,
      ),
      env: process.env,
    });
    const preparedAuth =
      routeResolution?.kind === "routes"
        ? prepareAgentRuntimeAuth({
            provider: initialModel.provider,
            modelId: initialModel.id,
            modelApi: initialModel.api,
            modelBaseUrl: initialModel.baseUrl,
            config: params.cfg,
            agentId: params.agentId,
            routeIntent,
            agentDir: params.agentDir,
            workspaceDir,
            authProfileStore: authStore,
            metadataSnapshot: context.preparedModelRuntime.metadataSnapshot,
            sessionAuthProfileId: params.profileId ?? params.preferredProfile,
            sessionAuthProfileSource: params.profileId ? "user" : "auto",
            ...(params.bindAuthOwner && params.profileId
              ? { allowAuthProfileFallback: false }
              : {}),
          })
        : undefined;
    const materializeModel = async ({
      plan,
      model,
      forceResolve,
    }: {
      plan: AgentRuntimeAuthPlan;
      model: Model;
      forceResolve?: boolean;
    }) =>
      (await materializePreparedRuntimeModel({
        plan,
        provider: initialModel.provider,
        modelId: initialModel.id,
        config: params.cfg,
        workspaceDir,
        metadataSnapshot: context.preparedModelRuntime.metadataSnapshot,
        model,
        forceResolve,
        resolveModel: ({ config, authProfileId, authProfileMode }) =>
          modelResolver(initialModel.provider, initialModel.id, params.agentDir, config, {
            modelIdSource: "selected",
            ...(params.agentId ? { agentId: params.agentId } : {}),
            skipAgentDiscovery: true,
            allowBundledStaticCatalogFallback: true,
            preferBundledStaticCatalogTransport: true,
            authProfileId,
            authProfileMode,
          }),
      })) ?? model;
    if (preparedAuth && authStore) {
      const resolvedAuth = await resolvePreparedRuntimeAuthAttempts({
        attempts: preparedAuth.attempts,
        store: authStore,
        modelId: initialModel.id,
        model: initialModel,
        materializeModel,
        resolveAuth: ({ attempt, model }) =>
          resolvePreparedRuntimeModelAuth({
            plan: attempt.plan,
            model,
            cfg: params.cfg,
            agentDir: params.agentDir,
            workspaceDir,
            store: authStore,
            allowAuthProfileFallback: attempt.allowAuthProfileFallback,
            secretSentinels: true,
          }),
        errorMessage: "Simple completion auth attempts could not be resolved.",
      });
      auth = resolvedAuth.auth;
      resolvedModel = resolvedAuth.model;
    } else {
      auth = await getApiKeyForModelCore({
        model: initialModel,
        cfg: params.cfg,
        agentDir: params.agentDir,
        workspaceDir,
        profileId: params.profileId,
        preferredProfile: params.preferredProfile,
        ...(authStore ? { store: authStore } : {}),
        ...(params.bindAuthOwner && params.profileId ? { lockedProfile: true } : {}),
        secretSentinels: true,
      });
    }
  } catch (err) {
    return {
      error: `Auth lookup failed for provider "${initialModel.provider}": ${formatErrorMessage(err)}`,
    };
  }
  const rawApiKey = auth.apiKey?.trim();
  if (!rawApiKey && !params.allowMissingApiKeyModes?.includes(auth.mode)) {
    return {
      error: formatMissingAuthError(auth, resolvedModel.provider),
      auth,
    };
  }

  let authValue = rawApiKey;
  if (rawApiKey) {
    const preparedAuth = protectPreparedProviderRuntimeAuth({
      provider: resolvedModel.provider,
      preparedAuth: await prepareProviderRuntimeAuth({
        provider: resolvedModel.provider,
        config: params.cfg,
        workspaceDir,
        env: process.env,
        context: {
          config: params.cfg,
          workspaceDir,
          env: process.env,
          provider: resolvedModel.provider,
          modelId: resolvedModel.id,
          model: resolvedModel,
          apiKey: rawApiKey,
          authMode: auth.mode,
          profileId: auth.profileId,
        },
      }),
    });
    authValue = preparedAuth?.apiKey?.trim() || rawApiKey;
    resolved.authStorage.setRuntimeApiKey(resolvedModel.provider, authValue);
    resolvedModel = applyPreparedRuntimeAuthToModel(resolvedModel, preparedAuth);
  }

  const resolvedAuth: ResolvedProviderAuth = {
    ...auth,
    apiKey: authValue,
  };
  const profileCredential = params.profileId ? authStore?.profiles[params.profileId] : undefined;
  const sourceAuthFingerprint = params.bindAuthOwner
    ? profileCredential?.type === "oauth" && params.profileId
      ? fingerprintAuthProfileCredential({
          profileId: params.profileId,
          credential: profileCredential,
        })
      : fingerprintResolvedProviderAuth(auth)
    : undefined;
  const modelRuntime = getModelRegistryRuntime(resolved.modelRegistry);
  const model = applySecretRefHeaderSentinels(
    applyLocalNoAuthHeaderOverride(resolvedModel, resolvedAuth),
    params.cfg,
  );
  const providerRuntimeHandle = resolveProviderRuntimePluginHandle({
    provider: model.provider,
    modelId: model.id,
    config: params.cfg,
    workspaceDir,
    env: process.env,
    pluginMetadataSnapshot: context.preparedModelRuntime.metadataSnapshot,
  });
  const preparedModel = attachModelProviderRuntimePluginHandle(model, providerRuntimeHandle);
  // Capture this generation's transport hooks while keeping the logical model API
  // visible to callers that build prompts before dispatch.
  const completionTransport = attachModelProviderRuntimePluginHandle(
    prepareModelForSimpleCompletion({
      apiRegistry: modelRuntime.apiRegistry,
      model: preparedModel,
      cfg: params.cfg,
    }),
    providerRuntimeHandle,
  );

  return {
    model: bindModelLlmRuntime(preparedModel, modelRuntime.llmRuntime, completionTransport),
    auth: resolvedAuth,
    ...(sourceAuthFingerprint ? { sourceAuthFingerprint } : {}),
  };
}

async function acquirePreparedSimpleCompletionRuntime(
  params: {
    cfg: OpenClawConfig | undefined;
    agentId?: string;
    agentDir?: string;
    modelResolver?: SimpleCompletionModelResolver;
    signal?: AbortSignal;
    workspaceDir?: string;
    agentRuntimeId?: string;
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
  },
  runtimePluginSelections: readonly AgentHarnessPluginSelection[],
  onAcquired: (release: () => Promise<void>) => void,
): Promise<PreparedSimpleCompletionResolverContext> {
  const config = params.cfg ?? {};
  const agentId = params.agentId ?? resolveDefaultAgentId(config);
  const agentDir = params.agentDir?.trim() || resolveAgentDir(config, agentId);
  const requestedWorkspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(config, agentId);
  const lease = await acquireAgentRunPreparedModelRuntime(
    {
      config,
      agentId,
      agentDir,
      workspaceDir: requestedWorkspaceDir,
      loadRuntimePlugins: true,
      runtimePluginSelections: runtimePluginSelections.map((selection) => ({
        ...selection,
        agentId,
      })),
    },
    {
      catalogMode: "static",
      abortSignal: params.signal,
      ...(params.pluginMetadataSnapshot
        ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
        : {}),
    },
  );
  onAcquired(() => lease[Symbol.asyncDispose]());
  return createPreparedSimpleCompletionResolverContext({
    preparedModelRuntime: lease.snapshot,
    workspaceDir: params.workspaceDir ?? lease.snapshot.workspaceDir ?? requestedWorkspaceDir,
    modelResolver: params.modelResolver,
    agentRuntimeId: params.agentRuntimeId,
  });
}

type AcquiredSimpleCompletionModel =
  | (Extract<PreparedSimpleCompletionModel, { model: Model }> & AsyncDisposable)
  | Extract<PreparedSimpleCompletionModel, { error: string }>;

/** Acquire the exact provider/model already selected by a finite internal caller. */
export async function acquireSimpleCompletionModel(
  params: Omit<Parameters<typeof prepareSimpleCompletionModel>[0], "preparedModelRuntime">,
): Promise<AcquiredSimpleCompletionModel> {
  return await acquirePreparedSimpleCompletionModel(
    params,
    [
      {
        provider: params.provider,
        modelId: params.modelId,
        ...(params.agentRuntimeId ? { runtime: params.agentRuntimeId } : {}),
      },
    ],
    (context) =>
      prepareSimpleCompletionModelCore(
        { ...params, agentDir: context.preparedModelRuntime.agentDir },
        context,
      ),
  );
}

type AcquiredSimpleCompletionModelForAgent =
  | (Extract<PreparedSimpleCompletionModelForAgent, { model: Model }> & AsyncDisposable)
  | Extract<PreparedSimpleCompletionModelForAgent, { error: string }>;

/** Keeps prepared facts in use until the internal completion owner releases its lease. */
export async function acquireSimpleCompletionModelForAgent(
  params: PrepareSimpleCompletionModelForAgentParams,
): Promise<AcquiredSimpleCompletionModelForAgent> {
  const selectionParams = {
    cfg: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    modelRef: params.modelRef,
    useUtilityModel: params.useUtilityModel,
  };
  return await acquireSimpleCompletionModelWithSelection(params, (manifestPlugins) =>
    resolveSimpleCompletionSelectionRequest({ ...selectionParams, manifestPlugins }),
  );
}

/** Captures metadata before the caller selects the model to materialize. */
export async function acquireSimpleCompletionModelWithSelection(
  params: Omit<
    PrepareSimpleCompletionModelForAgentParams,
    "agentId" | "modelRef" | "useUtilityModel" | "useAsyncModelResolution"
  > & { agentId?: string },
  resolveRequest: (manifestPlugins?: PluginMetadataSnapshot) => {
    selection: Omit<AgentSimpleCompletionSelection, "agentDir">;
    shorthandModelId?: string;
  } | null,
): Promise<AcquiredSimpleCompletionModelForAgent> {
  const agentId = params.agentId ?? resolveDefaultAgentId(params.cfg);
  const agentDir = params.agentDir?.trim() || resolveAgentDir(params.cfg, agentId);
  const tentativeRequest = resolveRequest();
  if (!tentativeRequest) {
    return { error: `No model configured for agent ${agentId}.` };
  }
  const tentativeSelection = tentativeRequest.selection;
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
  const pluginIdScope = createAgentRuntimeMetadataPluginIdScope({
    config: params.cfg,
    workspaceDir,
    selections: [
      {
        provider: tentativeSelection.provider,
        modelId: tentativeSelection.modelId,
        agentId,
      },
    ],
    ...(tentativeRequest.shorthandModelId
      ? { shorthandModelIds: [tentativeRequest.shorthandModelId] }
      : {}),
  });
  let metadataSnapshot = resolvePluginMetadataSnapshot({
    config: params.cfg,
    env: process.env,
    workspaceDir,
    pluginIdScope,
    allowWorkspaceScopedCurrent: true,
  });
  const resolveSelection = () => {
    const request = resolveRequest(metadataSnapshot);
    return request ? { ...request.selection, agentDir } : null;
  };
  let selection = resolveSelection();
  if (!selection) {
    return { error: `No model configured for agent ${agentId}.` };
  }
  const canonicalPluginIdScope = createAgentRuntimeMetadataPluginIdScope({
    config: params.cfg,
    workspaceDir,
    selections: [
      {
        provider: selection.provider,
        modelId: selection.modelId,
        agentId,
      },
    ],
    ...(tentativeRequest.shorthandModelId &&
    selection.provider === tentativeSelection.provider &&
    selection.modelId === tentativeSelection.modelId
      ? { shorthandModelIds: [tentativeRequest.shorthandModelId] }
      : {}),
  });
  if (canonicalPluginIdScope.key !== pluginIdScope.key) {
    metadataSnapshot = resolvePluginMetadataSnapshot({
      config: params.cfg,
      env: process.env,
      workspaceDir,
      pluginIdScope: canonicalPluginIdScope,
      allowWorkspaceScopedCurrent: true,
    });
    selection = resolveSelection();
    if (!selection) {
      return { error: `No model configured for agent ${agentId}.` };
    }
  }
  const acquired = await acquirePreparedSimpleCompletionModel(
    { ...params, agentId, agentDir, pluginMetadataSnapshot: metadataSnapshot },
    [{ provider: selection.provider, modelId: selection.modelId }],
    (context) =>
      prepareSimpleCompletionModelCore(
        {
          cfg: params.cfg,
          agentId: params.agentId,
          provider: selection.provider,
          modelId: selection.modelId,
          modelIdSource: "selected",
          agentDir: selection.agentDir,
          profileId: selection.profileId,
          preferredProfile: params.preferredProfile,
          allowMissingApiKeyModes: params.allowMissingApiKeyModes,
          ...(params.allowBundledStaticCatalogFallback !== undefined
            ? { allowBundledStaticCatalogFallback: params.allowBundledStaticCatalogFallback }
            : {}),
          skipAgentDiscovery: params.skipAgentDiscovery,
          bindAuthOwner: params.bindAuthOwner,
        },
        context,
      ),
  );
  return { ...acquired, selection };
}

async function acquirePreparedSimpleCompletionModel(
  params: Parameters<typeof acquirePreparedSimpleCompletionRuntime>[0],
  runtimePluginSelections: readonly AgentHarnessPluginSelection[],
  prepareModel: (
    context: PreparedSimpleCompletionResolverContext,
  ) => Promise<PreparedSimpleCompletionModel>,
): Promise<AcquiredSimpleCompletionModel> {
  let releaseRuntime: (() => Promise<void>) | undefined;
  let setupSettled = false;
  let callerReleased = true;
  let releaseCompletion: Promise<void> | undefined;
  const setupCompletion = createDeferredCore();
  const releaseWhenUnused = () => {
    if (setupSettled && callerReleased) {
      releaseCompletion ??= Promise.resolve().then(() => releaseRuntime?.());
    }
    return releaseCompletion;
  };
  return await runWithAsyncWorkResources(async (onAcquired, captureWorkContext) => {
    // Host work includes setup only; host close releases adopted model claims after drainage.
    onAcquired({
      release: () => {
        setupSettled = true;
        setupCompletion.resolve();
        return releaseWhenUnused();
      },
    });
    const context = await acquirePreparedSimpleCompletionRuntime(
      params,
      runtimePluginSelections,
      (release) => {
        releaseRuntime = release;
      },
    );
    const prepared = await withPluginRuntimeGenerationScope(context.preparedModelRuntime, () => {
      captureWorkContext();
      return prepareModel(context);
    });
    params.signal?.throwIfAborted();
    if ("error" in prepared) {
      return prepared;
    }
    callerReleased = false;
    return {
      ...prepared,
      async [Symbol.asyncDispose]() {
        callerReleased = true;
        // Caller disposal joins setup tails; setup drainage never waits for an unreleased caller.
        await setupCompletion.promise;
        await releaseWhenUnused();
      },
    };
  });
}

export { completeWithPreparedSimpleCompletionModel } from "./simple-completion-execution.js";
