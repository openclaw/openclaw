/** Lightweight runtime availability shared by execution and next-turn projections. */
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import { resolveAgentHarnessPolicy, type AgentHarnessPolicy } from "./policy.js";
import { getRegisteredAgentHarness } from "./registry.js";
import { resolveAgentHarnessSupport } from "./route-support.js";
import { buildAgentHarnessSupportContext } from "./support.js";
import type { AgentHarness, AgentHarnessSupport, AgentHarnessSupportContext } from "./types.js";

type AgentHarnessAvailabilityParams = Parameters<typeof resolveAgentHarnessPolicy>[0] & {
  modelProvider?: AgentHarnessSupportContext["modelProvider"];
  /** Projection can inspect loaded support, but absence before registration is not a fallback. */
  mode?: "execution" | "projection";
  agentHarnessId?: string;
  agentHarnessRuntimeOverride?: string;
  preparedModelProvider?: boolean;
  preparedPolicy?: AgentHarnessPolicy;
  withRegistryScope?: <T>(run: () => T) => T;
  /** Warm the registered harness's context before consulting live support. */
  prepareOnly?: boolean;
  resolveSupportContext?: (params: {
    provider: string;
    requestedRuntime: AgentHarnessSupportContext["requestedRuntime"];
    contextManagement?: AgentHarness["contextManagement"];
  }) => AgentHarnessSupportContext;
  /** Execution supplies ownership lazily; read-only projections never discover plugins. */
  resolveProviderOwnership?: () => Parameters<
    typeof buildAgentHarnessSupportContext
  >[0]["providerOwnership"];
};

type AgentHarnessAvailabilityDecision = {
  kind: "available" | "implicit-unavailable" | "implicit-unsupported" | "declared-fallback";
  policy: AgentHarnessPolicy;
  /** Reuse the exact support decision during execution, without another probe. */
  support?: AgentHarnessSupport;
};

export function resolveAvailableAgentHarnessPolicy(
  params: AgentHarnessAvailabilityParams,
): AgentHarnessPolicy {
  return resolveAgentHarnessAvailabilityDecision(params).policy;
}

export function resolveAgentHarnessAvailabilityDecision(
  params: AgentHarnessAvailabilityParams,
): AgentHarnessAvailabilityDecision {
  const configured =
    params.preparedPolicy ??
    resolveAgentHarnessPolicy({
      ...params,
      modelApi: params.modelProvider?.api ?? params.modelApi,
      modelBaseUrl: params.modelProvider?.baseUrl ?? params.modelBaseUrl,
      requestTransportOverrides:
        params.modelProvider?.requestTransportOverrides ?? params.requestTransportOverrides,
    });
  const pinnedHarnessId = normalizeOptionalAgentRuntimeId(params.agentHarnessId);
  const runtimeOverride =
    pinnedHarnessId ?? normalizeOptionalAgentRuntimeId(params.agentHarnessRuntimeOverride);
  const policy: AgentHarnessPolicy =
    runtimeOverride && !isDefaultAgentRuntimeId(runtimeOverride)
      ? { ...configured, runtime: runtimeOverride, runtimeSource: "model" }
      : configured;
  const implicit = policy.runtime === "codex" && policy.runtimeSource === "implicit";
  if (policy.runtime === "auto" || policy.runtime === "openclaw") {
    return { kind: "available", policy };
  }
  const evaluateRegistered = (): AgentHarnessAvailabilityDecision => {
    const registered = getRegisteredAgentHarness(policy.runtime);
    if (!registered) {
      return implicit && params.mode !== "projection"
        ? { kind: "implicit-unavailable", policy: { ...policy, runtime: "openclaw" } }
        : { kind: "available", policy };
    }
    // A pinned native transcript owns early selection. Final prepared routes must
    // revalidate that owner; historical producer metadata is not a next-turn pin.
    const pinnedOwner = pinnedHarnessId === policy.runtime && !params.preparedModelProvider;
    if (pinnedOwner || params.provider === undefined) {
      return { kind: "available", policy };
    }
    const { harness } = registered;
    const contextParams = {
      provider: params.provider.trim(),
      requestedRuntime: policy.runtime,
      contextManagement: harness.contextManagement,
    };
    const context = params.resolveSupportContext
      ? params.resolveSupportContext(contextParams)
      : buildAgentHarnessSupportContext({
          ...params,
          ...contextParams,
          providerOwnership: params.resolveProviderOwnership?.(),
        });
    if (params.prepareOnly) {
      return { kind: "available", policy };
    }
    const support = resolveAgentHarnessSupport(harness, context, params.mode === "projection");
    if (!support.supported && !policy.forcedByEnvironment) {
      if (implicit || support.fallbackRuntime === "openclaw") {
        return {
          kind: implicit ? "implicit-unsupported" : "declared-fallback",
          policy: { ...policy, runtime: "openclaw" },
          support,
        };
      }
    }
    return { kind: "available", policy, support };
  };
  return params.withRegistryScope
    ? params.withRegistryScope(evaluateRegistered)
    : evaluateRegistered();
}
