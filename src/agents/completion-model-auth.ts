// Selects provider auth, and the model route that auth owns, before a completion binds its transport.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { ensureAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { reconcileAuthProfileQuotaBlocks } from "./auth-profiles/usage.js";
import { resolveProviderModelAuthPolicy } from "./model-auth-policy.js";
import { getApiKeyForModelCore, type ResolvedProviderAuth } from "./model-auth.js";
import { resolveModelRouteIntent } from "./model-runtime-policy.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import { resolveOpenAIModelRoutes } from "./openai-model-routes.js";
import { materializePreparedRuntimeModel } from "./runtime-plan/materialize-model.js";
import { prepareAgentRuntimeAuth } from "./runtime-plan/prepare-auth.js";
import {
  resolvePreparedRuntimeAuthAttempts,
  resolvePreparedRuntimeModelAuth,
} from "./runtime-plan/resolve-auth.js";
import type { AgentRuntimeAuthPlan } from "./runtime-plan/types.js";
import type { SimpleCompletionModelResolver } from "./simple-completion-scope.js";

type CompletionModelAuth = {
  auth: ResolvedProviderAuth;
  /** Equals the input model unless the selected credential owns a different route. */
  model: Model;
  /** Whether a credential-owned route replaced the input model. */
  routed: boolean;
  authStore?: AuthProfileStore;
};

/**
 * A model with several credential routes (OpenAI Platform and ChatGPT) cannot be
 * authenticated against its first physical route. Resolve auth first, then take
 * the route that credential owns. Other providers authenticate the input model.
 */
export async function resolveCompletionModelAuth(params: {
  model: Model;
  cfg: OpenClawConfig | undefined;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  profileId?: string;
  preferredProfile?: string;
  /** Caller-loaded store; otherwise OpenAI route selection reads the agent store. */
  authStore?: AuthProfileStore;
  bindAuthOwner?: boolean;
  agentRuntimeId?: string;
  metadataSnapshot: PluginMetadataSnapshot;
  modelResolver: SimpleCompletionModelResolver;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}): Promise<CompletionModelAuth> {
  const { model: initialModel } = params;
  const authStore =
    params.authStore ??
    (params.bindAuthOwner || initialModel.provider === "openai"
      ? ensureAuthProfileStore(params.agentDir, {
          readOnly: true,
          allowKeychainPrompt: false,
          config: params.cfg,
          profileId: params.profileId,
        })
      : undefined);

  const authParams = {
    provider: initialModel.provider,
    modelId: initialModel.id,
    modelApi: initialModel.api,
    modelBaseUrl: initialModel.baseUrl,
    config: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    authProfileStore: authStore,
    metadataSnapshot: params.metadataSnapshot,
    sessionAuthProfileId: params.profileId ?? params.preferredProfile,
    sessionAuthProfileSource: params.profileId ? "user" : "auto",
    ...(params.bindAuthOwner && params.profileId ? { allowAuthProfileFallback: false } : {}),
  } satisfies Parameters<typeof prepareAgentRuntimeAuth>[0];
  await reconcileAuthProfileQuotaBlocks(authParams);
  params.assertCurrent?.();
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
  if (!preparedAuth || !authStore) {
    return {
      auth: await getApiKeyForModelCore({
        model: initialModel,
        cfg: params.cfg,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        profileId: params.profileId,
        preferredProfile: params.preferredProfile,
        ...(authStore ? { store: authStore } : {}),
        ...(params.bindAuthOwner && params.profileId ? { lockedProfile: true } : {}),
        secretSentinels: true,
      }),
      model: initialModel,
      routed: false,
      ...(authStore ? { authStore } : {}),
    };
  }

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
      workspaceDir: params.workspaceDir,
      metadataSnapshot: params.metadataSnapshot,
      model,
      forceResolve,
      resolveModel: ({ config, authProfileId, authProfileMode }) =>
        params.modelResolver(initialModel.provider, initialModel.id, params.agentDir, config, {
          abortSignal: params.signal,
          assertCurrent: params.assertCurrent,
          modelIdSource: "selected",
          ...(params.agentId ? { agentId: params.agentId } : {}),
          skipAgentDiscovery: true,
          allowBundledStaticCatalogFallback: true,
          authProfileId,
          authProfileMode,
        }),
    })) ?? model;
  const resolved = await resolvePreparedRuntimeAuthAttempts({
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
        workspaceDir: params.workspaceDir,
        store: authStore,
        allowAuthProfileFallback: attempt.allowAuthProfileFallback,
        secretSentinels: true,
      }),
    errorMessage: "Simple completion auth attempts could not be resolved.",
  });
  return { auth: resolved.auth, model: resolved.model, routed: true, authStore };
}
