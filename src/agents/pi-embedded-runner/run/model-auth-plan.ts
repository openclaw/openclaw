import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";
import { resolveProviderAuthProfileId } from "../../../plugins/provider-runtime.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import { resolveAuthProfileEligibility, resolveAuthProfileOrder } from "../../auth-profiles.js";
import { FailoverError } from "../../failover-error.js";
import { selectAgentHarness } from "../../harness/selection.js";
import type { AgentHarness } from "../../harness/types.js";
import { ensureAuthProfileStore, shouldPreferExplicitConfigApiKeyAuth } from "../../model-auth.js";
import { ensureOpenClawModelsJson } from "../../models-config.js";
import { resolveProviderIdForAuth } from "../../provider-auth-aliases.js";
import { buildAgentRuntimeAuthPlan } from "../../runtime-plan/auth.js";
import { resolveModelAsync } from "../model.js";
import { createEmptyAuthProfileStore } from "./run-orchestration-helpers.js";
import { resolveEffectiveRuntimeModel } from "./setup.js";

type ModelResolution = Awaited<ReturnType<typeof resolveModelAsync>>;

type ModelAuthPlanDependencies = {
  buildAgentRuntimeAuthPlan?: typeof buildAgentRuntimeAuthPlan;
  createEmptyAuthProfileStore?: typeof createEmptyAuthProfileStore;
  ensureAuthProfileStore?: typeof ensureAuthProfileStore;
  ensureOpenClawModelsJson?: typeof ensureOpenClawModelsJson;
  resolveAuthProfileEligibility?: typeof resolveAuthProfileEligibility;
  resolveAuthProfileOrder?: typeof resolveAuthProfileOrder;
  resolveEffectiveRuntimeModel?: typeof resolveEffectiveRuntimeModel;
  resolveModelAsync?: typeof resolveModelAsync;
  resolveProviderAuthProfileId?: typeof resolveProviderAuthProfileId;
  resolveProviderIdForAuth?: typeof resolveProviderIdForAuth;
  selectAgentHarness?: typeof selectAgentHarness;
  shouldPreferExplicitConfigApiKeyAuth?: typeof shouldPreferExplicitConfigApiKeyAuth;
};

export type EmbeddedRunModelAuthPlan = {
  agentHarness: AgentHarness;
  authStorage: AuthStorage;
  authStore: AuthProfileStore;
  ctxInfo: ReturnType<typeof resolveEffectiveRuntimeModel>["ctxInfo"];
  effectiveModel: ProviderRuntimeModel;
  lockedProfileId?: string;
  model: ProviderRuntimeModel;
  modelRegistry: ModelRegistry;
  pluginHarnessOwnsTransport: boolean;
  preferredProfileId?: string;
  profileCandidates: Array<string | undefined>;
  runtimeModel: ProviderRuntimeModel;
};

export async function buildEmbeddedRunModelAuthPlan(params: {
  agentDir: string;
  agentHarnessId?: string;
  agentId?: string;
  authProfileId?: string;
  authProfileIdSource?: string;
  config?: OpenClawConfig;
  modelId: string;
  provider: string;
  sessionKey?: string;
  workspaceDir: string;
  deps?: ModelAuthPlanDependencies;
}): Promise<EmbeddedRunModelAuthPlan> {
  const deps = resolveModelAuthPlanDependencies(params.deps);

  const agentHarness = deps.selectAgentHarness({
    provider: params.provider,
    modelId: params.modelId,
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    agentHarnessId: params.agentHarnessId,
  });
  const pluginHarnessOwnsTransport = agentHarness.id !== "pi";

  const modelResolution = await resolveEmbeddedRunModel({
    agentDir: params.agentDir,
    config: params.config,
    modelId: params.modelId,
    pluginHarnessOwnsTransport,
    provider: params.provider,
    deps,
  });
  const { model, error, authStorage, modelRegistry } = modelResolution;
  if (!model) {
    throw new FailoverError(error ?? `Unknown model: ${params.provider}/${params.modelId}`, {
      reason: "model_not_found",
      provider: params.provider,
      model: params.modelId,
    });
  }

  const runtimeModel = model as ProviderRuntimeModel;
  const resolvedRuntimeModel = deps.resolveEffectiveRuntimeModel({
    cfg: params.config,
    provider: params.provider,
    modelId: params.modelId,
    runtimeModel,
  });
  const effectiveModel = resolvedRuntimeModel.effectiveModel as ProviderRuntimeModel;

  const authStore = pluginHarnessOwnsTransport
    ? deps.createEmptyAuthProfileStore()
    : deps.ensureAuthProfileStore(params.agentDir, {
        allowKeychainPrompt: false,
      });
  const preferredProfileId = params.authProfileId?.trim() || undefined;
  let lockedProfileId = params.authProfileIdSource === "user" ? preferredProfileId : undefined;

  if (lockedProfileId) {
    lockedProfileId = resolveLockedAuthProfile({
      agentDir: params.agentDir,
      authStore,
      config: params.config,
      lockedProfileId,
      modelId: params.modelId,
      pluginHarnessOwnsTransport,
      provider: params.provider,
      workspaceDir: params.workspaceDir,
      harnessId: agentHarness.id,
      deps,
    });
  }
  if (lockedProfileId && !pluginHarnessOwnsTransport) {
    const eligibility = deps.resolveAuthProfileEligibility({
      cfg: params.config,
      store: authStore,
      provider: params.provider,
      profileId: lockedProfileId,
    });
    if (!eligibility.eligible) {
      throw new Error(
        `Auth profile "${lockedProfileId}" is not configured for ${params.provider}.`,
      );
    }
  }

  const profileOrder = deps.shouldPreferExplicitConfigApiKeyAuth(params.config, params.provider)
    ? []
    : deps.resolveAuthProfileOrder({
        cfg: params.config,
        store: authStore,
        provider: params.provider,
        preferredProfile: preferredProfileId,
      });
  const providerPreferredProfileId = lockedProfileId
    ? undefined
    : deps.resolveProviderAuthProfileId({
        provider: params.provider,
        config: params.config,
        workspaceDir: params.workspaceDir,
        context: {
          config: params.config,
          agentDir: params.agentDir,
          workspaceDir: params.workspaceDir,
          provider: params.provider,
          modelId: params.modelId,
          preferredProfileId,
          lockedProfileId,
          profileOrder,
          authStore,
        },
      });
  const providerOrderedProfiles =
    providerPreferredProfileId && profileOrder.includes(providerPreferredProfileId)
      ? [
          providerPreferredProfileId,
          ...profileOrder.filter((profileId) => profileId !== providerPreferredProfileId),
        ]
      : profileOrder;
  const profileCandidates = lockedProfileId
    ? [lockedProfileId]
    : providerOrderedProfiles.length > 0
      ? providerOrderedProfiles
      : [undefined];

  return {
    agentHarness,
    authStorage,
    authStore,
    ctxInfo: resolvedRuntimeModel.ctxInfo,
    effectiveModel,
    lockedProfileId,
    model: runtimeModel,
    modelRegistry,
    pluginHarnessOwnsTransport,
    preferredProfileId,
    profileCandidates,
    runtimeModel,
  };
}

