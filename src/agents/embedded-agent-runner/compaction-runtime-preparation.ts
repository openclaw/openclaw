import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isAbortError } from "../../infra/abort-signal.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { resolveAgentHarnessPolicy } from "../harness/policy.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import {
  selectAgentHarness,
  selectAgentHarnessForPreparedModelProviders,
} from "../harness/selection.js";
import { projectPreparedModelProvider } from "../harness/support.js";
import type { AgentHarness } from "../harness/types.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
} from "../model-auth.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import { isOpenAIProvider } from "../openai-routing.js";
import {
  providerUsesCredentialScopedModelMetadata,
  resolveReusableRuntimeModelAuth,
} from "../runtime-plan/credential-scoped-model.js";
import {
  prepareAgentRuntimeAuth,
  type PreparedAgentRuntimeAuth,
  type PreparedAgentRuntimeAuthAttempt,
} from "../runtime-plan/prepare-auth.js";
import type { AgentRuntimeAuthPlan, AgentRuntimePlan } from "../runtime-plan/types.js";
import {
  resolveCompactionHarnessRuntime,
  resolveCompactionTargetRuntime,
  resolveEmbeddedCompactionTarget,
} from "./compaction-runtime-context.js";
import { resolveTieredModel } from "./model-resolution.js";

export function projectCodexHostTranscriptBytePreflightConfig(
  config: OpenClawConfig | undefined,
  active: boolean,
): OpenClawConfig | undefined {
  const compaction = config?.agents?.defaults?.compaction;
  if (
    !active ||
    !compaction ||
    (!Object.hasOwn(compaction, "model") && !Object.hasOwn(compaction, "provider"))
  ) {
    return config;
  }
  const { model: _model, provider: _provider, ...projectedCompaction } = compaction;
  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: { ...config.agents?.defaults, compaction: projectedCompaction },
    },
  };
}

/** Resolves the shared policy, target, and harness ownership for either compaction entry point. */
export function resolveCompactionRuntimeSelection(params: {
  config?: OpenClawConfig;
  provider?: string | null;
  modelId?: string | null;
  authProfileId?: string | null;
  modelSelectionLocked?: boolean;
  sandboxSessionKey?: string | null;
  sandboxAgentId?: string;
  sessionKey?: string | null;
  agentId?: string;
  boundHarnessRuntime?: string | null;
  preparedRuntimePlan?: AgentRuntimePlan;
  runtimeAuthPlan?: AgentRuntimeAuthPlan;
  selectedHarnessRuntime?: string;
  allowPluginNormalization?: boolean;
  manifestPlugins?: ModelManifestNormalizationContext["manifestPlugins"];
}) {
  const runtimePolicySessionKey = params.sandboxSessionKey ?? params.sessionKey ?? undefined;
  const runtimePolicyAgentId =
    params.sandboxAgentId ??
    (params.sandboxSessionKey && parseAgentSessionKey(params.sandboxSessionKey)
      ? undefined
      : params.agentId);
  const policyTarget = resolveEmbeddedCompactionTarget({
    config: params.config,
    provider: params.provider,
    modelId: params.modelId,
    authProfileId: params.authProfileId,
    modelSelectionLocked: params.modelSelectionLocked,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
  });
  const policyProvider = policyTarget.provider ?? DEFAULT_PROVIDER;
  const policyModelId = policyTarget.model ?? DEFAULT_MODEL;
  const policy = resolveAgentHarnessPolicy({
    provider: policyProvider,
    modelId: policyModelId,
    config: params.config,
    agentId: runtimePolicyAgentId,
    sessionKey: runtimePolicySessionKey,
  });
  const configuredHarnessRuntime =
    policy.runtimeSource &&
    policy.runtimeSource !== "implicit" &&
    !isDefaultAgentRuntimeId(policy.runtime)
      ? policy.runtime
      : undefined;
  const boundHarnessRuntime = normalizeOptionalAgentRuntimeId(params.boundHarnessRuntime);
  const selectedHarnessRuntime =
    params.selectedHarnessRuntime ??
    resolveCompactionHarnessRuntime({
      boundHarnessRuntime,
      preparedRuntimePlan: params.preparedRuntimePlan,
      configuredHarnessRuntime,
      provider: policyProvider,
      modelId: policyModelId,
    });
  const target = {
    ...policyTarget,
    ...resolveCompactionTargetRuntime(policyTarget.provider, selectedHarnessRuntime),
  };
  const provider = target.provider ?? DEFAULT_PROVIDER;
  const modelId = target.model ?? DEFAULT_MODEL;
  const selectedRuntime = normalizeOptionalAgentRuntimeId(selectedHarnessRuntime);
  const attemptNativeHarnessCompaction = Boolean(
    selectedRuntime &&
    selectedRuntime !== "auto" &&
    selectedRuntime !== "openclaw" &&
    (!isOpenAIProvider(provider) || target.nativeHarnessCompaction === true),
  );
  return {
    attemptNativeHarnessCompaction,
    runtimePolicySessionKey,
    runtimePolicyAgentId,
    boundHarnessRuntime,
    selectedHarnessRuntime,
    selectedHarnessRuntimeOverride: boundHarnessRuntime ? undefined : selectedHarnessRuntime,
    target,
    runtimeModelAuth: resolveReusableRuntimeModelAuth({
      plan: params.runtimeAuthPlan ?? params.preparedRuntimePlan?.auth,
      provider,
      modelId,
      authProfileId: target.authProfileId,
    }),
    provider,
    runtimeProvider: target.runtimeProvider ?? provider,
    contextConfigProvider: target.contextProvider ?? provider,
    modelId,
  };
}

