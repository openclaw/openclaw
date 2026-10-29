import { runWithGatewayDetachedWorkAdmission } from "../../../process/gateway-work-admission.js";

export function createSubagentSweepCleanupTail(params: {
  trackWork: (run: () => Promise<unknown>) => Promise<unknown>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  const { trackWork } = params;
  function runCleanupTail(runId: string, label: string, run: () => Promise<unknown>) {
    // Cleanup can outlive the tick as well as the request that armed its timer.
    void trackWork(() =>
      runWithGatewayDetachedWorkAdmission(run, "subagents:sweeper-cleanup").catch(
        (error: unknown) => params.warn(`subagent sweep ${label} failed`, { runId, error }),
      ),
    );
  }
  return runCleanupTail;
}
