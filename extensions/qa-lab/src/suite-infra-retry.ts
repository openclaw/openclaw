import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { combineQaSuiteErrors, isQaSuiteInfraRetryableError } from "./errors.js";

export const QA_SUITE_INFRA_RETRY_LIMIT = 1;

export async function runQaSuiteWithInfraRetry<Result>(
  run: (attempt: number) => Promise<Result>,
  maxRetries = QA_SUITE_INFRA_RETRY_LIMIT,
  signal?: AbortSignal,
  options?: {
    canRetry?: () => boolean;
    onAttemptFailure?: (error: unknown, final: boolean) => void;
  },
) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // The first invocation must establish its evidence owner even after an
    // accepted run is cancelled. Later attempts must not reopen admission.
    if (attempt > 0) {
      signal?.throwIfAborted();
    }
    try {
      return await run(attempt);
    } catch (error) {
      const retry =
        !signal?.aborted &&
        isQaSuiteInfraRetryableError(error) &&
        attempt < maxRetries &&
        options?.canRetry?.() !== false;
      // Retry admission and evidence selection share one synchronous decision;
      // a sibling cleanup failure must not leave this attempt nonterminal.
      try {
        options?.onAttemptFailure?.(error, !retry);
      } catch (recordError) {
        throw combineQaSuiteErrors(
          [error, recordError],
          "QA attempt and failure recording failed",
          { cause: error },
        );
      }
      if (!retry) {
        throw error;
      }
      process.stderr.write(
        `[qa-suite] infra retry ${attempt + 1}/${maxRetries}: ${formatErrorMessage(error)}\n`,
      );
    }
  }
  throw new Error("unreachable qa suite retry state");
}
