import {
  runBoundedCoordinationBuildLoop,
  type CoordinationBoundedBuildLoopResult,
  type CoordinationPlannedStep,
  type CoordinationStepExecutionResult,
} from "./bounded-build-loop-runner.js";
import {
  writeCoordinationFinalDebrief,
  type CoordinationFinalDebrief,
  type CoordinationFinalDebriefWriteResult,
} from "./final-debrief-writer.js";
import type { CoordinationWatchdogRunnerOutput } from "./watchdog-runner.js";
import { runCoordinationWatchdog } from "./watchdog-runner.js";
import type { CoordinationWorkAuthorizationContract } from "./work-authorization-contract.js";

export type CoordinationAuthorizationBridgeStep = CoordinationPlannedStep & {
  kind: "ordinary" | "watchdog";
  execute?: () => Promise<CoordinationStepExecutionResult>;
  watchdogInput?: {
    jobContractInput: unknown;
    jobPath: string;
    useSafeProbeExecutionAdapter: true;
    persistResult: true;
  };
};

export type CoordinationAuthorizationBridgeResult = {
  loopResult: CoordinationBoundedBuildLoopResult;
  finalDebrief: CoordinationFinalDebrief;
  finalDebriefWrite: CoordinationFinalDebriefWriteResult;
  watchdogRuns: CoordinationWatchdogRunnerOutput[];
};

export class CoordinationAuthorizationBridgeError extends Error {
  readonly code:
    | "missing_step_executor"
    | "watchdog_step_missing_input"
    | "watchdog_step_requires_safe_probe_adapter"
    | "watchdog_step_requires_persist_result";

  constructor(code: CoordinationAuthorizationBridgeError["code"], message: string) {
    super(message);
    this.name = "CoordinationAuthorizationBridgeError";
    this.code = code;
  }
}

export async function runAuthorizationLoopWatchdogBridge(input: {
  authorization: CoordinationWorkAuthorizationContract;
  steps: CoordinationAuthorizationBridgeStep[];
  proofAttemptId: string;
  runWatchdog?: typeof runCoordinationWatchdog;
  writeFinalDebrief?: typeof writeCoordinationFinalDebrief;
  actualPercentCompleteOnReady?: number;
}): Promise<CoordinationAuthorizationBridgeResult> {
  if (!input.proofAttemptId?.trim()) {
    throw new Error("proofAttemptId is required");
  }
  if (input.steps.some((step) => step.proof_attempt_id !== input.proofAttemptId)) {
    throw new Error("proofAttemptId mismatch across planned steps");
  }

  const watchdogRuns: CoordinationWatchdogRunnerOutput[] = [];
  const runWatchdog = input.runWatchdog ?? runCoordinationWatchdog;
  const writeFinalDebrief = input.writeFinalDebrief ?? writeCoordinationFinalDebrief;
  const startedAt = new Date().toISOString();

  const loopResult = await runBoundedCoordinationBuildLoop({
    authorization: input.authorization,
    plannedSteps: input.steps,
    executeStep: async (step) => {
      const bridgeStep = input.steps.find((candidate) => candidate.step_id === step.step_id);
      if (!bridgeStep) {
        throw new CoordinationAuthorizationBridgeError(
          "missing_step_executor",
          `No bridge step found for ${step.step_id}`,
        );
      }

      if (bridgeStep.kind === "ordinary") {
        if (!bridgeStep.execute) {
          throw new CoordinationAuthorizationBridgeError(
            "missing_step_executor",
            `Ordinary step ${step.step_id} requires an execute function`,
          );
        }
        return bridgeStep.execute();
      }

      if (!bridgeStep.watchdogInput) {
        throw new CoordinationAuthorizationBridgeError(
          "watchdog_step_missing_input",
          `Watchdog step ${step.step_id} requires explicit watchdog input`,
        );
      }
      if (!bridgeStep.watchdogInput.useSafeProbeExecutionAdapter) {
        throw new CoordinationAuthorizationBridgeError(
          "watchdog_step_requires_safe_probe_adapter",
          `Watchdog step ${step.step_id} must explicitly set useSafeProbeExecutionAdapter: true`,
        );
      }
      if (!bridgeStep.watchdogInput.persistResult) {
        throw new CoordinationAuthorizationBridgeError(
          "watchdog_step_requires_persist_result",
          `Watchdog step ${step.step_id} must explicitly set persistResult: true`,
        );
      }

      const watchdogResult = await runWatchdog(bridgeStep.watchdogInput);
      watchdogRuns.push(watchdogResult);

      return {
        step_id: bridgeStep.step_id,
        proof_attempt_id: bridgeStep.proof_attempt_id,
        step_name: bridgeStep.step_name,
        status: watchdogResult.result.status,
        files_changed: [],
        commands_run: [],
        tests_run: [],
        artifacts_written: watchdogResult.resultWrite?.resultPath
          ? [watchdogResult.resultWrite.resultPath]
          : [],
        scope_check: {
          used_structured_watchdog_interface: true,
          used_safe_probe_execution_adapter: true,
          persisted_watchdog_result: true,
        },
        proof_summary: watchdogResult.result.human_summary,
        blocker_reason:
          watchdogResult.result.status === "pass"
            ? null
            : watchdogResult.result.classification_reason,
        next_step_recommendation:
          watchdogResult.result.status === "pass" ? "continue_authorized_sequence" : null,
      };
    },
  });

  const finishedAt = new Date().toISOString();
  const finalStatus = loopResult.status === "pass" ? "ready_for_live_proof" : loopResult.status;
  const finalDebrief: CoordinationFinalDebrief = {
    schema_version: "v1",
    authorization_id: input.authorization.authorization_id,
    proof_attempt_id: input.proofAttemptId,
    objective_name: input.authorization.objective_name,
    status: finalStatus,
    started_at: startedAt,
    finished_at: finishedAt,
    steps_attempted: loopResult.steps_attempted,
    steps_completed: loopResult.steps_completed,
    step_artifacts: loopResult.step_artifacts.map((artifact) => artifact.resultPath),
    watchdog_result_paths: watchdogRuns
      .map((run) => run.resultWrite?.resultPath)
      .filter((value): value is string => typeof value === "string"),
    files_changed_summary: [],
    tests_run_summary: [],
    proof_summary:
      finalStatus === "ready_for_live_proof"
        ? "Authorization-layer proof sequence completed; next correct action is explicit live-proof approval."
        : loopResult.stop_reason,
    blocker_reason: finalStatus === "ready_for_live_proof" ? null : loopResult.stop_reason,
    next_required_action:
      finalStatus === "ready_for_live_proof"
        ? "Request explicit live proof approval"
        : loopResult.next_step_recommendation,
    actual_percent_complete:
      finalStatus === "ready_for_live_proof" ? (input.actualPercentCompleteOnReady ?? 88) : 80,
    human_summary:
      finalStatus === "ready_for_live_proof"
        ? "Authorization-layer bridge is complete enough for explicit live-proof approval."
        : `Authorization-layer bridge stopped with status ${finalStatus}.`,
  };

  const finalDebriefWrite = await writeFinalDebrief(input.authorization, finalDebrief);

  return {
    loopResult,
    finalDebrief,
    finalDebriefWrite,
    watchdogRuns,
  };
}
