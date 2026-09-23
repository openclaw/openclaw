import { normalizeOptionalString as readStringParam } from "@openclaw/normalization-core/string-coerce";
import {
  resolveMergedModelProviderConfig,
  findConfiguredProviderModel,
  createModelProviderRouteOverrideResolver,
} from "../../config/model-provider-config.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../../config/runtime-source-projection.js";
import type { ModelApi } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  ProviderModelRouteRuntimePolicy,
  ProviderResolveModelRoutesContext,
  ProviderRouteOverridePresence,
} from "../../plugin-sdk/provider-model-types.js";
import { resolveProviderModelRoutes } from "../../plugins/provider-model-routes.js";
import { hasAuthoredProviderRequestParams } from "../model-extra-params.js";
import {
  resolveAgentRuntimePolicyAgentId,
  resolveModelRouteIntent,
  type AgentRuntimePolicyScope,
} from "../model-runtime-policy.js";
import { resolveDefaultModelForAgent } from "../model-selection-config.js";
import { canonicalizeProviderModelId } from "../provider-model-route.js";
import type { PreparedAgentRuntimeAuthAttempt } from "../runtime-plan/prepare-auth.js";
import type { AgentRuntimeAuthPlan } from "../runtime-plan/types.js";
import { resolveAgentHarnessAutoSelectionHint } from "./auto-selection.js";
import { AgentHarnessPreflightError } from "./errors.js";
import { listRegisteredAgentHarnesses } from "./registry.js";
import type {
  AgentHarness,
  AgentHarnessPreparedAuthSupport,
  AgentHarnessSupport,
  AgentHarnessSupportContext,
} from "./types.js";

type HarnessProviderOwnership =
  | { status: "unowned" }
  | { status: "owned" | "ambiguous"; pluginIds: readonly string[] };

/** Projects one prepared auth attempt into a secret-free native-runtime support fact. */
export function resolveAgentHarnessPreparedAuthSupport(params: {
  plan?: AgentRuntimeAuthPlan;
  source?: AgentHarnessPreparedAuthSupport["source"];
}): AgentHarnessPreparedAuthSupport | undefined {
  const plan = params.plan;
  if (!plan) {
    return undefined;
  }
  const source =
    params.source ??
    (plan.forwardedAuthProfileId
      ? "profile"
      : plan.selectedAuthMode
        ? "direct"
        : plan.harnessAuthProvider
          ? "harness"
          : "none");
  return {
    source,
    ...(plan.selectedAuthMode ? { mode: plan.selectedAuthMode } : {}),
    ...(plan.modelRoute ? { requirement: plan.modelRoute.authRequirement } : {}),
  };
}

/** Projects the concrete or deferred prepared route into native-runtime support facts. */
export function resolveAgentHarnessPreparedRouteSupport(
  plan?: AgentRuntimeAuthPlan,
): Pick<
  NonNullable<AgentHarnessSupportContext["modelProvider"]>,
  "requestTransportOverrides" | "runtimePolicy"
> {
  const support = plan?.modelRoute ?? plan?.deferredRouteSupport;
  return support
    ? {
        requestTransportOverrides: support.requestTransportOverrides,
        runtimePolicy: support.runtimePolicy,
      }
    : {};
}

/** Projects one prepared compaction attempt into secret-free harness support facts. */
export function projectPreparedModelProvider(params: {
  model?: Pick<NonNullable<AgentHarnessSupportContext["modelProvider"]>, "api" | "baseUrl">;
  plan?: AgentRuntimeAuthPlan;
  attemptKind?: PreparedAgentRuntimeAuthAttempt["kind"];
}): NonNullable<AgentHarnessSupportContext["modelProvider"]> {
  const route = params.plan?.modelRoute;
  return {
    api: route?.api ?? params.model?.api,
    baseUrl: route?.baseUrl ?? params.model?.baseUrl,
    ...resolveAgentHarnessPreparedRouteSupport(params.plan),
    ...(params.plan
      ? {
          preparedAuth: resolveAgentHarnessPreparedAuthSupport({
            plan: params.plan,
            source: params.attemptKind === "implicit" ? undefined : params.attemptKind,
          }),
        }
      : {}),
  };
}

