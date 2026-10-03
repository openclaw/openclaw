/**
 * Chunk summarization retry policy.
 *
 * Orthogonal guards (each blocks retry on its own error class):
 * - Caller signal aborted — terminal, do not retry.
 * - SummaryOutputBudgetError — output budget exhausted without visible text (#160650).
 * - Likely context overflow — input-side overflow, retrying same request is wasteful.
 * - Provider-side AbortError (without caller cancellation) remains retryable;
 *   transport timeouts are terminal.
 */
import { SummaryOutputBudgetError } from "../../packages/agent-core/src/harness/types.js";
import { isAbortError } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isTimeoutError } from "./failover-error.js";
import { isLikelyContextOverflowError } from "./failover/context-overflow.js";

export function shouldRetryCompactionChunkError(err: unknown, signalAborted: boolean): boolean {
  return (
    !signalAborted &&
    !(err instanceof SummaryOutputBudgetError) &&
    !isLikelyContextOverflowError(formatErrorMessage(err)) &&
    (isAbortError(err) || !isTimeoutError(err))
  );
}
