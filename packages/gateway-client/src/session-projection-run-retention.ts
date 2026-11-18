/** Bounded retention for completed and active session projection runs. */

const MAX_TRACKED_SESSION_RUNS = 200;
const RETAINED_SESSION_RUNS = 150;

/** Retain every active run and the newest completed runs within the projection bound. */
export function retainSessionProjectionRuns<T extends { status: string }>(
  runs: Readonly<Record<string, T>>,
): Readonly<Record<string, T>> {
  const entries = Object.entries(runs);
  if (entries.length <= MAX_TRACKED_SESSION_RUNS) {
    return runs;
  }
  const active = entries.filter(([, run]) => run.status === "streaming");
  const terminal = entries.filter(([, run]) => run.status !== "streaming");
  const terminalLimit = Math.max(0, RETAINED_SESSION_RUNS - active.length);
  const retainedTerminal = terminalLimit > 0 ? terminal.slice(-terminalLimit) : [];
  // Live streams are never expendable; completed runs are retained by completion order.
  return Object.fromEntries([...active, ...retainedTerminal]);
}
