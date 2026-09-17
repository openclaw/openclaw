// Releases a prepared CLI backend with the run's real settlement. Node computer
// executions keep their artifacts only for `completion`, so the outcome handed
// to cleanup is derived from how the run actually ended.
import type { McpLoopbackClientGrantCloseReason } from "../../gateway/mcp-grant-store.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner/types.js";
import { runCliCleanup } from "./cleanup.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

/**
 * Maps how the run ended onto the settlement its prepared resources close with.
 * A result that carries an abort or timeout stop is an interruption, not a
 * completion, even though partial output was delivered.
 */
function resolveCliRunCleanupOutcome(params: {
  runFailed: boolean;
  runError: unknown;
  runResult?: Pick<EmbeddedAgentRunResult, "meta">;
  abortSignal?: AbortSignal;
}): McpLoopbackClientGrantCloseReason {
  if (params.runFailed) {
    if (params.abortSignal?.aborted) {
      return "cancel";
    }
    const error = params.runError;
    const reason =
      typeof error === "object" && error !== null && "reason" in error ? error.reason : undefined;
    return reason === "timeout" ? "timeout" : "error";
  }
  // A returned result can still be a failure: a delivered-failure or blocked run
  // settles as a result so the user keeps what was sent, but its stop reason
  // records the error and its node artifacts must not be kept as a success.
  const meta = params.runResult?.meta;
  const stopReason = meta && "stopReason" in meta ? meta.stopReason : undefined;
  if (stopReason === "timeout") {
    return "timeout";
  }
  if (meta?.aborted || stopReason === "aborted" || params.abortSignal?.aborted) {
    return "cancel";
  }
  if (stopReason === "error" || stopReason === "blocked") {
    return "error";
  }
  return "completion";
}

/** Releases the prepared backend; a cleanup failure is returned so settlement can weigh it. */
export async function releasePreparedCliBackend(input: {
  context: PreparedCliRunContext;
  params: Pick<RunCliAgentParams, "runId" | "sessionId" | "oneShotCliRun" | "abortSignal">;
  runFailed: boolean;
  runError: unknown;
  runResult?: Pick<EmbeddedAgentRunResult, "meta">;
}): Promise<Error | undefined> {
  const outcome = resolveCliRunCleanupOutcome({
    runFailed: input.runFailed,
    runError: input.runError,
    runResult: input.runResult,
    abortSignal: input.params.abortSignal,
  });
  try {
    await runCliCleanup(input.params, "cli-backend-release", async () => {
      await input.context.preparedBackend.cleanup?.(outcome);
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
