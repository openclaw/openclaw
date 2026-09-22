import type { QuotaContinuation } from "../quota-continuation.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./internal-params.js";
import { claimQuotaRunParams } from "./loop-initial-policy.js";
import { measureEmbeddedAgentPreparation } from "./preparation-timing.js";
import { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";

/** Preserve the existing measured runtime preparation at the loop owner boundary. */
export async function prepareLoopRuntime(
  params: RunEmbeddedAgentParamsWithSessionFile,
  input: PreparedEmbeddedRunInput,
  provider: string,
  modelId: string,
  quotaContinuation?: QuotaContinuation,
) {
  const runtime = await measureEmbeddedAgentPreparation(
    "runtime",
    () =>
      prepareEmbeddedRunRuntime({
        assertCurrent: input.laneController.throwIfAborted,
        runParams: params,
        sessionAdmission: input.sessionAdmission,
        provider,
        modelId,
        agentDir: input.agentDir,
        workspaceDir: input.workspaceDir,
        globalLane: input.globalLane,
        hookRunner: input.hookRunner,
        hookContext: input.hookContext,
        markStartupStage: (stage) => input.startupStages.mark(stage),
        notifyExecutionPhase: input.progressController.notifyExecutionPhase,
        fallbackConfigured: input.fallbackConfigured,
        preparedModelRuntime: input.preparedModelRuntime,
      }),
    { config: params.config },
  );
  try {
    const snapshot = runtime.snapshot();
    const runParams = await claimQuotaRunParams(
      { ...params, admittedRunContext: runtime.admittedRunContext },
      quotaContinuation,
      snapshot.agentHarness.id,
      snapshot.effectiveModel.api,
    );
    return { ...runtime, runParams };
  } catch (error) {
    // A rejected continuation never enters the loop's settlement owner.
    runtime.stopRuntimeAuthRefreshTimer();
    throw error;
  }
}
