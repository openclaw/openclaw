import { prepareModelForSimpleCompletion } from "@openclaw/ai/transports";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { bindModelLlmRuntime } from "../llm/model-runtime-binding.js";
import type { Model } from "../llm/types.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  attachModelProviderRuntimePluginHandle,
  resolveProviderRuntimePluginHandle,
} from "../plugins/provider-hook-runtime.js";
import { prepareProviderRuntimeAuth } from "../plugins/provider-runtime.runtime.js";
import {
  runOutsidePluginRuntimeGenerationScope,
  withPluginRuntimeGenerationScope,
} from "../plugins/runtime/generation-scope.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  resolveAgentDir,
  resolveNativeModelPrimary,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "./agent-scope.js";
import { ensureAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { reconcileAuthProfileQuotaBlocks } from "./auth-profiles/usage.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintResolvedProviderAuth,
} from "./execution-auth-binding.js";
import { resolveProviderModelAuthPolicy } from "./model-auth-policy.js";
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
  useUtilityModel?: boolean | "required";
  manifestPlugins?:
    | PluginMetadataSnapshot["plugins"]
    | Pick<PluginMetadataSnapshot, "plugins" | "owners">;
};

type SimpleCompletionSelectionRequest = {
  selection: AgentSimpleCompletionSelection;
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
  // optional routing treats an empty utilityModel as "use the primary" (disabled).
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
    (params.useUtilityModel === "required"
      ? undefined
      : resolveNativeModelPrimary(params.cfg, params.agentId));
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
  if (params.useUtilityModel === "required" && !resolved) {
    return null;
  }
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
  /** Internal stream callers own provider transport construction and embedded policy. */
  transport?: "simple-completion" | "provider-stream";
};

/** Prepares a model within the exact generation already held by its caller. */
export async function prepareSimpleCompletionModel(
  params: PrepareSimpleCompletionModelParams & {
    preparedModelRuntime: PreparedModelRuntimeSnapshot;
  },
  assertCurrent?: () => void,
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
      assertCurrent,
    ),
  );
  params.signal?.throwIfAborted();
  return prepared;
}

