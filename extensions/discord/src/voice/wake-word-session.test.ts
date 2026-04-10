import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { WakeWordSession } from "./wake-word-session.js";
import type { WakeWordSidecar } from "./wake-word-sidecar.js";
import type { SidecarDetectionEvent } from "./wake-word-types.js";

// Mock sidecar that captures sendAudio calls.
function createMockSidecar(): WakeWordSidecar & { audioChunks: Buffer[] } {
  const audioChunks: Buffer[] = [];
  return {
    audioChunks,
    sendAudio: vi.fn((pcm: Buffer) => {
      audioChunks.push(pcm);
    }),
    start: vi.fn(),
    destroy: vi.fn(),
    isAlive: vi.fn(() => true),
  } as unknown as WakeWordSidecar & { audioChunks: Buffer[] };
}

function makeDetectionEvent(trigger = "hey calvin"): SidecarDetectionEvent {
  return {
    type: "detection",
    trigger,
    confidence: 0.9,
    timestamp: Date.now(),
  };
}

/**
 * Create a 48kHz stereo PCM buffer with a constant sample value.
 * Each frame is 4 bytes (2 channels × 2 bytes).
 */
function makePcm48kStereo(durationMs: number, sampleValue = 1000): Buffer {
  const frames = Math.floor((48_000 * durationMs) / 1_000);
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(sampleValue, i * 4);
    buf.writeInt16LE(sampleValue, i * 4 + 2);
  }
  return buf;
}

/**
 * Create a silent 48kHz stereo PCM buffer.
 */
function makeSilentPcm(durationMs: number): Buffer {
  return makePcm48kStereo(durationMs, 0);
}

