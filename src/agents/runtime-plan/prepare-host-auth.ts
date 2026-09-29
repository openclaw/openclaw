import { resolveOpenAIModelRoutes, selectOpenAIModelRouteAuth } from "../openai-model-routes.js";
import { buildProviderModelAuthSourcePlan } from "../provider-model-auth-source-plan.js";
import { buildAgentRuntimeAuthPlan } from "./auth.js";
import type {
  PrepareAgentRuntimeAuthPlanParams,
  PreparedAgentRuntimeAuth,
} from "./prepare-auth.js";
import type { AgentRuntimeAuthPlan } from "./types.js";

/** Keeps route constraints while leaving all credential selection to the harness host. */
export function prepareHostOwnedRuntimeAuth(
  params: PrepareAgentRuntimeAuthPlanParams,
): PreparedAgentRuntimeAuth {
  const resolution = resolveOpenAIModelRoutes({
    provider: params.provider,
    modelId: params.modelId,
    api: params.modelApi,
    baseUrl: params.modelBaseUrl,
    config: params.config,
    agentId: params.agentId,
    routeIntent: params.routeIntent,
    env: params.env,
    requestTransportOverrides: params.requestTransportOverrides,
  });
  if (resolution?.kind === "incompatible") {
    throw new Error(resolution.message);
  }
  let modelRoute: AgentRuntimeAuthPlan["modelRoute"];
  let deferredRouteSupport: AgentRuntimeAuthPlan["deferredRouteSupport"];
  if (resolution?.kind === "routes") {
    const decision = selectOpenAIModelRouteAuth({
      resolution,
      sourcePlan: buildProviderModelAuthSourcePlan({ profiles: [] }),
      runtimeAuthOwner: { id: params.harnessId ?? params.harnessRuntime ?? "" },
      allowNativeAuthOnSingleRoute: true,
    });
    if (decision.kind !== "deferred") {
      throw new Error(
        decision.kind === "selected"
          ? "Host-owned authentication must not select a Gateway credential."
          : decision.message,
      );
    }
    const route = resolution.routes.length === 1 ? resolution.routes[0] : undefined;
    if (route) {
      modelRoute = { provider: params.provider, modelId: params.modelId, ...route };
    } else {
      deferredRouteSupport = decision.routeSupport;
    }
  }
  const plan: AgentRuntimeAuthPlan = {
    ...buildAgentRuntimeAuthPlan({
      provider: params.provider,
      modelId: params.modelId,
      config: params.config,
      env: params.env,
      workspaceDir: params.workspaceDir,
      metadataSnapshot: params.metadataSnapshot,
      harnessId: params.harnessId,
      harnessRuntime: params.harnessRuntime,
      allowHarnessAuthProfileForwarding: false,
      modelRoute,
      deferredRouteSupport,
      credentialSource: { kind: "none" },
    }),
    authOwnership: "host",
  };
  return { plan, attempts: [{ kind: "implicit", plan }] };
}
