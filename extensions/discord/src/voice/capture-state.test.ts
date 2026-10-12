// Discord tests cover capture state plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  clearVoiceCaptureFinalizeTimer,
  finishVoiceCapture,
  scheduleVoiceCaptureFinalize,
  stopVoiceCaptureState,
  type VoiceCaptureEntry,
  type VoiceCaptureState,
} from "./capture-state.js";

describe("voice capture state", () => {
  it("keeps a replacement's finalize timer when an old decode finishes", async () => {
    vi.useFakeTimers();
    try {
      const state: VoiceCaptureState = new Map();
      const first: VoiceCaptureEntry = { stream: { destroy: vi.fn() } as never };
      state.set("u1", first);
      finishVoiceCapture(state, "u1", first);
      const destroy = vi.fn();
      state.set("u1", { stream: { destroy } as never });
      scheduleVoiceCaptureFinalize({ state, userId: "u1", delayMs: 1_200 });

      expect(finishVoiceCapture(state, "u1", first)).toBe(false);
      await vi.advanceTimersByTimeAsync(1_200);
      expect(destroy).toHaveBeenCalledOnce();
      expect(state.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears active speaker state before destroying a finalized capture", async () => {
    vi.useFakeTimers();
    try {
      const state: VoiceCaptureState = new Map();
      const destroy = vi.fn(() => {
        expect(state.has("u1")).toBe(false);
      });
      state.set("u1", { stream: { destroy } as never });

      expect(scheduleVoiceCaptureFinalize({ state, userId: "u1", delayMs: 1_200 })).toBe(true);
      await vi.advanceTimersByTimeAsync(1_200);

      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a pending finalize be canceled for the same capture", () => {
    const state: VoiceCaptureState = new Map();
    const capture: VoiceCaptureEntry = { stream: { destroy: vi.fn() } as never };
    state.set("u1", capture);

    expect(scheduleVoiceCaptureFinalize({ state, userId: "u1", delayMs: 1_200 })).toBe(true);
    expect(clearVoiceCaptureFinalizeTimer(capture)).toBe(true);
    expect(clearVoiceCaptureFinalizeTimer(capture)).toBe(false);
  });

  it("retires every capture and cancels timers before terminal stream teardown", async () => {
    vi.useFakeTimers();
    try {
      const state: VoiceCaptureState = new Map();
      const destroy = vi.fn(() => expect(state.size).toBe(0));
      for (const userId of ["u1", "u2"]) {
        state.set(userId, { stream: { destroy } as never });
        scheduleVoiceCaptureFinalize({ state, userId, delayMs: 1_200 });
      }

      stopVoiceCaptureState(state);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1_200);
      expect(destroy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
