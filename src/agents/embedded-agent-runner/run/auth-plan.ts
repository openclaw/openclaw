import { resolveProviderAuthProfileId } from "../../../plugins/provider-runtime.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import { resolveExternalCliAuthOverlayScopeFromSelection } from "../../auth-profiles/external-cli-auth-selection.js";
import {
  getFrontierEvidenceExpectedAuthProfileId,
  getFrontierEvidencePolicy,
} from "../../frontier-evidence-policy.js";
import type { AgentHarness } from "../../harness/types.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
} from "../../model-auth.js";
import { OPENAI_PROVIDER_ID } from "../../openai-routing.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import {
  createPreparedRuntimeModelMaterializer,
  providerUsesCredentialScopedModelMetadata,
} from "../../runtime-plan/credential-scoped-model.js";
import {
  prepareAgentRuntimeAuth,
  type PreparedAgentRuntimeAuthAttempt,
} from "../../runtime-plan/prepare-auth.js";
import { resolveModelAsync } from "../model.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type ModelResolution = Awaited<ReturnType<typeof resolveModelAsync>>;
type RuntimeModel = NonNullable<ModelResolution["model"]>;

function resolveEmbeddedRunAuthInputs(params: {
  runParams: Pick<RunEmbeddedAgentParams, "authProfileId" | "authProfileIdSource">;
  provider: string;
  modelId: string;
}): {
  env: NodeJS.ProcessEnv;
  sessionAuthProfileId: string | undefined;
  sessionAuthProfileSource: RunEmbeddedAgentParams["authProfileIdSource"];
} {
  const policy = getFrontierEvidencePolicy();
  const expectedProfileId = getFrontierEvidenceExpectedAuthProfileId();
  if ((policy && !expectedProfileId) || (!policy && expectedProfileId)) {
    throw new Error("frontier evidence auth binding is incomplete");
  }
  if (policy) {
    if (params.provider !== policy.provider || params.modelId !== policy.model) {
      throw new Error("frontier evidence auth binding does not match the selected model");
    }
    return {
      env: {},
      sessionAuthProfileId: expectedProfileId,
      sessionAuthProfileSource: "user",
    };
  }
  return {
    env: process.env,
    sessionAuthProfileId: params.runParams.authProfileId?.trim() || undefined,
    sessionAuthProfileSource: params.runParams.authProfileIdSource,
  };
}

function loadEmbeddedRunAuthProfileStore(params: {
  agentDir: string;
  config: RunEmbeddedAgentParams["config"];
  externalCliProviderIds: Iterable<string>;
}): AuthProfileStore {
  // Provider pins own ambient overlays at this loader seam. Genuinely stored profiles and
  // explicit bindings remain available for the cross-class contracts in prepare-auth.test.ts.
  return ensureAuthProfileStore(params.agentDir, {
    config: params.config,
    externalCliProviderIds: params.externalCliProviderIds,
    allowKeychainPrompt: false,
  });
}

// Test-only seam access mirrors external-auth.ts; the config-threading regression
// must stay provable without composing a full embedded runner.
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.embeddedRunAuthPlanTestApi")] =
    { loadEmbeddedRunAuthProfileStore, resolveEmbeddedRunAuthInputs };
}