/** Resolves compaction metadata using the selected harness's auth ownership. */
export async function prepareCompactionModel(
  params: Parameters<typeof ensureSelectedAgentHarnessPlugin>[0] &
    Omit<Parameters<typeof resolveTieredModel>[0], "provider" | "harnessAuthBootstrap"> & {
      runtimeProvider: string;
      reusableRuntimeAuthPlan?: AgentRuntimeAuthPlan;
    },
) {
  await ensureSelectedAgentHarnessPlugin(params);
  params.abortSignal?.throwIfAborted();
  params.assertCurrent?.();
  const selectionParams = {
    config: params.config,
    provider: params.provider,
    modelId: params.modelId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    agentHarnessId: params.agentHarnessId,
    agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride,
  };
  const harness = params.reusableRuntimeAuthPlan
    ? selectAgentHarnessForPreparedModelProviders({
        ...selectionParams,
        modelProviders: [projectPreparedModelProvider({ plan: params.reusableRuntimeAuthPlan })],
      })
    : selectAgentHarness(selectionParams);
  return resolveTieredModel({
    ...params,
    provider: params.runtimeProvider,
    harnessAuthBootstrap: harness.authBootstrap,
  });
}

/** Prepares one ordered auth-attempt set and converges it on a single compaction harness. */
export async function prepareCompactionHarnessAuth(params: {
  config?: OpenClawConfig;
  provider: string;
  metadataProvider?: string;
  modelId: string;
  model?: ProviderRuntimeModel;
  reusableRuntimeAuthPlan?: AgentRuntimeAuthPlan;
  agentDir: string;
  workspaceDir: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  runtimePolicyAgentId?: string;
  runtimePolicySessionKey?: string | null;
  agentHarnessId?: string;
  agentHarnessRuntimeOverride?: string;
  convergenceErrorPrefix?: "Prepared compaction" | "Prepared queued compaction";
}): Promise<
  | {
      ok: true;
      runtimeAuthProfileStore: ReturnType<typeof ensureAuthProfileStore>;
      runtimeAuthPreparation: PreparedAgentRuntimeAuth;
      selectedPreparedHarness: AgentHarness;
      providerUsesProfileScopedModelMetadata: boolean;
    }
  | { ok: false; error: unknown }