describe("WakeWordSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("state machine", () => {
    it("starts in listening state", () => {
      const sidecar = createMockSidecar();
      const session = new WakeWordSession({
        sidecar,
        callbacks: { onUtterance: vi.fn() },
      });
      expect(session.getState()).toBe("listening");
    });

    it("transitions to capturing on detection", () => {
      const sidecar = createMockSidecar();
      const session = new WakeWordSession({
        sidecar,
        callbacks: { onUtterance: vi.fn() },
      });
      session.handleDetection(makeDetectionEvent());
      expect(session.getState()).toBe("capturing");
    });

    it("ignores detection when not in listening state", () => {
      const sidecar = createMockSidecar();
      const session = new WakeWordSession({
        sidecar,
        callbacks: { onUtterance: vi.fn() },
      });
      session.handleDetection(makeDetectionEvent());
      expect(session.getState()).toBe("capturing");
      // Second detection while capturing should be ignored.
      session.handleDetection(makeDetectionEvent());
      expect(session.getState()).toBe("capturing");
    });

    it("returns to listening via returnToListening()", () => {
      const sidecar = createMockSidecar();
      const session = new WakeWordSession({
        sidecar,
        callbacks: { onUtterance: vi.fn() },
      });
      session.handleDetection(makeDetectionEvent());
      session.transitionToProcessing();
      expect(session.getState()).toBe("processing");
      session.returnToListening();
      expect(session.getState()).toBe("listening");
    });
  });

  describe("audio routing", () => {
    it("sends downsampled audio to sidecar during listening", () => {
      const sidecar = createMockSidecar();
      const session = new WakeWordSession({
        sidecar,
        callbacks: { onUtterance: vi.fn() },
      });
      const pcm = makePcm48kStereo(20); // 20ms chunk
      session.feedAudio(pcm);
      expect(sidecar.sendAudio).toHaveBeenCalled();
    });

    it("does not send audio to sidecar during processing", () => {
      const sidecar = createMockSidecar();
      const session = new WakeWordSession({
        sidecar,
        callbacks: { onUtterance: vi.fn() },
      });
      session.handleDetection(makeDetectionEvent());
      session.transitionToProcessing();
      vi.mocked(sidecar.sendAudio).mockClear();
      session.feedAudio(makePcm48kStereo(20));
      expect(sidecar.sendAudio).not.toHaveBeenCalled();
    });
  });

  describe("silence detection and utterance callback", () => {
    it("fires onUtterance after silence timer expires", () => {
      const onUtterance = vi.fn();
      const sidecar = createMockSidecar();
      const session = new WakeWordSession({
        sidecar,
        config: { silenceDurationMs: 100, minRmsEnergy: 10 },
        callbacks: { onUtterance },
      });

      // Trigger wake word detection.
      session.handleDetection(makeDetectionEvent());
      expect(session.getState()).toBe("capturing");

      // Feed some speech audio.
      session.feedAudio(makePcm48kStereo(20, 5000));

      // Feed a silent chunk to start the silence timer.
      session.feedAudio(makeSilentPcm(20));
      expect(onUtterance).not.toHaveBeenCalled();

      // Advance past the 100ms silence threshold.
      vi.advanceTimersByTime(110);

      // onUtterance should have been called.
      expect(onUtterance).toHaveBeenCalledTimes(1);
      const pcm = onUtterance.mock.calls[0][0] as Buffer;
      expect(pcm.length).toBeGreaterThan(0);
    });

    it("fires onUtterance even without new chunks (Discord stops sending)", () => {
      const onUtterance = vi.fn();
      const sidecar = createMockSidecar();
      const session = new WakeWordSession({
        sidecar,
        config: { silenceDurationMs: 500, minRmsEnergy: 10 },
        callbacks: { onUtterance },
      });

      session.handleDetection(makeDetectionEvent());
      session.feedAudio(makePcm48kStereo(20, 5000));

      // Feed one silent chunk to start the timer, then no more chunks arrive.
      session.feedAudio(makeSilentPcm(20));
      expect(onUtterance).not.toHaveBeenCalled();

      // 500ms later, the timer fires even though no chunks arrived.
      vi.advanceTimersByTime(510);
      expect(onUtterance).toHaveBeenCalledTimes(1);
    });

    it("resets silence timer when speech resumes", () => {
      const onUtterance = vi.fn();
      const sidecar = createMockSidecar();
      const session = new WakeWordSession({
        sidecar,
        config: { silenceDurationMs: 200, minRmsEnergy: 10 },
        callbacks: { onUtterance },
      });

      session.handleDetection(makeDetectionEvent());

      // Feed silent chunks.
      session.feedAudio(makeSilentPcm(20));
      vi.advanceTimersByTime(100);
      expect(onUtterance).not.toHaveBeenCalled();

      // Resume speech — resets the silence timer.
      session.feedAudio(makePcm48kStereo(20, 5000));
      expect(onUtterance).not.toHaveBeenCalled();

      // 100ms more silence (total 100ms from last speech, not 200ms).
      session.feedAudio(makeSilentPcm(20));
      vi.advanceTimersByTime(100);
      expect(onUtterance).not.toHaveBeenCalled();

      // Now 200ms from last speech — should fire.
      vi.advanceTimersByTime(110);
      expect(onUtterance).toHaveBeenCalledTimes(1);
    });
  });

  describe("capture timeout", () => {
    it("sends partial utterance on hard timeout", () => {
      const onUtterance = vi.fn();
      const sidecar = createMockSidecar();
      const session = new WakeWordSession({
        sidecar,
        config: { captureTimeoutSeconds: 5, minRmsEnergy: 10 },
        callbacks: { onUtterance },
      });

      session.handleDetection(makeDetectionEvent());

      // Feed some speech to have something in the buffer.
      session.feedAudio(makePcm48kStereo(20, 5000));

      // Advance past the 5-second timeout.
      vi.advanceTimersByTime(5_100);

      expect(onUtterance).toHaveBeenCalledTimes(1);
    });
  });

  describe("onWakeDetected callback", () => {
    it("fires onWakeDetected when wake word is detected", () => {
      const onWakeDetected = vi.fn();
      const sidecar = createMockSidecar();
      const session = new WakeWordSession({
        sidecar,
        callbacks: { onUtterance: vi.fn(), onWakeDetected },
      });

      session.handleDetection(makeDetectionEvent());
      expect(onWakeDetected).toHaveBeenCalledTimes(1);
    });
  });

  describe("wake word stripping", () => {
    it("strips exact trigger from start of transcript", () => {
      const sidecar = createMockSidecar();
      const session = new WakeWordSession({
        sidecar,
        config: { triggers: ["hey calvin", "openclaw"] },
        callbacks: { onUtterance: vi.fn() },
      });

      expect(session.stripWakeWord("hey calvin what time is it")).toBe("what time is it");
    });

    it("strips trigger case-insensitively", () => {
      const sidecar = createMockSidecar();
      const session = new WakeWordSession({
        sidecar,
        config: { triggers: ["hey calvin"] },
        callbacks: { onUtterance: vi.fn() },
      });

      expect(session.stripWakeWord("Hey Calvin what time is it")).toBe("what time is it");
    });

    it("strips trailing punctuation after trigger", () => {
      const sidecar = createMockSidecar();
      const session = new WakeWordSession({
        sidecar,
        config: { triggers: ["openclaw"] },
        callbacks: { onUtterance: vi.fn() },
      });

      expect(session.stripWakeWord("openclaw, what's the weather?")).toBe("what's the weather?");
    });

    it("returns full transcript when no trigger matches", () => {
      const sidecar = createMockSidecar();
      const session = new WakeWordSession({
        sidecar,
        config: { triggers: ["hey calvin"] },
        callbacks: { onUtterance: vi.fn() },
      });

      expect(session.stripWakeWord("what time is it")).toBe("what time is it");
    });

    it("matches longest trigger when multiple match", () => {
      const sidecar = createMockSidecar();
      const session = new WakeWordSession({
        sidecar,
        config: { triggers: ["hey", "hey calvin"] },
        callbacks: { onUtterance: vi.fn() },
      });

      expect(session.stripWakeWord("hey calvin what time")).toBe("what time");
    });
  });

  describe("empty command guard", () => {
    it("rejects commands shorter than minCommandLength", () => {
      const sidecar = createMockSidecar();
      const session = new WakeWordSession({
        sidecar,
        config: { minCommandLength: 2 },
        callbacks: { onUtterance: vi.fn() },
      });

      expect(session.isCommandValid("")).toBe(false);
      expect(session.isCommandValid("a")).toBe(false);
      expect(session.isCommandValid("ok")).toBe(true);
    });
  });

  describe("lookback buffer", () => {
    it("prepends lookback buffer to capture on detection", () => {
      const onUtterance = vi.fn();
      const sidecar = createMockSidecar();
      const session = new WakeWordSession({
        sidecar,
        config: {
          lookbackSeconds: 0.1, // 100ms lookback
          silenceDurationMs: 60,
          minRmsEnergy: 10,
        },
        callbacks: { onUtterance },
      });

      // Feed 100ms of speech into the lookback buffer during listening.
      const speechChunk = makePcm48kStereo(100, 5000);
      session.feedAudio(speechChunk);

      // Trigger detection.
      session.handleDetection(makeDetectionEvent());

      // Feed a silent chunk to start the silence timer.
      session.feedAudio(makeSilentPcm(20));

      // Advance past the 60ms silence threshold.
      vi.advanceTimersByTime(70);

      // The utterance should include the lookback audio.
      expect(onUtterance).toHaveBeenCalledTimes(1);
      const captured = onUtterance.mock.calls[0][0] as Buffer;
      // Captured should be larger than just the silence chunk,
      // because it includes the lookback buffer.
      expect(captured.length).toBeGreaterThan(makeSilentPcm(20).length);
    });
  });
});
