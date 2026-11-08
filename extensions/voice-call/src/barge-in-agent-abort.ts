/**
 * Opt-in agent-run abort for caller barge-in.
 *
 * The always-on half of barge-in is audio-side: queued telephony audio is
 * cleared and the active reply is cancelled. That stops the caller from being
 * talked over, but the OpenClaw agent run behind the turn keeps going, so the
 * caller waits out work they already interrupted and the reply that eventually
 * arrives answers a stale question.
 *
 * When the barge-in abort flag is enabled this coordinator also aborts the
 * in-flight run for the call. The abort is deliberately immediate: it signals
 * the run's abort signal, which the exec tool observes to kill its child
 * process right away (see `bash-tools.exec-run`'s abort listener) rather than
 * waiting for a tool-call boundary.
 *
 * History handling is intentionally delegated, not reimplemented:
 * - Tool calls that already completed stay persisted by the embedded runner, so
 *   the next run resumes with that work intact instead of restarting it.
 * - Tool calls killed mid-flight are left without results, and the existing
 *   transcript repair / tool-result guard layer synthesizes the `aborted`
 *   placeholder results on the next run so the model can see they did not
 *   complete.
 *
 * The interrupted question is deliberately not carried forward: it is already
 * in session history, and the barged-in utterance becomes the next turn on its
 * own.
 */

/** An agent run currently executing on behalf of one call. */
export type BargeInTrackedAgentRun = {
  /** Session the embedded run is executing in; the abort key. */
  sessionId: string;
  /** Run id, logged and used to ignore stale clears. */
  runId: string;
};

export type BargeInAgentAbortOptions = {
  /**
   * Aborts the embedded agent run owning `sessionId`.
   *
   * Injected so the coordinator stays unit-testable; production wiring passes
   * the plugin SDK's `abortAgentHarnessRun`, which is the same run-abort path
   * the TUI escape key uses.
   */
  abortAgentRun: (sessionId: string) => boolean;
  /** Structured logging seam; defaults to no logging. */
  log?: (message: string) => void;
};

/**
 * Per-call registry of in-flight agent runs.
 *
 * One instance is owned by the call path and keyed by `callId`, because
 * barge-in is detected on the audio path while the run is started on the
 * response path, and the two only share the call identity.
 *
 * The opt-in flag is checked by the caller, not here: the coordinator is
 * unconditional so there is exactly one gate to reason about.
 */
export class BargeInAgentAbortCoordinator {
  private readonly runsByCallId = new Map<string, BargeInTrackedAgentRun>();
  private readonly abortAgentRun: (sessionId: string) => boolean;
  private readonly log: (message: string) => void;

  constructor(options: BargeInAgentAbortOptions) {
    this.abortAgentRun = options.abortAgentRun;
    this.log = options.log ?? (() => {});
  }

  /** Records the run now executing for `callId`, replacing any earlier run. */
  registerRun(callId: string, run: BargeInTrackedAgentRun): void {
    this.runsByCallId.set(callId, run);
  }

  /**
   * Clears the tracked run.
   *
   * With `runId` set, a mismatch is ignored so a late cleanup from a superseded
   * run cannot drop the abort target of the run that replaced it. Omit `runId`
   * to drop whatever is tracked, which is what call teardown wants.
   */
  clearRun(callId: string, runId?: string): void {
    const tracked = this.runsByCallId.get(callId);
    if (!tracked) {
      return;
    }
    if (runId !== undefined && tracked.runId !== runId) {
      return;
    }
    this.runsByCallId.delete(callId);
  }

  /**
   * Aborts the in-flight run for `callId` in response to barge-in.
   *
   * Returns true only when a tracked run was actually aborted, which is the one
   * distinction callers act on (it gates consult retirement). Nothing tracked,
   * or an abort the runner refused, returns false.
   *
   * Stays silent for both miss cases - nothing tracked, and a run the harness
   * had already retired. The streaming trigger fires on every partial
   * transcript, so logging misses floods the log many times per utterance. A
   * throw propagates - every caller runs this inside the inbound audio path and
   * already guards it.
   *
   * Log messages carry no `[voice-call]` prefix: callers own that. The plugin
   * logger adds it, so prefixing here produced `[voice-call] [voice-call]`.
   *
   * Always clears the tracked run, so a second barge-in on the same turn cannot
   * re-abort an already-dead run.
   */
  abortForBargeIn(params: { callId: string; source: string }): boolean {
    const tracked = this.runsByCallId.get(params.callId);
    if (!tracked) {
      return false;
    }
    this.runsByCallId.delete(params.callId);
    if (!this.abortAgentRun(tracked.sessionId)) {
      // Silent: the turn settled before the abort landed but its clear had not
      // run yet. That window is normal and fired several times per call, so a
      // log line here reads like a failure while describing routine timing.
      return false;
    }
    this.log(
      `barge-in aborted agent run callId=${params.callId} source=${params.source} runId=${tracked.runId} sessionId=${tracked.sessionId}`,
    );
    return true;
  }
}