async function prepareSimpleCompletionModelCore(
  params: PrepareSimpleCompletionModelParams,
  context: PreparedSimpleCompletionResolverContext,
  assertCurrent?: () => void,
): Promise<PreparedSimpleCompletionModel> {
  const { modelResolver, workspaceDir } = context;
  const resolved = await modelResolver(
    params.provider,
    params.modelId,
    params.agentDir,
    params.cfg,
    {
      abortSignal: params.signal,
      assertCurrent,
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
  assertCurrent?.();
  params.signal?.throwIfAborted();
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

    const authParams = {
      provider: initialModel.provider,
      modelId: initialModel.id,
      modelApi: initialModel.api,
      modelBaseUrl: initialModel.baseUrl,
      config: params.cfg,
      agentId: params.agentId,
      agentDir: params.agentDir,
      workspaceDir,
      authProfileStore: authStore,
      metadataSnapshot: context.preparedModelRuntime.metadataSnapshot,
      sessionAuthProfileId: params.profileId ?? params.preferredProfile,
      sessionAuthProfileSource: params.profileId ? "user" : "auto",
      ...(params.bindAuthOwner && params.profileId ? { allowAuthProfileFallback: false } : {}),
    } satisfies Parameters<typeof prepareAgentRuntimeAuth>[0];
    await reconcileAuthProfileQuotaBlocks(authParams);
    assertCurrent?.();
    params.signal?.throwIfAborted();

    const primaryModel = params.cfg
      ? resolveDefaultModelForAgent({
          cfg: params.cfg,
          agentId: params.agentId,
          allowManifestNormalization: false,
          allowPluginNormalization: false,
        })
      : undefined;
    const resolveProfileAuthMode = (profileId: string) => authStore?.profiles[profileId]?.type;
    const resolveProfileAuthFlow = (profileId: string) => {
      const credential = authStore?.profiles[profileId];
      return credential?.type === "oauth" ? credential.authFlow : undefined;
    };
    const routeIntent = params.agentRuntimeId
      ? { runtimeId: params.agentRuntimeId, source: "explicit" as const }
      : resolveModelRouteIntent({
          config: params.cfg,
          provider: initialModel.provider,
          modelId: initialModel.id,
          agentId: params.agentId,
          primaryModel,
          resolveProfileAuthMode,
          resolveProfileAuthFlow,
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
      resolveProfileAuthFlow,
      pinnedAuthRequirement: params.profileId
        ? (resolveProviderModelAuthPolicy({
            provider: initialModel.provider,
            mode: resolveProfileAuthMode(params.profileId),
            authFlow: resolveProfileAuthFlow(params.profileId),
          }).authRequirement ?? undefined)
        : undefined,
      env: process.env,
    });
    const preparedAuth =
      routeResolution?.kind === "routes"
        ? prepareAgentRuntimeAuth({ ...authParams, routeIntent })
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
            abortSignal: params.signal,
            assertCurrent,
            modelIdSource: "selected",
            ...(params.agentId ? { agentId: params.agentId } : {}),
            skipAgentDiscovery: true,
            allowBundledStaticCatalogFallback: true,
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
  await import("./ai-transport-runtime-host.js");
  assertCurrent?.();
  params.signal?.throwIfAborted();
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
  // Direct completions retain this generation's transport. Embedded stream callers
  // construct their own transport and must not run direct-completion factories.
  const completionTransport =
    params.transport === "provider-stream"
      ? undefined
      : attachModelProviderRuntimePluginHandle(
          prepareModelForSimpleCompletion({
            apiRegistry: modelRuntime.apiRegistry,
            model: preparedModel,
            cfg: params.cfg,
            auth: { mode: resolvedAuth.mode, authFlow: resolvedAuth.authFlow },
            agentId: params.agentId,
          }),
          providerRuntimeHandle,
        );

  return {
    model: bindModelLlmRuntime(preparedModel, modelRuntime.llmRuntime, completionTransport),
    auth: resolvedAuth,
    ...(sourceAuthFingerprint ? { sourceAuthFingerprint } : {}),
  };
}

type AcquiredSimpleCompletionModelForAgent =
  | (Extract<PreparedSimpleCompletionModelForAgent, { model: Model }> & AsyncDisposable)
  | Extract<PreparedSimpleCompletionModelForAgent, { error: string }>;

/** Keeps prepared facts in use until the internal completion owner releases its lease. */
export async function acquireSimpleCompletionModelForAgent(
  params: PrepareSimpleCompletionModelForAgentParams,
  assertSelection?: (selection: AgentSimpleCompletionSelection, config: OpenClawConfig) => void,
): Promise<AcquiredSimpleCompletionModelForAgent> {
  return await acquireSimpleCompletionModelWithSelection(params, (manifestPlugins, cfg) => {
    const request = resolveSimpleCompletionSelectionRequest({ ...params, cfg, manifestPlugins });
    if (request) {
      assertSelection?.(request.selection, cfg);
    }
    return request;
  });
}

/** Selects new work after config admission; existing prepared completions keep their own lease. */
export async function acquireSimpleCompletionModelWithSelection(
  params: Omit<
    PrepareSimpleCompletionModelForAgentParams,
    "agentId" | "modelRef" | "useUtilityModel" | "useAsyncModelResolution"
  > & { agentId?: string },
  resolveRequest: (
    manifestPlugins: PluginMetadataSnapshot,
    config: OpenClawConfig,
  ) => {
    selection: Omit<AgentSimpleCompletionSelection, "agentDir">;
  } | null,
): Promise<AcquiredSimpleCompletionModelForAgent> {
  const agentId = params.agentId ?? resolveDefaultAgentId(params.cfg);
  const agentDir = params.agentDir?.trim() || resolveAgentDir(params.cfg, agentId);
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
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
  // This is a new admission, even if a retained callback restores a retired generation.
  // Only generation selection changes: requester authority, abort and drainage remain attached.
  return await runOutsidePluginRuntimeGenerationScope(() =>
    runWithAsyncWorkResources(async (onAcquired, captureWorkContext) => {
      onAcquired({
        release: () => {
          setupSettled = true;
          setupCompletion.resolve();
          return releaseWhenUnused();
        },
      });
      const admitted: {
        request?: {
          selection: Omit<AgentSimpleCompletionSelection, "agentDir">;
          config: OpenClawConfig;
        };
      } = {};
      const lease = await acquireAgentRunPreparedModelRuntime(
        { config: params.cfg, agentId, agentDir, workspaceDir, loadRuntimePlugins: true },
        {
          catalogMode: "static",
          abortSignal: params.signal,
          deriveRuntimePluginSelections: ({ config, metadataSnapshot }) => {
            // The lease owner selects metadata after replacement waits. The outer fresh
            // scope also removes predecessor hooks, while current provider normalization
            // keeps its existing contract. Selection is synchronous with these facts.
            const request = resolveRequest(metadataSnapshot, config);
            admitted.request = request ? { selection: request.selection, config } : undefined;
            return request
              ? [
                  {
                    provider: request.selection.provider,
                    modelId: request.selection.modelId,
                    agentId,
                  },
                ]
              : [];
          },
        },
      );
      releaseRuntime = () => lease[Symbol.asyncDispose]();
      if (!admitted.request) {
        return { error: "No model configured for agent " + agentId + "." };
      }
      const { config, selection: admittedSelection } = admitted.request;
      const selection = { ...admittedSelection, agentDir: lease.snapshot.agentDir };
      const context = createPreparedSimpleCompletionResolverContext({
        preparedModelRuntime: lease.snapshot,
        workspaceDir: lease.snapshot.workspaceDir ?? workspaceDir,
        modelResolver: params.modelResolver,
      });
      const prepared = await withPluginRuntimeGenerationScope(lease.snapshot, () => {
        captureWorkContext();
        return prepareSimpleCompletionModelCore(
          {
            ...params,
            cfg: config,
            provider: selection.provider,
            modelId: selection.modelId,
            modelIdSource: "selected",
            agentDir: selection.agentDir,
            profileId: selection.profileId,
          },
          context,
        );
      });
      params.signal?.throwIfAborted();
      if ("error" in prepared) {
        return { ...prepared, selection };
      }
      callerReleased = false;
      return {
        ...prepared,
        selection,
        async [Symbol.asyncDispose]() {
          callerReleased = true;
          await setupCompletion.promise;
          await releaseWhenUnused();
        },
      };
    }),
  );
}

export { completeWithPreparedSimpleCompletionModel } from "./simple-completion-execution.js";
