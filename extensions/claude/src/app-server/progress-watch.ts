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
  /** (Re)arm the watch from the current time; safe to call repeatedly. */
  arm(): void;
  /** Stop the watch and clear its timer. */
  dispose(): void;
};

export function createClaudeProgressWatch(params: {
  timeoutMs: number;
  isSettled: () => boolean;
  onStall: (info: { idleMs: number; openItems: number }) => void;
}): ClaudeProgressWatch {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastProgressAt = Date.now();
  let openItems = 0;

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
    const delay = Math.max(1, params.timeoutMs - (Date.now() - lastProgressAt));
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
    if (idleMs < params.timeoutMs) {
      // A late progress note pushed the deadline out; re-arm for the remainder.
      schedule();
      return;
    }
    clear();
    params.onStall({ idleMs, openItems });
  }

  const bump = () => {
    lastProgressAt = Date.now();
    schedule();
  };

  return {
    noteProgress: bump,
    noteItemStarted: () => {
      openItems += 1;
      bump();
    },
    noteItemCompleted: () => {
      openItems = Math.max(0, openItems - 1);
      bump();
    },
    arm: schedule,
    dispose: clear,
  };
}
