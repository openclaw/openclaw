/**
 * Prepares one atomic model-route/auth tuple for embedded safeguard compaction.
 */
import { resolveModelProviderRouteOverridePresence } from "../../config/model-provider-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { prepareProviderRuntimeAuth } from "../../plugins/provider-runtime.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  applyAuthHeaderOverride,
  applyLocalNoAuthHeaderOverride,
  MissingProviderAuthError,
  type ResolvedProviderAuth,
} from "../model-auth.js";
import { canonicalizeProviderModelId } from "../provider-model-route.js";
import { applyPreparedRuntimeAuthToModel } from "../provider-request-config.js";
import {
  protectPreparedProviderRuntimeAuth,
  unwrapSecretSentinelsForProviderEgress,
} from "../provider-secret-egress.js";
import { materializePreparedRuntimeModel } from "../runtime-plan/materialize-model.js";
import {
  agentRuntimeAuthPlanMatchesTarget,
  prepareAgentRuntimeAuth,
  type PreparedAgentRuntimeAuthAttempt,
} from "../runtime-plan/prepare-auth.js";
import {
  resolvePreparedRuntimeAuthAttempts,
  resolvePreparedRuntimeModelAuth,
} from "../runtime-plan/resolve-auth.js";
import type { AgentRuntimeAuthPlan } from "../runtime-plan/types.js";
import type { ModelRegistry } from "../sessions/index.js";
import { resolveModelAsync } from "./model.js";

export type PreparedCompactionRuntimeAuth = {
  model: ProviderRuntimeModel;
  apiKeyInfo: ResolvedProviderAuth;
  authProfileId?: string;
  runtimeAuthPlan: AgentRuntimeAuthPlan;
  modelRegistry: ModelRegistry;
  hasRuntimeAuthExchange: boolean;
};

