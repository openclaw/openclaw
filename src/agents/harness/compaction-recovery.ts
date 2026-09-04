/**
 * Native harness compaction recovery helpers.
 *
 * CLI compaction uses these guards to recognize thread-binding failures that can
 * fall back to context-engine compaction after clearing stale session bindings.
 * A model-locked native harness cannot reach the context engine, so it carries a
 * typed recovery disposition (classified here) that lets the turn layer
 * safe-continue instead of string-sniffing the failure reason.
 */
import type {
  EmbeddedAgentCompactResult,
  NativeHarnessBindingRecoveryReason,
} from "../embedded-agent-runner/types.js";

/** Classify a native harness failure reason into a typed recovery reason, if recoverable. */
function classifyNativeHarnessBindingReason(
  reason: unknown,
): NativeHarnessBindingRecoveryReason | undefined {
  if (typeof reason !== "string") {
    return undefined;
  }
  const normalized = reason.trim().toLowerCase();
  // "no thread binding" is the free-text spelling of a missing binding.
  if (normalized === "missing_thread_binding" || normalized.includes("no thread binding")) {
    return "missing_thread_binding";
  }
  if (normalized === "stale_thread_binding") {
    return "stale_thread_binding";
  }
  if (normalized.includes("thread not found")) {
    return "thread_not_found";
  }
  return undefined;
}

/**
 * Returns the typed recovery reason for a recoverable native binding failure, or
 * undefined. Prefers the structured failure reason over the display reason.
 */
export function classifyRecoverableNativeHarnessBindingFailure(
  result: EmbeddedAgentCompactResult | undefined,
): NativeHarnessBindingRecoveryReason | undefined {
  if (result?.ok !== false) {
    return undefined;
  }
  return (
    classifyNativeHarnessBindingReason(result.failure?.reason) ??
    classifyNativeHarnessBindingReason(result.reason)
  );
}

/** Returns whether a compact result failed due to a recoverable native binding issue. */
export function isRecoverableNativeHarnessBindingFailure(
  result: EmbeddedAgentCompactResult | undefined,
): boolean {
  return classifyRecoverableNativeHarnessBindingFailure(result) !== undefined;
}

/**
 * Returns whether a compaction result carries the authenticated locked-harness
 * binding-recovery disposition. Only the queued compaction owner stamps it, and
 * only after the private required-preflight capability dispatched, so the turn
 * layer can safe-continue without re-deriving lock state or matching reason text.
 */
export function isNativeHarnessBindingRecoverySkip(
  result: EmbeddedAgentCompactResult | undefined,
): boolean {
  return result?.nativeHarnessBindingRecoveryReason !== undefined;
}
