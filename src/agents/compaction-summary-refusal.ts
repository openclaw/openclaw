import { isProviderRefusalAssistantError } from "@openclaw/llm-core/diagnostics";
import {
  compactWithoutSummary,
  type CompactionPreparation,
} from "../../packages/agent-core/src/harness/compaction/compaction.js";
import { isSummaryProviderError } from "../../packages/agent-core/src/harness/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { setCompactionSafeguardCancellation } from "./agent-hooks/compaction-safeguard-runtime.js";

const log = createSubsystemLogger("compaction-safeguard");

/** Summary wrappers retain the provider response as their cause. */
export function isCompactionSummaryRefusal(error: unknown): boolean {
  let cause = error;
  while (cause instanceof Error) {
    if (isSummaryProviderError(cause)) {
      return isProviderRefusalAssistantError(cause.response);
    }
    cause = cause.cause;
  }
  return false;
}

/** Keep the prepared recent tail without asking another model to override a refusal. */
export function compactAfterSummaryRefusal(preparation: CompactionPreparation) {
  const result = compactWithoutSummary(preparation);
  if (!result.ok) {
    throw new Error(
      "The summarizer refused, and recent context could not fit without a summary. " +
        "Use /new and resend essential context, or reduce the pending request.",
      { cause: result.error },
    );
  }
  return {
    ...result.value,
    details: {
      ...result.value.details,
      qualityDegraded: true as const,
      summaryRefused: true as const,
    },
  };
}

/** Hook errors must remain cancellations: throwing would invoke the raw core summarizer. */
export function recoverCompactionSafeguardFailure(
  error: unknown,
  preparation: CompactionPreparation,
  signal: AbortSignal,
  sessionManager: unknown,
) {
  signal.throwIfAborted();
  if (isCompactionSummaryRefusal(error)) {
    try {
      return { compaction: compactAfterSummaryRefusal(preparation) };
    } catch (recoveryError) {
      setCompactionSafeguardCancellation(
        sessionManager,
        formatErrorMessage(recoveryError),
        recoveryError,
      );
      return { cancel: true as const };
    }
  }
  log.warn("Compaction summarization failed; cancelling compaction to preserve history.");
  setCompactionSafeguardCancellation(
    sessionManager,
    `Compaction safeguard could not summarize the session: ${formatErrorMessage(error)}`,
    error,
  );
  return { cancel: true as const };
}