/** Builds the provider/model facts passed to registered harness support probes. */
export function buildAgentHarnessSupportContext(
  params: {
    provider: string;
    modelId?: string;
    /** Prepared provider facts take precedence over config rediscovery. */
    modelProvider?: AgentHarnessSupportContext["modelProvider"];
    requestedRuntime: AgentHarnessSupportContext["requestedRuntime"];
    config?: OpenClawConfig;
    /** Finalized route/auth selection; missing runtimePolicy stays undeclared. */
    preparedModelProvider?: boolean;
    /** Prepared selection fact; read-only projections omit it to avoid plugin metadata discovery. */
    providerOwnership?: HarnessProviderOwnership;
  } & AgentRuntimePolicyScope,
): AgentHarnessSupportContext {
  const providerConfig = resolveMergedModelProviderConfig(params.config, params.provider);
  const authoredConfig = params.config
    ? projectConfigOntoRuntimeSourceSnapshot(params.config)
    : undefined;
  const modelId = params.modelId?.trim();
  const modelConfig = modelId
    ? findConfiguredProviderModel(providerConfig, params.provider, modelId, (configuredModelId) =>
        canonicalizeProviderModelId(params.provider, configuredModelId),
      )
    : undefined;
  const authoredProviderConfig = resolveMergedModelProviderConfig(authoredConfig, params.provider);
  const authoredModelConfig = modelId
    ? findConfiguredProviderModel(authoredProviderConfig, params.provider, modelId, (id) =>
        canonicalizeProviderModelId(params.provider, id),
      )
    : undefined;
  const endpointOverrides: ProviderRouteOverridePresence =
    params.modelProvider?.endpointOverrides ??
    ([
      authoredProviderConfig?.api,
      authoredProviderConfig?.baseUrl,
      authoredModelConfig?.api,
      authoredModelConfig?.baseUrl,
    ].some((value) => readStringParam(value) !== undefined)
      ? "present"
      : "none");
  const agentId = resolveAgentRuntimePolicyAgentId(params);
  const hasConfiguredProviderRequestParams = hasAuthoredProviderRequestParams({
    config: params.config,
    provider: params.provider,
    modelId: params.modelId,
    agentId,
  });
  const configuredModelProvider = providerConfig
    ? {
        api: modelConfig?.api ?? providerConfig.api ?? "openai-responses",
        baseUrl: modelConfig?.baseUrl ?? providerConfig.baseUrl,
        azureApiVersion: readStringParam(
          modelConfig?.params?.azureApiVersion ?? providerConfig.params?.azureApiVersion,
        ),
        request: providerConfig.request,
        requestTransportOverrides: createModelProviderRouteOverrideResolver({
          provider: params.provider,
          authoredConfig,
          canonicalizeModelId: (configuredModelId) =>
            canonicalizeProviderModelId(params.provider, configuredModelId),
        })(params.modelId),
      }
    : undefined;
  const requestTransportOverrides: ProviderRouteOverridePresence =
    params.modelProvider?.requestTransportOverrides === "present" ||
    configuredModelProvider?.requestTransportOverrides === "present" ||
    hasConfiguredProviderRequestParams
      ? "present"
      : "none";
  const modelProviderFacts = {
    api: params.modelProvider?.api ?? configuredModelProvider?.api,
    baseUrl: params.modelProvider?.baseUrl ?? configuredModelProvider?.baseUrl,
    azureApiVersion:
      params.modelProvider?.azureApiVersion ?? configuredModelProvider?.azureApiVersion,
    request: params.modelProvider?.request ?? configuredModelProvider?.request,
    preparedAuth: params.modelProvider?.preparedAuth,
    requestTransportOverrides,
    endpointOverrides,
  };
  // Finalized routes carry the owner decision. Earlier selection resolves the same provider
  // artifact once so an indeterminate route cannot regain provider-id-only native support.
  const runtimePolicy = params.modelProvider?.runtimePolicy
    ? params.modelProvider.runtimePolicy
    : params.preparedModelProvider
      ? undefined
      : resolveHarnessRouteRuntimePolicy({
          provider: params.provider,
          modelId: params.modelId,
          modelProvider: modelProviderFacts,
          config: params.config,
          routeIntent: resolveModelRouteIntent({
            config: params.config,
            provider: params.provider,
            modelId: params.modelId,
            agentId,
            primaryModel: params.config
              ? resolveDefaultModelForAgent({
                  cfg: params.config,
                  agentId,
                  allowManifestNormalization: false,
                  allowPluginNormalization: false,
                })
              : undefined,
          }),
        });
  const modelProvider = {
    ...modelProviderFacts,
    runtimePolicy,
  };
  return {
    provider: params.provider,
    modelId: params.modelId,
    modelProvider,
    requestedRuntime: params.requestedRuntime,
    ...(params.providerOwnership
      ? {
          providerOwnerStatus: params.providerOwnership.status,
          providerOwnerPluginIds:
            params.providerOwnership.status === "unowned" ? [] : params.providerOwnership.pluginIds,
        }
      : {}),
  };
}

