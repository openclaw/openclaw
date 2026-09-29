import type { SessionEntry as StoredSessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import { resolveExternalCliAuthOverlayScopeFromSelection } from "./auth-profiles/external-cli-auth-selection.js";
import { resolveSessionAuthSelection } from "./auth-profiles/session-override.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { reconcileAuthProfileQuotaBlocks } from "./auth-profiles/usage.js";
import {
  createEmptyAgentDiscoveryStores,
  resolveModelAsync,
} from "./embedded-agent-runner/model.js";
import type { AgentHarness } from "./harness/types.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
} from "./model-auth.js";
import { isOpenAIProvider } from "./openai-routing.js";
import type {
  PreparedModelRuntimeSnapshot,
  PreparedModelRuntimeStores,
} from "./prepared-model-runtime.js";
import { materializePreparedRuntimeModel } from "./runtime-plan/materialize-model.js";
import { prepareAgentRuntimeAuth } from "./runtime-plan/prepare-auth.js";
import {
  resolvePreparedRuntimeAuthAttempts,
  resolvePreparedRuntimeModelAuth,
} from "./runtime-plan/resolve-auth.js";
import type { AgentRuntimeAuthPlan } from "./runtime-plan/types.js";

type BtwRuntimeAuthPreparation = ReturnType<typeof prepareAgentRuntimeAuth>;

type BtwRuntimeModelMaterialization = {
  abortSignal?: AbortSignal;
  provider: string;
  modelId: string;
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
  authStorage: PreparedModelRuntimeStores["authStorage"];
  modelRegistry: PreparedModelRuntimeStores["modelRegistry"];
};

export async function resolveBtwRuntimeModel(params: {
  abortSignal?: AbortSignal;
  provider: string;
  model: string;
  agentId: string;
  sessionEntry?: StoredSessionEntry;
  sessionStore?: Record<string, StoredSessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isNewSession: boolean;
  harnessId?: string;
  harnessAuthBootstrap?: AgentHarness["authBootstrap"];
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
}): Promise<{
  model: Model;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  authProfileStore: AuthProfileStore;
  runtimeAuthPreparation: BtwRuntimeAuthPreparation;
  authStorage: PreparedModelRuntimeStores["authStorage"];
  modelRegistry: PreparedModelRuntimeStores["modelRegistry"];
}> {
  const preparedModelRuntime = params.preparedModelRuntime;
  const { config: cfg, agentDir, workspaceDir } = preparedModelRuntime;
  const { authStorage, modelRegistry } =
    params.harnessAuthBootstrap === "plugin"
      ? createEmptyAgentDiscoveryStores()
      : preparedModelRuntime.createStores();
  const resolution = await resolveModelAsync(params.provider, params.model, agentDir, cfg, {
    abortSignal: params.abortSignal,
    authStorage,
    modelRegistry,
    preparedModelRuntime,
    workspaceDir,
    skipAgentDiscovery: true,
    allowBundledStaticCatalogFallback: true,
    harnessAuthBootstrap: params.harnessAuthBootstrap,
    preferBundledStaticCatalogTransport: Boolean(
      params.harnessId && params.harnessId !== "openclaw",
    ),
  });
  let model = resolution.model;
  if (!model) {
    throw new Error(resolution.error ?? `Unknown model: ${params.provider}/${params.model}`);
  }
  const runtimeProvider = model.provider;
  const runtimeModelId = model.id;

  if (params.harnessAuthBootstrap === "plugin") {
    const authProfileStore: AuthProfileStore = { version: 1, profiles: {} };
    return {
      model,
      authProfileStore,
      runtimeAuthPreparation: prepareAgentRuntimeAuth({
        provider: runtimeProvider,
        modelId: runtimeModelId,
        modelApi: model.api,
        modelBaseUrl: model.baseUrl,
        config: cfg,
        agentId: params.agentId,
        agentDir,
        workspaceDir,
        authProfileStore,
        harnessId: params.harnessId,
        harnessRuntime: params.harnessId,
        harnessAuthBootstrap: params.harnessAuthBootstrap,
      }),
      authStorage,
      modelRegistry,
    };
  }

  const authSelection = await resolveSessionAuthSelection({
    cfg,
    provider: runtimeProvider,
    modelId: runtimeModelId,
    agentId: params.agentId,
    harnessRuntime: params.harnessId,
    agentDir,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    isNewSession: params.isNewSession,
  });
  const authProfileId = authSelection?.profileId;
  const authProfileIdSource = authSelection?.source;
  const authProfileStoreSelection = resolveBtwAuthProfileStore({
    cfg,
    provider: runtimeProvider,
    modelId: runtimeModelId,
    agentId: params.agentId,
    agentDir,
    workspaceDir,
    authProfileId,
    authProfileIdSource,
  });
  const effectiveAuthProfileId =
    authProfileStoreSelection.ignoreAutoPreferredProfile && authProfileIdSource !== "user"
      ? undefined
      : authProfileId;
  const authParams = {
    provider: runtimeProvider,
    modelId: runtimeModelId,
    modelApi: model.api,
    modelBaseUrl: model.baseUrl,
    config: cfg,
    agentId: params.agentId,
    agentDir,
    env: process.env,
    workspaceDir,
    authProfileStore: authProfileStoreSelection.store,
    sessionAuthProfileId: effectiveAuthProfileId,
    sessionAuthProfileSource: authProfileIdSource,
    harnessId: params.harnessId,
    harnessRuntime: params.harnessId,
    harnessAuthBootstrap: params.harnessAuthBootstrap,
  } satisfies Parameters<typeof prepareAgentRuntimeAuth>[0];
  await reconcileAuthProfileQuotaBlocks(authParams);
  const runtimeAuthPreparation = prepareAgentRuntimeAuth(authParams);
  model = await materializeBtwRuntimeModel({
    abortSignal: params.abortSignal,
    provider: runtimeProvider,
    modelId: runtimeModelId,
    preparedModelRuntime,
    authStorage,
    modelRegistry,
    plan: runtimeAuthPreparation.plan,
    model,
  });
  return {
    model,
    authProfileId: runtimeAuthPreparation.plan.forwardedAuthProfileId,
    authProfileIdSource: runtimeAuthPreparation.plan.forwardedAuthProfileSource,
    authProfileStore: authProfileStoreSelection.store,
    runtimeAuthPreparation,
    authStorage,
    modelRegistry,
  };
}