> {
  const harnessSelectionParams = {
    provider: params.provider,
    modelId: params.modelId,
    config: params.config,
    agentId: params.runtimePolicyAgentId,
    sessionKey: params.runtimePolicySessionKey ?? undefined,
    agentHarnessId: params.agentHarnessId,
    agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride,
  };
  const selectPreparedHarness = (attempts: readonly PreparedAgentRuntimeAuthAttempt[]) =>
    selectAgentHarnessForPreparedModelProviders({
      ...harnessSelectionParams,
      modelProviders: attempts.map((attempt) =>
        projectPreparedModelProvider({
          model: params.model,
          plan: attempt.plan,
          attemptKind: attempt.kind,
        }),
      ),
    });
  const initialHarness = params.reusableRuntimeAuthPlan
    ? selectPreparedHarness([{ kind: "implicit", plan: params.reusableRuntimeAuthPlan }])
    : selectAgentHarness({
        ...harnessSelectionParams,
        modelProvider: projectPreparedModelProvider({ model: params.model }),
      });
  // A plugin-owned credential cannot inherit an earlier provider/profile auth route.
  const reusableRuntimeAuthPlan =
    initialHarness.authBootstrap === "plugin" ? undefined : params.reusableRuntimeAuthPlan;
  const runtimeAuthProfileStore: ReturnType<typeof ensureAuthProfileStore> =
    initialHarness.authBootstrap === "plugin"
      ? { version: 1, profiles: {} }
      : isOpenAIProvider(params.provider)
        ? ensureAuthProfileStore(params.agentDir, {
            profileId: params.authProfileId ?? reusableRuntimeAuthPlan?.forwardedAuthProfileId,
            externalCliProviderIds: ["openai"],
            allowKeychainPrompt: false,
          })
        : ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
            profileId: params.authProfileId ?? reusableRuntimeAuthPlan?.forwardedAuthProfileId,
            allowKeychainPrompt: false,
          });
  const prepare = (harness: AgentHarness) => {
    try {
      return {
        ok: true as const,
        auth: prepareAgentRuntimeAuth({
          provider: params.provider,
          modelId: params.modelId,
          modelApi: params.model?.api,
          modelBaseUrl: params.model?.baseUrl,
          config: params.config,
          agentId: params.runtimePolicyAgentId,
          env: process.env,
          agentDir: params.agentDir,
          workspaceDir: params.workspaceDir,
          authProfileStore: runtimeAuthProfileStore,
          sessionAuthProfileId: params.authProfileId,
          sessionAuthProfileSource: params.authProfileIdSource,
          harnessId: harness.id,
          harnessRuntime: harness.id,
          harnessAuthBootstrap: harness.authBootstrap,
        }),
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      // Auth refusals are compaction failures; store and harness failures still reject.
      return { ok: false as const, error };
    }
  };
  const initialAuth = reusableRuntimeAuthPlan
    ? {
        ok: true as const,
        auth: {
          plan: reusableRuntimeAuthPlan,
          attempts: [{ kind: "implicit", plan: reusableRuntimeAuthPlan }],
        } satisfies PreparedAgentRuntimeAuth,
      }
    : prepare(initialHarness);
  if (!initialAuth.ok) {
    return initialAuth;
  }
  let runtimeAuthPreparation: PreparedAgentRuntimeAuth = initialAuth.auth;
  let selectedPreparedHarness = reusableRuntimeAuthPlan
    ? initialHarness
    : selectPreparedHarness(runtimeAuthPreparation.attempts);
  if (!reusableRuntimeAuthPlan && selectedPreparedHarness.id !== initialHarness.id) {
    const preparedAuth = prepare(selectedPreparedHarness);
    if (!preparedAuth.ok) {
      return preparedAuth;
    }
    runtimeAuthPreparation = preparedAuth.auth;
    const confirmedHarness = selectPreparedHarness(runtimeAuthPreparation.attempts);
    if (confirmedHarness.id !== selectedPreparedHarness.id) {
      throw new Error(
        `${params.convergenceErrorPrefix ?? "Prepared compaction"} auth routes did not converge on one agent harness for ${params.provider}/${params.modelId}.`,
      );
    }
    selectedPreparedHarness = confirmedHarness;
  }
  return {
    ok: true,
    runtimeAuthProfileStore,
    runtimeAuthPreparation,
    selectedPreparedHarness,
    providerUsesProfileScopedModelMetadata:
      selectedPreparedHarness.authBootstrap !== "plugin" &&
      providerUsesCredentialScopedModelMetadata({
        provider: params.metadataProvider ?? params.provider,
        modelId: params.modelId,
        config: params.config,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
      }),
  };
}