function resolveHarnessRouteRuntimePolicy(params: {
  provider: string;
  modelId?: string;
  modelProvider?: AgentHarnessSupportContext["modelProvider"];
  config?: OpenClawConfig;
  routeIntent?: ProviderResolveModelRoutesContext["routeIntent"];
}): ProviderModelRouteRuntimePolicy | undefined {
  const resolution = resolveProviderModelRoutes({
    provider: params.provider,
    modelId: params.modelId,
    api: params.modelProvider?.api as ModelApi | undefined,
    baseUrl: params.modelProvider?.baseUrl,
    config: params.config,
    routeIntent: params.routeIntent,
    requestTransportOverrides: params.modelProvider?.requestTransportOverrides,
  });
  if (!resolution) {
    return undefined;
  }
  if (resolution.kind !== "routes") {
    return undefined;
  }
  const policies = resolution.routes.map((route) => route.runtimePolicy);
  const first = policies[0];
  if (!first || policies.some((policy) => !policy)) {
    return undefined;
  }
  return {
    compatibleIds: first.compatibleIds.filter(
      (id, index, ids) =>
        ids.indexOf(id) === index && policies.every((policy) => policy?.compatibleIds.includes(id)),
    ),
  };
}

/** Resolves the registered plugin harness that auto selection would choose. */
export function resolveAutoAgentHarnessId(
  params: {
    provider: string;
    modelId?: string;
    config?: OpenClawConfig;
    modelProvider?: AgentHarnessSupportContext["modelProvider"];
    preparedModelProvider?: boolean;
  } & AgentRuntimePolicyScope,
): string | undefined {
  const registeredHarnesses = listRegisteredAgentHarnesses();
  if (registeredHarnesses.length === 0) {
    return undefined;
  }
  const candidates = registeredHarnesses.map(({ harness }) => ({
    harness,
    support: resolveAgentHarnessAutoSelectionHint({ harness, provider: params.provider }),
  }));
  if (candidates.every((entry) => entry.support !== undefined)) {
    return undefined;
  }
  const supportContext = buildAgentHarnessSupportContext({
    ...params,
    requestedRuntime: "auto",
  });
  return candidates
    .map(({ harness, support }) => ({
      harness,
      support: support ?? harness.supports(supportContext),
    }))
    .filter(isSupportedHarness)
    .toSorted(compareHarnessSupport)[0]?.harness.id;
}

export function compareHarnessSupport(
  left: { harness: AgentHarness; support: AgentHarnessSupport & { supported: true } },
  right: { harness: AgentHarness; support: AgentHarnessSupport & { supported: true } },
): number {
  const priorityDelta = (right.support.priority ?? 0) - (left.support.priority ?? 0);
  return priorityDelta !== 0 ? priorityDelta : left.harness.id.localeCompare(right.harness.id);
}

function isSupportedHarness(entry: {
  harness: AgentHarness;
  support: AgentHarnessSupport;
}): entry is {
  harness: AgentHarness;
  support: AgentHarnessSupport & { supported: true };
} {
  return entry.support.supported;
}

export function assertPluginHarnessConversationToolPolicySupport(
  harness: AgentHarness,
  restricted: boolean,
): void {
  if (
    harness.id !== "openclaw" &&
    restricted &&
    harness.conversationToolPolicySupport !== "exact"
  ) {
    throw new AgentHarnessPreflightError(
      `${harness.label} cannot enforce this conversation's tool policy. Use the embedded runtime or ask in the main conversation.`,
      {
        scope: "harness",
        userMessage: `${harness.label} cannot run with this chat's tool restrictions. Choose a different model provider or update the tool settings.`,
      },
    );
  }
}
