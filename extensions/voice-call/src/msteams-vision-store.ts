import type { MsteamsVideoFrame } from "./msteams-video-frame.js";
import { VisionBudget } from "./vision-budget.js";

type FramePair = { camera?: MsteamsVideoFrame; screenshare?: MsteamsVideoFrame };

/**
 * Per-call inbound video frames (latest per source) plus the per-call vision spend cap. The provider
 * owns the recording gate (recording-active is shared call state), so this only stores/serves frames
 * that have already passed the gate and tracks the budget.
 */
export class MsteamsVisionStore {
  private readonly frames = new Map<string, FramePair>();
  private budgetInstance: VisionBudget | null = null;

  /** @param maxPerMinute lazy read of `msteams.maxVisionPerMinute` (config may be wired after construction). */
  constructor(private readonly maxPerMinute: () => number) {}

  /** Retain the latest frame per source for a call. Caller must have passed the recording gate. */
  store(frame: MsteamsVideoFrame & { callId: string }): void {
    const pair = this.frames.get(frame.callId) ?? {};
    pair[frame.source] = {
      source: frame.source,
      dataBase64: frame.dataBase64,
      mime: frame.mime,
      width: frame.width,
      height: frame.height,
      ts: frame.ts,
      participantId: frame.participantId,
      participantName: frame.participantName,
    };
    this.frames.set(frame.callId, pair);
  }

  /** Latest frame for a call; with no source, prefers screen-share over camera. */
  getLatest(callId: string, source?: "camera" | "screenshare"): MsteamsVideoFrame | undefined {
    const pair = this.frames.get(callId);
    if (!pair) {
      return undefined;
    }
    return source ? pair[source] : (pair.screenshare ?? pair.camera);
  }

  /** Shared per-call vision spend cap, lazily built from config on first use. */
  budget(): VisionBudget {
    this.budgetInstance ??= new VisionBudget(this.maxPerMinute());
    return this.budgetInstance;
  }

  /** Adopt a budget supplied by the realtime runtime, so both paths share one cap. */
  setBudget(budget: VisionBudget): void {
    this.budgetInstance = budget;
  }

  /** Drop a call's frames and release its budget slot. */
  release(callId: string): void {
    this.frames.delete(callId);
    this.budgetInstance?.release(callId);
  }
}
