import { formatErrorMessageForDisplay } from "../../infra/error-diagnostics.js";
import { isCliSessionInvalidatingFailoverReason } from "../cli-session.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner.js";
import { type FailoverError, isFailoverError } from "../failover-error.js";
import { cliBackendLog } from "./log.js";
import type { CliReusableSession, PreparedCliRunContext } from "./types.js";

export type CliRecoveryOptions = {
  timeoutMs?: number;
  forkCliSessionOnResume?: boolean;
  resumeAt?: string;
  onForkSuccessorPersisted?: (sessionId: string) => void;
};

export function resolveCliSessionId(reusableCliSession: CliReusableSession): string | undefined {
  return reusableCliSession.mode === "reuse" || reusableCliSession.mode === "reuse-with-drift"
    ? reusableCliSession.sessionId
    : undefined;
}

const FRESH_SESSION_RECOVERY_CODES: Partial<Record<FailoverError["reason"], string>> = {
  unknown: "cli_unknown_empty_failure",
  empty_response: "cli_unknown_empty_failure",
  format: "cli_synthetic_no_response",
  timeout: "cli_no_output_timeout",
  context_overflow: "cli_context_overflow",
};

function shouldRetryFreshCliSessionAfterFailover(params: {
  error: FailoverError;
  hasHistoryPrompt: boolean;
  recoveryPolicy?: "replace-binding" | "invalidated-only";
}): boolean {
  if (!params.hasHistoryPrompt) {
    return false;
  }
  // Some CLIs can safely replace a resumable conversation after transport or
  // format failures. Backends that cannot must positively prove invalidation.
  if (
    params.recoveryPolicy === "invalidated-only" &&
    !isCliSessionInvalidatingFailoverReason(params.error.reason)
  ) {
    return false;
  }
  const code = FRESH_SESSION_RECOVERY_CODES[params.error.reason];
  return (
    params.error.reason === "session_expired" || (code !== undefined && params.error.code === code)
  );
}

/**
 * Remaining retry budget measured against the run's monotonic anchor. Elapsed
 * monotonic time is fractional, so the result is floored to a whole millisecond:
 * this keeps the retry within the operator-configured budget and satisfies the
 * paired-node remote decoder's `Number.isInteger` timeout contract.
 */
function remainingCliRecoveryBudgetMs(timeoutMs: number, startedMonotonicMs: number): number {
  return Math.floor(timeoutMs - (performance.now() - startedMonotonicMs));
}

export async function runCliRecovery<TAttempt>(params: {
  context: PreparedCliRunContext;
  executeAttempt: (cliSessionIdToUse?: string, options?: CliRecoveryOptions) => Promise<TAttempt>;
  finishAttempt: (
    attempt: TAttempt,
    fallbackCliSessionId?: string,
  ) => Promise<EmbeddedAgentRunResult>;
  finishDeliveredFailure: (
    error: unknown,
    bindingReplacedDuringRun: boolean,
  ) => Promise<EmbeddedAgentRunResult | undefined>;
  onTerminalFailure: (error: unknown) => Promise<void>;
}): Promise<EmbeddedAgentRunResult> {
  const { context } = params;
  const runParams = context.params;
  const reusableCliSessionId = resolveCliSessionId(context.reusableCliSession);
  const resumeCheckpointId = runParams.cliSessionBinding?.resumeCheckpointId;
  let retryableSessionId = reusableCliSessionId;
  const onForkSuccessorPersisted = (sessionId: string) => {
    retryableSessionId = sessionId;
  };
  const failTerminal = async (error: unknown): Promise<never> => {
    // Record only after every eligible recovery path is exhausted.
    cliBackendLog.warn(
      `cli terminal failure: provider=${runParams.provider} model=${context.modelId} durationMs=${Date.now() - context.started} runId=${runParams.runId} error=${formatErrorMessageForDisplay(error)}`,
    );
    await params.onTerminalFailure(error);
    throw error;
  };
  try {
    return await params.finishAttempt(
      await params.executeAttempt(
        reusableCliSessionId,
        runParams.forkCliSessionOnResume ? { onForkSuccessorPersisted } : undefined,
      ),
      reusableCliSessionId,
    );
  } catch (err) {
    const deliveredFailure = await params.finishDeliveredFailure(
      err,
      retryableSessionId !== reusableCliSessionId,
    );
    if (deliveredFailure) {
      return deliveredFailure;
    }
    runParams.assertCurrent?.();
    let recoveryError = err;
    for (const forkResume of [true, false]) {
      if (!isFailoverError(recoveryError) || !retryableSessionId || !runParams.sessionKey) {
        break;
      }
      const prepareRetry = forkResume
        ? runParams.onBeforeForkedCliSessionRetry
        : runParams.onBeforeFreshCliSessionRetry;
      const eligible = forkResume
        ? !runParams.forkCliSessionOnResume &&
          recoveryError.reason === "timeout" &&
          recoveryError.code === "cli_no_output_timeout" &&
          resumeCheckpointId &&
          context.preparedBackend.backend.forkArg &&
          context.preparedBackend.backend.resumeAtArg &&
          prepareRetry
        : shouldRetryFreshCliSessionAfterFailover({
            error: recoveryError,
            hasHistoryPrompt: Boolean(context.openClawHistoryPrompt),
            recoveryPolicy: context.preparedBackend.backend.freshSessionRecovery,
          });
      if (!eligible) {
        continue;
      }
      try {
        const retryTimeoutMs = remainingCliRecoveryBudgetMs(
          runParams.timeoutMs,
          context.startedMonotonicMs,
        );
        if (retryTimeoutMs <= 0) {
          throw recoveryError;
        }
        if (
          prepareRetry &&
          !(await prepareRetry.call(runParams, {
            provider: runParams.provider,
            reason: recoveryError.reason,
            sessionId: retryableSessionId,
          }))
        ) {
          throw recoveryError;
        }
        cliBackendLog.warn(
          `cli session recovery ${forkResume ? "fork" : "retry"}: provider=${runParams.provider} reason=${recoveryError.reason} sessionKey=${runParams.sessionKey}`,
        );
        return await params.finishAttempt(
          await params.executeAttempt(forkResume ? retryableSessionId : undefined, {
            timeoutMs: retryTimeoutMs,
            forkCliSessionOnResume: forkResume,
            ...(forkResume ? { resumeAt: resumeCheckpointId, onForkSuccessorPersisted } : {}),
          }),
        );
      } catch (retryError) {
        const deliveredRetryFailure = await params.finishDeliveredFailure(
          retryError,
          retryableSessionId !== reusableCliSessionId,
        );
        if (deliveredRetryFailure) {
          return deliveredRetryFailure;
        }
        if (!forkResume) {
          return await failTerminal(retryError);
        }
        runParams.assertCurrent?.();
        recoveryError =
          isFailoverError(retryError) && retryError.code === "cli_resume_at_unsupported"
            ? err
            : retryError;
      }
    }
    return await failTerminal(recoveryError);
  }
}