export async function resolveBtwPreparedRuntimeAuth(
  params: BtwRuntimeModelMaterialization & {
    preparation: BtwRuntimeAuthPreparation;
    model: Model;
    authProfileStore: AuthProfileStore;
  },
) {
  const { agentDir, config: cfg, workspaceDir } = params.preparedModelRuntime;
  return resolvePreparedRuntimeAuthAttempts({
    attempts: params.preparation.attempts,
    store: params.authProfileStore,
    modelId: params.modelId,
    model: params.model,
    materializeModel: ({ plan, model, forceResolve }) =>
      materializeBtwRuntimeModel({ ...params, plan, model, forceResolve }),
    resolveAuth: async ({ attempt, model }) =>
      await resolvePreparedRuntimeModelAuth({
        plan: attempt.plan,
        model,
        cfg,
        store: params.authProfileStore,
        agentDir,
        workspaceDir,
        ...(attempt.allowAuthProfileFallback !== undefined
          ? { allowAuthProfileFallback: attempt.allowAuthProfileFallback }
          : {}),
        secretSentinels: true,
      }),
    errorMessage: "BTW prepared auth attempts could not be resolved.",
  });
}

// Planning and immediate resolution share one scoped snapshot so provider
// bindings and cooldown decisions cannot diverge inside a side question.
export function resolveBtwAuthProfileStore(params: {
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
  agentId?: string;
  agentDir: string;
  workspaceDir?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
}): {
  store: AuthProfileStore;
  ignoreAutoPreferredProfile: boolean;
} {
  if (isOpenAIProvider(params.provider)) {
    return {
      store: ensureAuthProfileStore(params.agentDir, {
        profileId: params.authProfileId,
        externalCliProviderIds: ["openai"],
        allowKeychainPrompt: false,
      }),
      ignoreAutoPreferredProfile: false,
    };
  }

  const userPinnedAuthProfileId =
    params.authProfileIdSource === "user" ? params.authProfileId : undefined;
  let externalCliAuthScope = resolveExternalCliAuthOverlayScopeFromSelection({
    provider: params.provider,
    cfg: params.cfg,
    agentId: params.agentId,
    modelId: params.modelId,
    workspaceDir: params.workspaceDir,
    userPinnedAuthProfileId,
  });
  let store: AuthProfileStore;
  if (externalCliAuthScope.providerIds) {
    store = ensureAuthProfileStore(params.agentDir, {
      profileId: params.authProfileId,
      externalCliProviderIds: externalCliAuthScope.providerIds,
      allowKeychainPrompt: false,
    });
  } else {
    store = ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
      profileId: params.authProfileId,
      allowKeychainPrompt: false,
    });
    externalCliAuthScope = resolveExternalCliAuthOverlayScopeFromSelection({
      provider: params.provider,
      cfg: params.cfg,
      agentId: params.agentId,
      modelId: params.modelId,
      workspaceDir: params.workspaceDir,
      store,
      userPinnedAuthProfileId,
    });
    if (externalCliAuthScope.providerIds) {
      store = ensureAuthProfileStore(params.agentDir, {
        profileId: params.authProfileId,
        externalCliProviderIds: externalCliAuthScope.providerIds,
        allowKeychainPrompt: false,
      });
    }
  }
  return {
    store,
    ignoreAutoPreferredProfile: externalCliAuthScope.ignoreAutoPreferredProfile,
  };
}

async function materializeBtwRuntimeModel(
  params: BtwRuntimeModelMaterialization & {
    plan: AgentRuntimeAuthPlan;
    model: Model;
    forceResolve?: boolean;
  },
): Promise<Model> {
  const { agentDir, config: cfg, workspaceDir } = params.preparedModelRuntime;
  return (
    (await materializePreparedRuntimeModel({
      plan: params.plan,
      provider: params.provider,
      modelId: params.modelId,
      config: cfg,
      workspaceDir,
      metadataSnapshot: params.preparedModelRuntime.metadataSnapshot,
      model: params.model,
      ...(params.forceResolve !== undefined ? { forceResolve: params.forceResolve } : {}),
      resolveModel: ({ config, authProfileId, authProfileMode }) =>
        resolveModelAsync(params.provider, params.modelId, agentDir, config, {
          abortSignal: params.abortSignal,
          modelIdSource: "selected",
          authStorage: params.authStorage,
          modelRegistry: params.modelRegistry,
          skipAgentDiscovery: true,
          allowBundledStaticCatalogFallback: true,
          preparedModelRuntime: params.preparedModelRuntime,
          workspaceDir,
          authProfileId,
          authProfileMode,
        }),
    })) ?? params.model
  );
}
