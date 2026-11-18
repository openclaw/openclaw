import { isProviderRefusalAssistantError } from "@openclaw/llm-core/diagnostics";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  compactWithoutSummary,
  type CompactionPreparation,
} from "../../packages/agent-core/src/harness/compaction/compaction.js";
import { isSummaryProviderError } from "../../packages/agent-core/src/harness/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getCompactionSafeguardRuntime,
  setCompactionSafeguardCancellation,
} from "./agent-hooks/compaction-safeguard-runtime.js";
import { createSessionManagerRuntimeRegistry } from "./agent-hooks/session-manager-runtime-registry.js";
import { describeCompactionFailure } from "./embedded-agent-runner/compact-reasons.js";

const log = createSubsystemLogger("compaction-safeguard");

/** A transcript custom entry: persisted and readable, never projected into model context. */
const COMPACTION_ATTEMPT_CUSTOM_TYPE = "openclaw.compaction-attempt";
type CompactionAttempt = {
  /** `refusal`, the provider failover class (timeout, overloaded, format...), or `unknown`. */
  failure: string;
  /** The pending request needed this compaction (a required preflight). */
  required: boolean;
  tokensBefore: number;
  outcome: "cancelled" | "floor";
};

/**
 * How one compaction attempt treats a summary refusal. Unset keeps the refusal floor in place.
 * - `defer`: fail the attempt so the route owner can retry the summary on another route.
 * - `fallback`: that retry; fail on refusal too and record its route on the committed summary.
 * - `floor`: every summary route refused or failed; commit the refusal floor without a model call.
 */
export type CompactionSummaryRefusalMode = "defer" | "fallback" | "floor";

const refusalModes = createSessionManagerRuntimeRegistry<CompactionSummaryRefusalMode>();

export const setCompactionSummaryRefusalMode = (
  sessionManager: unknown,
  mode: CompactionSummaryRefusalMode | undefined,
) => refusalModes.set(sessionManager, mode ?? null);

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

/** Keep the prepared recent tail, unless the route owner retries the refusal on another route. */
function compactAfterSummaryRefusal(
  preparation: CompactionPreparation,
  sessionManager: unknown,
  refusal: unknown,
) {
  const mode = refusalModes.get(sessionManager);
  if (mode === "defer" || mode === "fallback") {
    throw refusal;
  }
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

/** Commits a summaryless boundary; the refusal floor keeps its refusal provenance. */
export function compactWithoutNewSummary(
  preparation: CompactionPreparation,
  sessionManager: unknown,
) {
  if (refusalModes.get(sessionManager) === "floor") {
    return compactAfterSummaryRefusal(preparation, sessionManager, undefined);
  }
  const result = compactWithoutSummary(preparation);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/** Refusals take the refusal path; other summary failures stay failures. */
export function settleCompactionSummary<T>(
  result: { ok: true; value: T } | { ok: false; error: Error },
  preparation: CompactionPreparation,
  sessionManager: unknown,
) {
  if (result.ok) {
    return result.value;
  }
  if (!isCompactionSummaryRefusal(result.error)) {
    throw result.error;
  }
  return compactAfterSummaryRefusal(preparation, sessionManager, result.error);
}

/** A fallback-route summary records the route that wrote it. */
export function withCompactionSummaryRoute<T extends { details?: unknown }>(
  result: T,
  sessionManager: unknown,
  model: { provider: string; id: string },
  withoutSummary: boolean,
): T {
  if (withoutSummary || refusalModes.get(sessionManager) !== "fallback") {
    return result;
  }
  const summaryRoute = `${model.provider}/${model.id}`;
  return { ...result, details: { ...asOptionalRecord(result.details), summaryRoute } };
}

/**
 * Settles a safeguard cancellation and records the attempt. A non-refusal failure of a required
 * compaction commits the floor, because the pending request cannot run until history shrinks;
 * otherwise history is kept. Streak and overflow escalation wait on the recorded attempt rate.
 * Caller aborts never escalate. Cancels from other hooks record no safeguard cancellation and
 * stay intentional declines.
 */
export async function settleCompactionSafeguardCancellation(
  sessionManager: {
    appendCustomEntryAsync(customType: string, data: CompactionAttempt): Promise<string>;
  },
  preparation: CompactionPreparation,
  request: { signal: AbortSignal; requestRequiresCompaction?: true },
) {
  const cancellation = getCompactionSafeguardRuntime(sessionManager)?.cancellation;
  if (!cancellation || request.signal.aborted) {
    return undefined;
  }
  // The owner's fact, not an estimate: a required preflight cannot run its pending request.
  const required = request.requestRequiresCompaction === true;
  const refused = isCompactionSummaryRefusal(cancellation.error);
  const floor = !refused && required ? compactWithoutSummary(preparation) : undefined;
  // Best effort: a lost row hides one failure from the attempt rate.
  await sessionManager
    .appendCustomEntryAsync(COMPACTION_ATTEMPT_CUSTOM_TYPE, {
      failure: refused
        ? "refusal"
        : (describeCompactionFailure(cancellation.error).reason ?? "unknown"),
      required,
      tokensBefore: preparation.tokensBefore,
      outcome: floor?.ok ? "floor" : "cancelled",
    })
    .catch((error: unknown) => {
      log.warn(`Compaction attempt was not recorded: ${formatErrorMessage(error)}`);
    });
  if (!floor?.ok) {
    return undefined;
  }
  log.warn(
    "Compaction summarization failed while a pending request needs room; committing the floor without a summary.",
  );
  setCompactionSafeguardCancellation(sessionManager, undefined);
  return { ...floor.value, details: { ...floor.value.details, qualityDegraded: true as const } };
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
      return { compaction: compactAfterSummaryRefusal(preparation, sessionManager, error) };
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