export async function prepareEmbeddedRunAuthPlan(params: {
  runParams: RunEmbeddedAgentParams;
  provider: string;
  modelId: string;
  model: RuntimeModel;
  agentDir: string;
  workspaceDir: string;
  requestStreamTransportOverrides?: "present";
  nativeModelOwned: boolean;
  authStorage: ModelResolution["authStorage"];
  modelRegistry: ModelResolution["modelRegistry"];
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  getAgentHarness: () => AgentHarness;
  setAgentHarness: (harness: AgentHarness) => void;
  getRuntimeModel: () => RuntimeModel;
  getEffectiveModel: () => RuntimeModel;
  applyResolvedRuntimeModel: (model: RuntimeModel) => void;
  selectHarnessForPreparedAttempts: (
    model: RuntimeModel,
    attempts: readonly PreparedAgentRuntimeAuthAttempt[],
  ) => AgentHarness;
  markStage?: (stage: string) => void;
}) {
  const runParams = params.runParams;
  const authInputs = resolveEmbeddedRunAuthInputs({
    runParams,
    provider: params.provider,
    modelId: params.modelId,
  });
  const usesOpenAIAuthRouting = params.provider === OPENAI_PROVIDER_ID;
  const initialHarness = params.getAgentHarness();
  const initialPluginHarnessOwnsTransport = initialHarness.id !== "openclaw";
  const openClawNativeCodexResponsesNeedsAuthBootstrap =
    !initialPluginHarnessOwnsTransport &&
    usesOpenAIAuthRouting &&
    params.getEffectiveModel().api === "openai-chatgpt-responses";
  let externalCliAuthScope = initialPluginHarnessOwnsTransport
    ? { ignoreAutoPreferredProfile: false }
    : openClawNativeCodexResponsesNeedsAuthBootstrap
      ? {
          providerIds: [OPENAI_PROVIDER_ID],
          ignoreAutoPreferredProfile: false,
        }
      : resolveExternalCliAuthOverlayScopeFromSelection({
          provider: params.provider,
          cfg: runParams.config,
          agentId: runParams.agentId,
          modelId: params.modelId,
          workspaceDir: params.workspaceDir,
          userLockedAuthProfileId:
            authInputs.sessionAuthProfileSource === "user"
              ? authInputs.sessionAuthProfileId
              : undefined,
        });
  let noExternalAuthStore: AuthProfileStore | undefined;
  if (!initialPluginHarnessOwnsTransport && !externalCliAuthScope.providerIds) {
    noExternalAuthStore = ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
      allowKeychainPrompt: false,
    });
    externalCliAuthScope = resolveExternalCliAuthOverlayScopeFromSelection({
      provider: params.provider,
      cfg: runParams.config,
      agentId: runParams.agentId,
      modelId: params.modelId,
      workspaceDir: params.workspaceDir,
      store: noExternalAuthStore,
      userLockedAuthProfileId:
        authInputs.sessionAuthProfileSource === "user"
          ? authInputs.sessionAuthProfileId
          : undefined,
    });
  }
  params.markStage?.("scope");

  const attemptAuthProfileStore = usesOpenAIAuthRouting
    ? loadEmbeddedRunAuthProfileStore({
        agentDir: params.agentDir,
        config: runParams.config,
        externalCliProviderIds: [OPENAI_PROVIDER_ID],
      })
    : initialPluginHarnessOwnsTransport
      ? ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
          allowKeychainPrompt: false,
        })
      : externalCliAuthScope.providerIds
        ? loadEmbeddedRunAuthProfileStore({
            agentDir: params.agentDir,
            config: runParams.config,
            externalCliProviderIds: externalCliAuthScope.providerIds,
          })
        : (noExternalAuthStore ??
          ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
            allowKeychainPrompt: false,
          }));
  params.markStage?.("store");

  const requestedProfileId = authInputs.sessionAuthProfileId;
  const lockedProfileId =
    authInputs.sessionAuthProfileSource === "user" ? requestedProfileId : undefined;
  const preferredProfileId =
    externalCliAuthScope.ignoreAutoPreferredProfile && !lockedProfileId
      ? undefined
      : requestedProfileId;
  const createAuthPreparation = () => {
    const harness = params.getAgentHarness();
    return prepareAgentRuntimeAuth({
      provider: params.provider,
      modelId: params.modelId,
      modelApi: params.model.api,
      modelBaseUrl: params.model.baseUrl,
      requestTransportOverrides: params.requestStreamTransportOverrides,
      config: runParams.config,
      env: authInputs.env,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      authProfileStore: attemptAuthProfileStore,
      sessionAuthProfileId: preferredProfileId,
      sessionAuthProfileSource: authInputs.sessionAuthProfileSource,
      harnessId: harness.id,
      harnessRuntime: harness.id,
      harnessAuthBootstrap: harness.authBootstrap,
      allowHarnessAuthProfileForwarding: true,
      allowTransientCooldownProbe: runParams.allowTransientCooldownProbe === true,
      resolveProviderPreferredProfileId: (context) =>
        resolveProviderAuthProfileId({
          provider: params.provider,
          config: runParams.config,
          workspaceDir: params.workspaceDir,
          env: authInputs.env,
          context,
        }),
    });
  };
  const providerUsesProfileScopedModelMetadata = providerUsesCredentialScopedModelMetadata({
    provider: params.provider,
    modelId: params.modelId,
    config: runParams.config,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
  });
  const { materialize: materializeAuthPlan, materializeUncached: materializeAuthPlanUncached } =
    createPreparedRuntimeModelMaterializer({
      provider: params.provider,
      modelId: params.modelId,
      config: runParams.config,
      getModel: params.getRuntimeModel,
      nativeModelOwned: params.nativeModelOwned,
      requestedProfileId,
      providerUsesProfileScopedModelMetadata,
      resolveModel: ({ config, authProfileId, authProfileMode }) =>
        resolveModelAsync(params.provider, params.modelId, params.agentDir, config, {
          authStorage: params.authStorage,
          modelRegistry: params.modelRegistry,
          skipAgentDiscovery: true,
          allowBundledStaticCatalogFallback: true,
          preferBundledStaticCatalogTransport: true,
          preparedModelRuntime: params.preparedModelRuntime,
          workspaceDir: params.workspaceDir,
          authProfileId,
          authProfileMode,
        }),
    });

  let resolvedAuthPreparation = createAuthPreparation();
  let preparedAuthAttempts = resolvedAuthPreparation.attempts;
  let activePreparedAuthPlan = resolvedAuthPreparation.plan;
  params.applyResolvedRuntimeModel(await materializeAuthPlan(activePreparedAuthPlan));
  params.markStage?.("prepare-plan");

  const finalizedHarness = params.selectHarnessForPreparedAttempts(
    params.getEffectiveModel(),
    preparedAuthAttempts,
  );
  if (finalizedHarness.id !== params.getAgentHarness().id) {
    params.setAgentHarness(finalizedHarness);
    resolvedAuthPreparation = createAuthPreparation();
    preparedAuthAttempts = resolvedAuthPreparation.attempts;
    activePreparedAuthPlan = resolvedAuthPreparation.plan;
    params.applyResolvedRuntimeModel(await materializeAuthPlan(activePreparedAuthPlan));
    const confirmedHarness = params.selectHarnessForPreparedAttempts(
      params.getEffectiveModel(),
      preparedAuthAttempts,
    );
    if (confirmedHarness.id !== params.getAgentHarness().id) {
      throw new Error(
        `Prepared auth route did not converge on one agent harness for ${params.provider}/${params.modelId}.`,
      );
    }
  }
  params.markStage?.("harness");

  return {
    usesOpenAIAuthRouting,
    attemptAuthProfileStore,
    lockedProfileId,
    preferredProfileId,
    providerUsesProfileScopedModelMetadata,
    materializeAuthPlan,
    materializeAuthPlanUncached,
    preparedAuthAttempts,
    activePreparedAuthPlan,
  };
}