function resolveModelAuthPlanDependencies(
  deps?: ModelAuthPlanDependencies,
): Required<ModelAuthPlanDependencies> {
  return {
    buildAgentRuntimeAuthPlan: deps?.buildAgentRuntimeAuthPlan ?? buildAgentRuntimeAuthPlan,
    createEmptyAuthProfileStore: deps?.createEmptyAuthProfileStore ?? createEmptyAuthProfileStore,
    ensureAuthProfileStore: deps?.ensureAuthProfileStore ?? ensureAuthProfileStore,
    ensureOpenClawModelsJson: deps?.ensureOpenClawModelsJson ?? ensureOpenClawModelsJson,
    resolveAuthProfileEligibility:
      deps?.resolveAuthProfileEligibility ?? resolveAuthProfileEligibility,
    resolveAuthProfileOrder: deps?.resolveAuthProfileOrder ?? resolveAuthProfileOrder,
    resolveEffectiveRuntimeModel:
      deps?.resolveEffectiveRuntimeModel ?? resolveEffectiveRuntimeModel,
    resolveModelAsync: deps?.resolveModelAsync ?? resolveModelAsync,
    resolveProviderAuthProfileId:
      deps?.resolveProviderAuthProfileId ?? resolveProviderAuthProfileId,
    resolveProviderIdForAuth: deps?.resolveProviderIdForAuth ?? resolveProviderIdForAuth,
    selectAgentHarness: deps?.selectAgentHarness ?? selectAgentHarness,
    shouldPreferExplicitConfigApiKeyAuth:
      deps?.shouldPreferExplicitConfigApiKeyAuth ?? shouldPreferExplicitConfigApiKeyAuth,
  };
}

async function resolveEmbeddedRunModel(params: {
  agentDir: string;
  config?: OpenClawConfig;
  modelId: string;
  pluginHarnessOwnsTransport: boolean;
  provider: string;
  deps: Required<ModelAuthPlanDependencies>;
}): Promise<ModelResolution> {
  const dynamicModelResolution = await params.deps.resolveModelAsync(
    params.provider,
    params.modelId,
    params.agentDir,
    params.config,
    {
      // Plugin dynamic model hooks can resolve explicit model refs without
      // first generating PI models.json. This keeps one-shot model runs from
      // blocking on unrelated provider discovery.
      skipPiDiscovery: true,
    },
  );
  if (dynamicModelResolution.model || params.pluginHarnessOwnsTransport) {
    return dynamicModelResolution;
  }
  await params.deps.ensureOpenClawModelsJson(params.config, params.agentDir);
  return await params.deps.resolveModelAsync(
    params.provider,
    params.modelId,
    params.agentDir,
    params.config,
  );
}

function resolveLockedAuthProfile(params: {
  agentDir: string;
  authStore: AuthProfileStore;
  config?: OpenClawConfig;
  deps: Required<ModelAuthPlanDependencies>;
  harnessId: string;
  lockedProfileId: string;
  modelId: string;
  pluginHarnessOwnsTransport: boolean;
  provider: string;
  workspaceDir: string;
}): string | undefined {
  if (params.pluginHarnessOwnsTransport) {
    const runtimeAuthPlan = params.deps.buildAgentRuntimeAuthPlan({
      provider: params.provider,
      authProfileProvider: params.lockedProfileId.split(":", 1)[0],
      sessionAuthProfileId: params.lockedProfileId,
      config: params.config,
      workspaceDir: params.workspaceDir,
      harnessId: params.harnessId,
    });
    return runtimeAuthPlan.forwardedAuthProfileId ? params.lockedProfileId : undefined;
  }

  const lockedProfile = params.authStore.profiles[params.lockedProfileId];
  const lockedProfileProvider = lockedProfile
    ? params.deps.resolveProviderIdForAuth(lockedProfile.provider, {
        config: params.config,
        workspaceDir: params.workspaceDir,
      })
    : undefined;
  const runProvider = params.deps.resolveProviderIdForAuth(params.provider, {
    config: params.config,
    workspaceDir: params.workspaceDir,
  });
  if (!lockedProfile || !lockedProfileProvider || lockedProfileProvider !== runProvider) {
    return undefined;
  }
  return params.lockedProfileId;
}
