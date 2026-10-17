import type { Model } from "../../../llm/types.js";
import { resolveProviderPolicySurface } from "../../../plugins/provider-public-artifacts.js";
import { OPENCLAW_AGENT_RUNTIME_ID } from "../../agent-runtime-id.js";
import { resolveAuthoredModelContextTokens } from "../../context-resolution.js";
import { AgentHarnessPreflightError } from "../../harness/errors.js";
import type { AgentHarnessPreparedModelProvider } from "../../harness/selection-decision.js";
import {
  selectAgentHarness,
  selectAgentHarnessForPreparedModelProviders,
} from "../../harness/selection.js";
import {
  resolveAgentHarnessPreparedAuthSupport,
  resolveAgentHarnessPreparedRouteSupport,
} from "../../harness/support.js";
import type { AgentHarness } from "../../harness/types.js";
import {
  resolveAliasedParamValue,
  resolveModelExtraParamSources,
} from "../../model-extra-params.js";
import { resolveContextConfigProviderForRuntime } from "../../openai-routing.js";
import { resolveProviderRequestCapabilities } from "../../provider-attribution.js";
import { getModelProviderRequestRouteFacts } from "../../provider-request-config.js";
import type { PreparedAgentRuntimeAuthAttempt } from "../../runtime-plan/prepare-auth.js";
import type { AgentRuntimeAuthPlan } from "../../runtime-plan/types.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { resolveEmbeddedRuntimeModelPolicy } from "./setup.js";

type HarnessSelectionContext = {
  runParams: RunEmbeddedAgentParams;
  provider: string;
  modelId: string;
  requestStreamTransportOverrides?: "present";
  pinnedHarnessId?: string;
};

export function resolveEmbeddedRunEffectiveModel(
  params: HarnessSelectionContext & {
    modelConfigProvider: string;
    agentHarnessId: string;
    runtimeModel: Model;
    nativeModelOwned: boolean;
  },
) {
  const contextConfigProvider = resolveContextConfigProviderForRuntime({
    provider: params.modelConfigProvider,
    runtimeId: params.agentHarnessId,
    config: params.runParams.config,
  });
  const { defaultParams, modelParams, agentModelParams, agentParams } =
    resolveModelExtraParamSources({
      config: params.runParams.config,
      provider: contextConfigProvider,
      modelId: params.modelId,
      agentId: params.runParams.agentId,
    });
  const sources = [
    defaultParams,
    modelParams,
    agentModelParams,
    agentParams,
    Object.fromEntries(
      Object.entries(params.runParams.streamParams ?? {}).filter(
        ([, value]) => value !== undefined,
      ),
    ),
    ...(params.runParams.fastMode === undefined ? [] : [{ fastMode: params.runParams.fastMode }]),
  ];
  const requestExtraParams: Record<string, unknown> = Object.assign({}, ...sources);
  // Budget the same winning aliases that request assembly sends.
  requestExtraParams.serviceTier = resolveAliasedParamValue(sources, [
    "serviceTier",
    "service_tier",
  ]);
  requestExtraParams.fastMode = resolveAliasedParamValue(sources, ["fastMode", "fast_mode"]);
  delete requestExtraParams.service_tier;
  delete requestExtraParams.fast_mode;
  const requestServiceTiers =
    params.nativeModelOwned || params.provider !== "openai"
      ? undefined
      : resolveProviderPolicySurface(params.provider, {
          config: params.runParams.config,
        })?.resolveServiceTiers?.({
          provider: params.provider,
          modelId: params.runtimeModel.id,
          api: params.runtimeModel.api,
          baseUrl: params.runtimeModel.baseUrl,
          runtimeId: params.agentHarnessId,
          params: requestExtraParams,
          requestCapabilities:
            getModelProviderRequestRouteFacts(params.runtimeModel)?.capabilities ??
            resolveProviderRequestCapabilities({
              provider: params.provider,
              modelId: params.runtimeModel.id,
              api: params.runtimeModel.api,
              baseUrl: params.runtimeModel.baseUrl,
            }),
        });
  const authoredContextTokenCap =
    params.pinnedHarnessId || params.agentHarnessId === OPENCLAW_AGENT_RUNTIME_ID
      ? undefined
      : resolveAuthoredModelContextTokens({
          cfg: params.runParams.config,
          provider: contextConfigProvider,
          model: params.modelId,
        });
  const resolved = resolveEmbeddedRuntimeModelPolicy({
    cfg: params.runParams.config,
    provider: params.provider,
    contextConfigProvider,
    modelId: params.modelId,
    runtimeModel: params.runtimeModel,
    nativeModelOwned: params.nativeModelOwned,
    authoredContextTokenCap,
    requestExtraParams,
    requestServiceTiers,
    ...(params.runParams.contextWindow ? { contextWindow: params.runParams.contextWindow } : {}),
    ...(params.runParams.contextTokenBudget === undefined
      ? {}
      : { contextTokenBudget: params.runParams.contextTokenBudget }),
  });
  return {
    ...resolved,
    ...(authoredContextTokenCap === undefined ? {} : { authoredContextTokenCap }),
  };
}

