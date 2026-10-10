/** Owns one durable trajectory across CLI recovery and final settlement. */
import { isAbortError } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { buildTrajectoryRunMetadata } from "../../trajectory/metadata.js";
import { createTrajectoryRuntimeRecorder } from "../../trajectory/runtime.js";
import type { CliOutput } from "../cli-output-contracts.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner.js";
import { isFailoverError, isSignalTimeoutReason } from "../failover-error.js";
import { runAgentCleanupStep } from "../run-cleanup-timeout.js";
import { settlePreparedCliRun } from "./cli-run-settlement.js";
import { cliBackendLog } from "./log.js";
import type { ClaudeCliRunDiagnosticLifecycle } from "./run-diagnostics.js";
import type { PreparedCliRunContext } from "./types.js";

type CliTrajectoryRecorder = NonNullable<
  Awaited<ReturnType<typeof createTrajectoryRuntimeRecorder>>
>;
type CliTrajectoryEventRecorder = PreparedCliRunContext["trajectoryRecorder"];
type PreparedCliRunner = (
  context: PreparedCliRunContext,
  diagnosticLifecycle?: ClaudeCliRunDiagnosticLifecycle,
) => Promise<EmbeddedAgentRunResult>;

export function recordCliTrajectoryEvent(
  recorder: CliTrajectoryEventRecorder,
  type: string,
  data?: Record<string, unknown>,
): void {
  try {
    recorder?.recordEvent(type, data);
  } catch (error) {
    cliBackendLog.warn(
      `cli trajectory event failed: type=${type} error=${formatErrorMessage(error)}`,
    );
  }
}

export function recordCliModelCompleted(
  recorder: CliTrajectoryEventRecorder,
  output: CliOutput,
): void {
  recordCliTrajectoryEvent(recorder, "model.completed", {
    assistantTexts: output.text ? [output.text] : [],
    usage: output.usage,
    finalPromptText: output.finalPromptText,
    stopReason: output.terminalInterruption?.reason ?? (output.yielded ? "end_turn" : "completed"),
  });
}

async function prepareCliTrajectory(
  context: PreparedCliRunContext,
): Promise<CliTrajectoryRecorder | null> {
  // Caller-owned helpers and control commands keep their own lifecycle.
  const { params } = context;
  if (params.isolatedCompletion || params.controlOperation || params.sessionManager) {
    return null;
  }
  const recorder = await createTrajectoryRuntimeRecorder({
    cfg: params.config,
    env: process.env,
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
    sessionTarget: params.sessionTarget,
    provider: params.provider,
    modelId: context.modelId,
    workspaceDir: context.workspaceDir,
  });
  if (!recorder) {
    return null;
  }
  recordCliTrajectoryEvent(recorder, "session.started", {
    trigger: params.trigger,
    sessionFile: params.sessionFile,
    workspaceDir: context.workspaceDir,
    agentId: params.agentId,
    messageProvider: params.messageProvider,
    messageChannel: params.messageChannel,
  });
  const fastMode = typeof params.fastMode === "boolean" ? params.fastMode : undefined;
  recordCliTrajectoryEvent(
    recorder,
    "trace.metadata",
    buildTrajectoryRunMetadata({
      env: process.env,
      config: params.config,
      workspaceDir: context.workspaceDir,
      sessionFile: params.sessionFile,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      trigger: params.trigger,
      messageProvider: params.messageProvider,
      messageChannel: params.messageChannel,
      provider: params.provider,
      modelId: context.modelId,
      timeoutMs: params.timeoutMs,
      fastMode,
      thinkLevel: params.thinkLevel,
      skillsSnapshot: params.skillsSnapshot,
      systemPromptReport: context.systemPromptReport,
    }),
  );
  return recorder;
}

function recordCliSessionEnded(params: {
  recorder: CliTrajectoryRecorder;
  context: PreparedCliRunContext;
  result: EmbeddedAgentRunResult | undefined;
  failed: boolean;
  runError: unknown;
}): void {
  const { context, failed, recorder, result, runError } = params;
  const stopReason = result?.meta.completion?.stopReason ?? result?.meta.stopReason;
  const timedOut =
    stopReason === "timeout" ||
    (isFailoverError(runError) && runError.reason === "timeout") ||
    (failed &&
      context.params.abortSignal?.aborted === true &&
      isSignalTimeoutReason(context.params.abortSignal.reason));
  const aborted = result?.meta.aborted === true || isAbortError(runError);
  const terminalAttempt = result?.meta.executionTrace?.attempts?.at(-1);
  const status =
    timedOut || aborted
      ? "interrupted"
      : failed || result?.meta.error || terminalAttempt?.result === "error"
        ? "error"
        : "success";
  const promptError = failed ? formatErrorMessage(runError) : undefined;
  const terminalError =
    result?.meta.error?.message ?? (status === "error" ? terminalAttempt?.reason : undefined);
  recordCliTrajectoryEvent(recorder, "session.ended", {
    status,
    aborted,
    timedOut,
    ...(stopReason ? { stopReason } : {}),
    ...(promptError ? { promptError } : {}),
    ...(terminalError ? { terminalError } : {}),
  });
}

async function withCliRunTrajectory(
  context: PreparedCliRunContext,
  run: () => Promise<EmbeddedAgentRunResult>,
): Promise<EmbeddedAgentRunResult> {
  let recorder: CliTrajectoryRecorder | null = null;
  try {
    recorder = await prepareCliTrajectory(context);
  } catch (error) {
    // Observability setup must not prevent the prepared backend from reaching cleanup.
    cliBackendLog.warn(`cli trajectory setup failed: ${formatErrorMessage(error)}`);
  }
  if (recorder) {
    context.trajectoryRecorder = recorder;
  }
  let result: EmbeddedAgentRunResult | undefined;
  let failed = false;
  let runError: unknown;
  try {
    result = await run();
    return result;
  } catch (error) {
    failed = true;
    runError = error;
    throw error;
  } finally {
    const activeRecorder = recorder;
    try {
      if (activeRecorder) {
        recordCliSessionEnded({ recorder: activeRecorder, context, result, failed, runError });
        await runAgentCleanupStep({
          runId: context.params.runId,
          sessionId: context.params.sessionId,
          step: "openclaw-trajectory-flush",
          log: cliBackendLog,
          getTimeoutDetails: () => {
            try {
              return activeRecorder.describeFlushState();
            } catch (error) {
              return formatErrorMessage(error);
            }
          },
          cleanup: () => activeRecorder.flush(),
        });
      }
    } finally {
      delete context.trajectoryRecorder;
    }
  }
}

/** Settles a prepared CLI run and flushes its trajectory after the terminal outcome. */
export async function settlePreparedCliRunWithTrajectory(
  context: PreparedCliRunContext,
  diagnosticLifecycle: ClaudeCliRunDiagnosticLifecycle | undefined,
  runPrepared: PreparedCliRunner,
): Promise<EmbeddedAgentRunResult> {
  return await withCliRunTrajectory(context, () =>
    settlePreparedCliRun({
      context,
      diagnosticLifecycle,
      run: async () => await runPrepared(context, diagnosticLifecycle),
    }),
  );
}
