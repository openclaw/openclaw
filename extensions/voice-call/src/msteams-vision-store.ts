import type { MsteamsVideoFrame } from "./msteams-video-frame.js";
import { VisionBudget } from "./vision-budget.js";

type FramePair = { camera?: MsteamsVideoFrame; screenshare?: MsteamsVideoFrame };

/**
 * Scene-change keyframes retained per call for retroactive vision ("what did the earlier slide
 * say?"). The worker only emits changed frames, so every stored frame IS a keyframe; the ring keeps
 * memory bounded (~16 JPEG frames ≈ 1–2 MB per call).
 */
const HISTORY_MAX_FRAMES = 16;

/**
 * Per-call inbound video frames (latest per source) plus the per-call vision spend cap. The provider
 * owns the recording gate (recording-active is shared call state), so this only stores/serves frames
 * that have already passed the gate and tracks the budget.
 */
export class MsteamsVisionStore {
  private readonly frames = new Map<string, FramePair>();
  private readonly history = new Map<string, MsteamsVideoFrame[]>();
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

    // Keyframe ring for retroactive vision: oldest dropped past the cap.
    const ring = this.history.get(frame.callId) ?? [];
    ring.push(pair[frame.source] as MsteamsVideoFrame);
    if (ring.length > HISTORY_MAX_FRAMES) {
      ring.shift();
    }
    this.history.set(frame.callId, ring);
  }

  /** The most recent scene-change keyframes for a call, oldest first (up to `limit`). */
  getHistory(callId: string, limit = HISTORY_MAX_FRAMES): MsteamsVideoFrame[] {
    const ring = this.history.get(callId) ?? [];
    return ring.slice(-Math.max(1, limit));
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

  /** Drop a call's frames (latest + history) and release its budget slot. */
  release(callId: string): void {
    this.frames.delete(callId);
    this.history.delete(callId);
    this.budgetInstance?.release(callId);
  }
}
