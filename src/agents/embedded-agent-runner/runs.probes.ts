// Contained reads of active-run lifecycle probes. A handle probe that throws must
// never escape into steering, supersede, or cancellation callers.
import { diagnosticLogger as diag } from "../../logging/diagnostic-runtime.js";
import type { EmbeddedAgentQueueHandle } from "./run-state.js";

type CompactionProbe = { isCompacting?: () => boolean };
const reportedCompactingProbeFailures = new WeakSet<CompactionProbe>();

export function isEmbeddedRunHandleAbortable(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  mode: "all" | "compacting" = "all",
): boolean {
  if (mode === "compacting" && isEmbeddedRunHandleCompacting(sessionId, handle) !== true) {
    return false;
  }
  try {
    return handle.isAbortable?.() !== false;
  } catch (err) {
    diag.warn(
      `abort failed: sessionId=${sessionId} reason=abortable_check_failed err=${String(err)}`,
    );
    return false;
  }
}

// Returns undefined when the probe itself fails so each caller picks its own
// indeterminate outcome: queueing fails closed, abort selection skips the handle.
export function isEmbeddedRunHandleCompacting(
  sessionId: string,
  handle: CompactionProbe,
): boolean | undefined {
  try {
    return handle.isCompacting?.() ?? false;
  } catch (err) {
    if (!reportedCompactingProbeFailures.has(handle)) {
      reportedCompactingProbeFailures.add(handle);
      diag.warn(
        `embedded run state check failed: sessionId=${sessionId} reason=compacting_check_failed err=${String(err)}`,
      );
    }
    return undefined;
  }
}

export function isEmbeddedRunHandleSupersedable(
  runId: string,
  handle: EmbeddedAgentQueueHandle,
): boolean {
  if (!isEmbeddedRunHandleAbortable(runId, handle)) {
    return false;
  }
  try {
    return handle.isStopped?.() !== true && handle.isAborted?.() !== true;
  } catch (err) {
    diag.warn(`supersede failed: runId=${runId} reason=lifecycle_check_failed err=${String(err)}`);
    return false;
  }
}

export function canSteerEmbeddedRunDuringCompaction(
  sessionId: string,
  handle: CompactionProbe &
    Pick<EmbeddedAgentQueueHandle, "messageInjection" | "messageInjectionV2">,
): boolean {
  const compacting = isEmbeddedRunHandleCompacting(sessionId, handle);
  // Modern injection capabilities can admit automatic compaction; an unreadable
  // probe or a legacy manual-compaction handle must leave the input queued.
  return (
    compacting !== undefined &&
    (!compacting || handle.messageInjectionV2?.version === 2 || Boolean(handle.messageInjection))
  );
}
