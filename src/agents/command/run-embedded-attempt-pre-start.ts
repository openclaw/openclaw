import { isCompletionReportInputProvenance } from "../../sessions/input-provenance.js";
import { LiveSessionModelSwitchError } from "../live-model-switch.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "../prepared-model-runtime.errors.js";
import type { RunEmbeddedAgentAttemptParams } from "./run-embedded-attempt.types.js";

/**
 * A turn that never started showed the user nothing. A delivered subagent completion turn reports
 * every pre-start failure, on any fallback candidate; any delivered turn reports a runtime
 * admission refusal. A live model switch still retries; other chat failures keep their surfaces.
 */
export function shouldReportPreStartFailure(
  params: Pick<RunEmbeddedAgentAttemptParams, "opts" | "suppressVisibleSessionEffects">,
  err: unknown,
): boolean {
  return (
    !(err instanceof LiveSessionModelSwitchError) &&
    (isCompletionReportInputProvenance(params.opts.inputProvenance) ||
      (err instanceof PreparedModelRuntimeOwnerNotPublishedError && err.admissionBlocked)) &&
    params.opts.deliver === true &&
    !params.suppressVisibleSessionEffects
  );
}

/**
 * Callers that owe a reply read this fact off the rethrown error. Shutdown aborts every run with
 * one shared reason, which must not carry this run's mark.
 */
export function markRunNeverStarted(err: unknown, abortSignal: AbortSignal | undefined): void {
  if (!abortSignal?.aborted && err instanceof Error && Object.isExtensible(err)) {
    Object.assign(err, { providerStarted: false });
  }
}
