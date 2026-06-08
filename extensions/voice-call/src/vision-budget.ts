/**
 * Per-call vision spend cap (CVI #4). Vision-model calls (look_at_screen, streaming frame attach,
 * future proactive captioning) are the dominant cost of "continuous perception", so bound them with
 * a simple sliding 60-second window per call. `maxPerMinute <= 0` means unlimited.
 *
 * Pure-ish (the caller injects `nowMs`) so it is unit-testable.
 */
export class VisionBudget {
  private readonly hitsByCall = new Map<string, number[]>();

  constructor(private readonly maxPerMinute: number) {}

  /** True (and records a hit) if under budget for this call; false if the caller should skip the vision call. */
  tryConsume(callId: string, nowMs: number): boolean {
    if (this.maxPerMinute <= 0) {
      return true; // unlimited
    }
    const recent = (this.hitsByCall.get(callId) ?? []).filter((t) => nowMs - t < 60_000);
    if (recent.length >= this.maxPerMinute) {
      this.hitsByCall.set(callId, recent); // keep the trimmed window
      return false;
    }
    recent.push(nowMs);
    this.hitsByCall.set(callId, recent);
    return true;
  }

  /** Drop a call's window when it ends. */
  release(callId: string): void {
    this.hitsByCall.delete(callId);
  }
}
