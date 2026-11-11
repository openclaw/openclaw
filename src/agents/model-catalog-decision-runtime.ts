import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { GatewayAgentRuntime } from "../shared/session-types.js";
import { isDefaultAgentRuntimeId } from "./agent-runtime-id.js";
import { resolveAgentHarnessAvailabilityDecision } from "./harness/availability.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { resolveAutoAgentHarnessId } from "./harness/support.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

/** Public runtime and thinking consume this same route/account decision. */
export function resolveCatalogDecisionRuntime(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry: ModelCatalogEntry;
  evaluation: ModelAuthAvailabilityEvaluation;
  pluginRegistry?: PluginRegistry;
}): GatewayAgentRuntime | undefined {
  const route = params.evaluation.selectedRoute;
  const context = {
    config: params.cfg,
    agentId: params.agentId,
    provider: params.entry.provider,
    modelId: params.entry.id,
    modelProvider: {
      api: route?.api ?? params.entry.api,
      baseUrl: route?.baseUrl ?? params.entry.baseUrl,
      requestTransportOverrides: route?.requestTransportOverrides,
      runtimePolicy: route?.runtimePolicy,
      preparedAuth: params.evaluation.selectedCredential,
    },
    preparedModelProvider: true,
  };
  const select = () => {
    const { policy } = resolveAgentHarnessAvailabilityDecision({
      ...context,
      mode: "projection",
      agentHarnessRuntimeOverride: params.evaluation.requestedRuntimeId,
    });
    return {
      policy,
      runtime:
        policy.runtime === "auto"
          ? (resolveAutoAgentHarnessId(context) ?? "openclaw")
          : policy.runtime,
    };
  };
  const selected = params.pluginRegistry
    ? withPluginRuntimeRegistryScope(params.pluginRegistry, select)
    : (() => {
        const policy = resolveAgentHarnessPolicy({
          ...context,
          modelApi: context.modelProvider.api,
          modelBaseUrl: context.modelProvider.baseUrl,
          requestTransportOverrides: context.modelProvider.requestTransportOverrides,
        });
        return {
          policy,
          runtime:
            params.evaluation.requestedRuntimeId ??
            (policy.runtime === "auto" ? "openclaw" : policy.runtime),
        };
      })();
  // Route projection must retain the native owner that supplied availability. Recomputing
  // implicit policy from its API-key route alone would relabel that owner as OpenClaw.
  const runtime =
    selected.policy.runtimeSource === "implicit" &&
    !selected.policy.forcedByEnvironment &&
    isDefaultAgentRuntimeId(params.evaluation.requestedRuntimeId)
      ? (params.evaluation.runtimeAuth?.id ?? selected.runtime)
      : selected.runtime;
  if (
    selected.policy.runtime === "auto" &&
    runtime === "openclaw" &&
    !params.evaluation.requestedRuntimeId
  ) {
    return undefined;
  }
  return {
    id: runtime,
    source: selected.policy.runtimeSource ?? "implicit",
  };
}