/** Resolve and bind model metadata, physical route, profile, and key as one tuple. */
export async function prepareCompactionRuntimeAuth(params: {
  provider: string;
  runtimeProvider?: string;
  modelId: string;
  config?: OpenClawConfig;
  authProfileStore?: AuthProfileStore;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  runtimeAuthPlan?: AgentRuntimeAuthPlan;
  agentDir?: string;
  workspaceDir?: string;
}): Promise<PreparedCompactionRuntimeAuth> {
  // Resolve a target-owned model/registry bundle instead of mutating the active
  // attempt's auth storage when an override uses another profile or provider.
  const initial = await resolveModelAsync(
    params.runtimeProvider ?? params.provider,
    params.modelId,
    params.agentDir,
    params.config,
    {
      skipAgentDiscovery: true,
      allowBundledStaticCatalogFallback: true,
      preferBundledStaticCatalogTransport: true,
      workspaceDir: params.workspaceDir,
    },
  );
  if (!initial.model) {
    throw new Error(
      initial.error ??
        `Unable to resolve ${params.provider}/${params.modelId} for safeguard compaction.`,
    );
  }
  const { authStorage, modelRegistry } = initial;
  const initialModel = initial.model as ProviderRuntimeModel;
  const authProfileStore = params.authProfileStore ?? { version: 1, profiles: {} };
  const reusableRuntimeAuthPlan =
    params.runtimeAuthPlan &&
    agentRuntimeAuthPlanMatchesTarget(params.runtimeAuthPlan, {
      provider: params.provider,
      modelId: params.modelId,
    })
      ? params.runtimeAuthPlan
      : undefined;
  const runtimeAuthPreparation = reusableRuntimeAuthPlan
    ? {
        plan: reusableRuntimeAuthPlan,
        attempts: [
          { kind: "implicit" as const, plan: reusableRuntimeAuthPlan },
        ] satisfies readonly PreparedAgentRuntimeAuthAttempt[],
      }
    : prepareAgentRuntimeAuth({
        provider: params.provider,
        modelId: params.modelId,
        modelApi: initialModel.api,
        modelBaseUrl: initialModel.baseUrl,
        requestTransportOverrides: resolveModelProviderRouteOverridePresence({
          provider: params.provider,
          modelId: params.modelId,
          config: params.config,
          canonicalizeModelId: (modelId) => canonicalizeProviderModelId(params.provider, modelId),
        }),
        config: params.config,
        env: process.env,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        authProfileStore,
        sessionAuthProfileId: params.authProfileId,
        sessionAuthProfileSource: params.authProfileIdSource,
        // Safeguard compaction runs inside the OpenClaw extension, irrespective
        // of the active session model's original runtime selection.
        harnessId: "openclaw",
        harnessRuntime: "openclaw",
      });

  const materializeModel = async (materializeParams: {
    plan: AgentRuntimeAuthPlan;
    model: ProviderRuntimeModel;
    forceResolve?: boolean;
  }): Promise<ProviderRuntimeModel> =>
    (await materializePreparedRuntimeModel<ProviderRuntimeModel>({
      plan: materializeParams.plan,
      provider: params.provider,
      modelId: params.modelId,
      config: params.config,
      model: materializeParams.model,
      forceResolve: materializeParams.forceResolve,
      resolveModel: ({ config, authProfileId, authProfileMode }) =>
        resolveModelAsync(
          params.runtimeProvider ?? params.provider,
          params.modelId,
          params.agentDir,
          config,
          {
            authStorage,
            modelRegistry,
            skipAgentDiscovery: true,
            allowBundledStaticCatalogFallback: true,
            preferBundledStaticCatalogTransport: true,
            workspaceDir: params.workspaceDir,
            authProfileId,
            authProfileMode,
          },
        ),
    })) ?? materializeParams.model;

  const resolved = await resolvePreparedRuntimeAuthAttempts({
    attempts: runtimeAuthPreparation.attempts,
    store: authProfileStore,
    modelId: params.modelId,
    model: initialModel,
    materializeModel,
    resolveAuth: async ({ attempt, model }) =>
      await resolvePreparedRuntimeModelAuth({
        plan: attempt.plan,
        model,
        cfg: params.config,
        store: authProfileStore,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        ...(attempt.allowAuthProfileFallback !== undefined
          ? { allowAuthProfileFallback: attempt.allowAuthProfileFallback }
          : {}),
        secretSentinels: true,
      }),
    errorMessage: `Prepared safeguard compaction auth attempts could not be resolved for ${params.provider}/${params.modelId}.`,
  });

  let model = resolved.model;
  const apiKeyInfo = resolved.auth;
  const runtimePolicy =
    resolved.plan.modelRoute?.runtimePolicy ?? resolved.plan.deferredRouteSupport?.runtimePolicy;
  if (
    runtimePolicy &&
    !runtimePolicy.compatibleIds.some((id) => id.trim().toLowerCase() === "openclaw")
  ) {
    throw new Error(
      `Prepared safeguard compaction route for ${params.provider}/${params.modelId} is not compatible with the OpenClaw runtime.`,
    );
  }
  if (!apiKeyInfo.apiKey) {
    if (apiKeyInfo.mode !== "aws-sdk") {
      throw new MissingProviderAuthError(model.provider, apiKeyInfo);
    }
    model = applyAuthHeaderOverride(
      applyLocalNoAuthHeaderOverride(model, apiKeyInfo),
      apiKeyInfo,
      params.config,
    );
    return {
      model,
      apiKeyInfo,
      authProfileId: apiKeyInfo.profileId ?? params.authProfileId,
      runtimeAuthPlan: resolved.plan,
      modelRegistry,
      hasRuntimeAuthExchange: false,
    };
  }

  const preparedAuth = protectPreparedProviderRuntimeAuth({
    provider: model.provider,
    preparedAuth: await prepareProviderRuntimeAuth({
      provider: model.provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: process.env,
      context: {
        config: params.config,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        env: process.env,
        provider: model.provider,
        modelId: params.modelId,
        model,
        apiKey: unwrapSecretSentinelsForProviderEgress(
          apiKeyInfo.apiKey,
          "provider runtime auth exchange",
        ),
        authMode: apiKeyInfo.mode,
        profileId: apiKeyInfo.profileId,
      },
    }),
  });
  model = applyPreparedRuntimeAuthToModel(model, preparedAuth);
  const runtimeApiKey = preparedAuth?.apiKey ?? apiKeyInfo.apiKey;
  if (!runtimeApiKey) {
    throw new Error(`Provider "${model.provider}" runtime auth returned no apiKey.`);
  }
  authStorage.setRuntimeApiKey(model.provider, runtimeApiKey);
  model = applyAuthHeaderOverride(
    applyLocalNoAuthHeaderOverride(model, apiKeyInfo),
    // Provider runtime exchanges replace the profile credential stored above.
    // Avoid copying the pre-exchange bearer into model headers.
    preparedAuth?.apiKey ? null : apiKeyInfo,
    params.config,
  );

  return {
    model,
    apiKeyInfo,
    authProfileId: apiKeyInfo.profileId ?? params.authProfileId,
    runtimeAuthPlan: resolved.plan,
    modelRegistry,
    hasRuntimeAuthExchange: Boolean(preparedAuth?.apiKey),
  };
}
