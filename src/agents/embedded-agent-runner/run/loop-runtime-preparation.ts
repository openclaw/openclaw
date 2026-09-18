import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";
import { measureEmbeddedAgentPreparation } from "./preparation-timing.js";
import { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";

/** Preserve the existing measured runtime preparation at the loop owner boundary. */
export function prepareLoopRuntime(
  params: RunEmbeddedAgentInternalParams,
  input: PreparedEmbeddedRunInput,
  provider: string,
  modelId: string,
) {
  return measureEmbeddedAgentPreparation(
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
}
