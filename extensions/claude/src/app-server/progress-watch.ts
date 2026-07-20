/**
 * Codex-consistent "no real progress" watch for a single Claude bridge turn —
 * a small-scope mirror of the progress/attempt-idle watch in
 * extensions/codex/src/app-server/attempt-turn-watches.ts.
 *
 * Why this exists: the turnIdleTimeoutMs watch in run-attempt.ts resets on ANY
 * turn notification, including the bridge's periodic keepalive heartbeat
 * (turn-runner emits turn/progress {kind:"heartbeat"} every ~30s). Once
 * heartbeats flow it can no longer catch a turn that is alive-but-hung
 * (heartbeating with zero real output) — only the hard turnTimeoutMs ceiling
 * would, minutes later. This watch advances its deadline ONLY on real activity
 * and, like codex's getActiveTurnItemCount() > 0 guard, fires only when no turn
 * items are in flight (openItems === 0). So a legitimately-slow native subagent
 * (an open tool item, silent on this SDK version) is never killed, while a
 * genuine no-progress/no-work-in-flight hang is torn down well before the hard
 * ceiling.
 *
 * The caller maps turn notifications to the note* methods (a keepalive
 * turn/progress is intentionally NOT mapped to noteProgress).
 */
export type ClaudeProgressWatch = {
  /** Real, non-item activity (assistant/reasoning delta, SDK-activity turn/progress). */
  noteProgress(): void;
  /** A turn item (tool call / native subagent) started — counts as in-flight work. */
  noteItemStarted(): void;
  /** A turn item completed. */
  noteItemCompleted(): void;
  /**
   * A native subagent (`Agent`/`Task`) was just dispatched. On the installed SDK
   * version the subagent's item/started + item/completed bracket only the LLM
   * *describing* the call; the actual run then happens silently in an SDK child,
   * so openItems is already back to 0 by the time the slow part begins. This
   * latch widens the stall window to `subagentTimeoutMs` until the next real
   * progress note arrives — covering exactly that silent gap when running
   * against an older bridge that doesn't emit `subagentActivity`. No-op when no
   * subagent budget was configured (subagentTimeoutMs <= timeoutMs).
   */
  noteSubagentDispatched(): void;
  /** (Re)arm the watch from the current time; safe to call repeatedly. */
  arm(): void;
  /** Stop the watch and clear its timer. */
  dispose(): void;
};

export function createClaudeProgressWatch(params: {
  timeoutMs: number;
  isSettled: () => boolean;
  onStall: (info: { idleMs: number; openItems: number }) => void;
  /**
   * Extended idle budget that applies while the subagent latch is engaged (see
   * noteSubagentDispatched). Defaults to `timeoutMs` (no widening). Ignored when
   * not greater than `timeoutMs`.
   */
  subagentTimeoutMs?: number;
}): ClaudeProgressWatch {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastProgressAt = Date.now();
  let openItems = 0;
  // When true, the silent post-dispatch window of a native subagent is in
  // effect: use the wider budget. Cleared by any genuine progress/item signal,
  // which means real activity has resumed and the normal window applies again.
  let subagentLatched = false;
  const subagentTimeoutMs =
    params.subagentTimeoutMs && params.subagentTimeoutMs > params.timeoutMs
      ? params.subagentTimeoutMs
      : params.timeoutMs;

  const effectiveTimeoutMs = () => (subagentLatched ? subagentTimeoutMs : params.timeoutMs);

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = () => {
    clear();
    if (params.isSettled()) {
      return;
    }
    const delay = Math.max(1, effectiveTimeoutMs() - (Date.now() - lastProgressAt));
    timer = setTimeout(fire, delay);
    timer.unref?.();
  };

  function fire() {
    if (params.isSettled()) {
      return;
    }
    // While work is genuinely in flight, never stall — defer a FULL window
    // (mirrors codex's getActiveTurnItemCount() > 0 guard). Re-anchoring
    // lastProgressAt avoids a 1ms busy-reschedule once the deadline has passed.
    if (openItems > 0) {
      lastProgressAt = Date.now();
      schedule();
      return;
    }
    const idleMs = Date.now() - lastProgressAt;
    if (idleMs < effectiveTimeoutMs()) {
      // A late progress note (or the subagent latch widening the window) pushed
      // the deadline out; re-arm for the remainder.
      schedule();
      return;
    }
    clear();
    params.onStall({ idleMs, openItems });
  }

  const bump = (opts?: { clearLatch?: boolean }) => {
    if (opts?.clearLatch) {
      subagentLatched = false;
    }
    lastProgressAt = Date.now();
    schedule();
  };

  return {
    // Real activity resumed → drop the subagent latch and return to the normal
    // (tighter) window so a subsequent genuine hang is still caught promptly.
    noteProgress: () => bump({ clearLatch: true }),
    noteItemStarted: () => {
      openItems += 1;
      bump({ clearLatch: true });
    },
    noteItemCompleted: () => {
      openItems = Math.max(0, openItems - 1);
      bump();
    },
    noteSubagentDispatched: () => {
      subagentLatched = true;
      bump();
    },
    arm: schedule,
    dispose: clear,
  };
}
