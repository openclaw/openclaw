import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listRegisteredAgentHarnesses } from "./registry.js";
import { resolveAgentHarnessSelectionDecision } from "./selection-decision.js";

/** Uses the execution selector so another configured runtime keeps its own login behavior. */
export function resolveAgentHarnessAuthOwnership(params: {
  config?: OpenClawConfig;
  agentId?: string;
  provider: string;
  modelId?: string;
  sessionKey?: string;
  runtimeId?: string;
}): "host" | undefined {
  const hostHarnesses = new Set(
    listRegisteredAgentHarnesses().flatMap(({ harness }) =>
      harness.resolveAuthOwnership?.({
        config: params.config,
        agentId: params.agentId,
        provider: params.provider,
      }) === "host"
        ? [harness]
        : [],
    ),
  );
  if (hostHarnesses.size === 0) {
    return undefined;
  }
  const { runtimeId, ...selectionParams } = params;
  const selection = resolveAgentHarnessSelectionDecision({
    ...selectionParams,
    agentHarnessRuntimeOverride: runtimeId,
  });
  return !selection.builtIn && hostHarnesses.has(selection.harness) ? "host" : undefined;
}
