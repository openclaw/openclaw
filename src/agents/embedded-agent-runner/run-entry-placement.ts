import { assertRequiredWorkerSelection } from "../../config/required-worker-profile.js";
import { resolveAgentHarnessPolicy } from "../harness/policy.js";
import {
  prepareRequiredSessionPlacement,
  resolveSessionPlacementRuntimeOverride,
} from "../session-placement-admission.js";
import type { runEmbeddedAgentEntry } from "./run-entry.js";

/** Prepare placement once, then retain its runtime selection across fallback candidates. */
export async function prepareRunEntryPlacement(
  params: Pick<
    Parameters<typeof runEmbeddedAgentEntry>[0],
    "selection" | "identity" | "harness" | "preparedRunAdmission" | "abortSignal"
  >,
) {
  assertRequiredWorkerSelection(params.selection.cfg, {
    agentRuntime: params.harness.resolveRuntimeOverride(
      params.selection.provider,
      params.selection.model,
    ),
  });
  await prepareRequiredSessionPlacement(params.identity, {
    config: params.selection.cfg,
    assertCurrent: () => params.preparedRunAdmission?.assertSourceCurrent(),
    signal: params.abortSignal,
  });
  const placementRuntime = resolveSessionPlacementRuntimeOverride(params.identity);
  return (provider: string, model: string) => {
    const requestedRuntime = params.harness.resolveRuntimeOverride(provider, model);
    assertRequiredWorkerSelection(params.selection.cfg, { agentRuntime: requestedRuntime });
    if (params.selection.cfg.cloudWorkers?.requiredProfile) {
      return "openclaw";
    }
    if (requestedRuntime || !placementRuntime) {
      return requestedRuntime;
    }
    const policy = resolveAgentHarnessPolicy({
      config: params.selection.cfg,
      provider,
      modelId: model,
      agentId: params.identity.agentId,
      sessionKey: params.harness.sessionKey,
    });
    // Explicit runtime choices still reach placement's compatibility check.
    return policy.runtimeSource === "implicit" ? placementRuntime : undefined;
  };
}