function buildHarnessModelProvider(
  params: HarnessSelectionContext & {
    model: Model;
    plan?: AgentRuntimeAuthPlan;
    preparedAuthAttempt?: PreparedAgentRuntimeAuthAttempt;
  },
): AgentHarnessPreparedModelProvider {
  const route = params.plan?.modelRoute;
  const routeSupport = resolveAgentHarnessPreparedRouteSupport(params.plan);
  const requestTransportOverrides =
    params.requestStreamTransportOverrides ?? routeSupport.requestTransportOverrides;
  return {
    api: route?.api ?? params.model.api,
    baseUrl: route?.baseUrl ?? params.model.baseUrl,
    ...(requestTransportOverrides ? { requestTransportOverrides } : {}),
    ...(routeSupport.runtimePolicy ? { runtimePolicy: routeSupport.runtimePolicy } : {}),
    ...(params.plan
      ? {
          preparedAuth: resolveAgentHarnessPreparedAuthSupport({
            plan: params.plan,
            ...(params.preparedAuthAttempt?.kind === "profile" ||
            params.preparedAuthAttempt?.kind === "direct"
              ? { source: params.preparedAuthAttempt.kind }
              : {}),
          }),
        }
      : {}),
  };
}

export function selectEmbeddedRunHarness(
  params: Parameters<typeof buildHarnessModelProvider>[0] & {
    attempts?: readonly PreparedAgentRuntimeAuthAttempt[];
  },
): AgentHarness {
  const selection = {
    provider: params.provider,
    modelId: params.modelId,
    config: params.runParams.config,
    agentId: params.runParams.agentId,
    sessionKey: params.runParams.sessionKey,
    agentHarnessId: params.runParams.agentHarnessId,
    agentHarnessRuntimeOverride: params.runParams.agentHarnessRuntimeOverride,
  };
  const selected =
    params.attempts !== undefined
      ? selectAgentHarnessForPreparedModelProviders({
          ...selection,
          modelProviders: params.attempts.map((attempt) =>
            buildHarnessModelProvider({
              ...params,
              plan: attempt.plan,
              preparedAuthAttempt: attempt,
            }),
          ),
        })
      : selectAgentHarness({ ...selection, modelProvider: buildHarnessModelProvider(params) });
  if (params.pinnedHarnessId && selected.id !== params.pinnedHarnessId) {
    const subject = params.attempts !== undefined ? "Prepared auth routes" : "Prepared model route";
    throw new AgentHarnessPreflightError(
      `${subject} changed the session-pinned agent harness from "${params.pinnedHarnessId}" to "${selected.id}". Reattach the original native session or use a concrete model chat.`,
    );
  }
  return selected;
}
