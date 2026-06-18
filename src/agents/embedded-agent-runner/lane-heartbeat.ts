// Lane-task progress heartbeat.
//
// The command-queue lane-task timeout uses a sliding window: every
// `armTimeout()` cycle re-reads `lastProgressAtMs` (provided by
// `taskTimeoutProgressAtMs` in the queue entry) and rejects with
// `CommandLaneTaskTimeoutError` if `Date.now() - lastProgressAtMs > taskTimeoutMs`.
//
// The embedded runner only refreshes `lastProgressAtMs` via the
// `noteLaneTaskProgress` callback, which fires from
// `notifyExecutionPhase` / `notifyRunProgress` during the runner's own
// lifecycle. Long-running tool execution (e.g. an `exec` that runs for
// several minutes) happens *inside* the embedded attempt and emits no
// runner callbacks, so the sliding window expires even though the task
// is making progress.
//
// This helper bridges that gap by periodically calling a `noteProgress`
// callback while a task is in flight. The default interval is 20s —
// well under the 30s grace window in `command-queue.ts:265`
// (`taskTimeoutMs + 30s`), so at least one `armTimeout` cycle always
// sees fresh progress before deciding to fire.
//
// The interval is `.unref()`'d so the heartbeat never blocks process
// exit. Callers must always invoke `stop()` once the task settles
// (success, error, or abort) so the timer cannot outlive the task it
// is observing.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;

export type LaneTaskProgressHeartbeat = { stop: () => void };

/**
 * Start a periodic heartbeat that calls `noteProgress` every
 * `intervalMs` (default 20s). Returns a handle whose `stop()` clears
 * the underlying timer; safe to call multiple times.
 *
 * The interval is `.unref()`'d so the timer never keeps the Node event
 * loop alive on its own.
 */
export function startLaneTaskProgressHeartbeat(
  noteProgress: () => void,
  intervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS,
): LaneTaskProgressHeartbeat {
  const handle = setInterval(noteProgress, intervalMs);
  handle.unref?.();
  return {
    stop: () => {
      clearInterval(handle);
    },
  };
}

/**
 * Run `task` under a periodic progress heartbeat. The heartbeat is
 * stopped once the task settles (success or failure), so callers can
 * safely `await` the returned promise and never leak the interval.
 */
export function withLaneTaskProgressHeartbeat<T>(
  noteProgress: () => void,
  task: Promise<T>,
  intervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS,
): Promise<T> {
  const heartbeat = startLaneTaskProgressHeartbeat(noteProgress, intervalMs);
  return task.finally(() => {
    heartbeat.stop();
  });
}
