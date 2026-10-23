import type {
  RealtimeVoiceBridgeSession,
  RealtimeVoiceSessionHarness,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallRecord } from "../types.js";
import { RealtimeAudioPacer } from "./realtime-audio-pacer.js";
import {
  createOutboundGreetingController,
  createRealtimeCallActivityController,
  createRealtimeCallAudioController,
} from "./realtime-call-session-control.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function greeting(options: Partial<Parameters<typeof createOutboundGreetingController>[0]> = {}) {
  const triggerGreeting = vi.fn();
  const controller = createOutboundGreetingController({
    enabled: true,
    instructions: "Exact opening",
    ...options,
  });
  const ready = () =>
    controller.onReady({ triggerGreeting } as unknown as RealtimeVoiceBridgeSession);
  return { controller, triggerGreeting, ready };
}

function amdCall(): Pick<CallRecord, "direction" | "metadata"> {
  return {
    direction: "outbound",
    metadata: { voicemailManagedByHost: true, mode: "conversation" },
  };
}

function activity(isPaused?: () => boolean) {
  const onIdle = vi.fn();
  const controller = createRealtimeCallActivityController({
    idleHangupMs: 1_000,
    isPaused,
    onIdle,
    onMediaWarning: vi.fn(),
    onMediaTimeout: vi.fn(),
  });
  return { controller, onIdle };
}

describe("realtime call activity pause", () => {
  it("does not time speech idle while the opening hold is active", () => {
    let paused = true;
    const { controller, onIdle } = activity(() => paused);
    controller.start();
    vi.advanceTimersByTime(5_000);
    expect(onIdle).not.toHaveBeenCalled();
    paused = false;
    controller.noteSpeech();
    vi.advanceTimersByTime(1_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});

describe("realtime call session control", () => {
  it.each(["silent", "playing", "queued"] as const)(
    "interrupts a consult only while model audio is active (%s)",
    (playback) => {
      const send = vi.fn(() => true);
      const audioPacer = new RealtimeAudioPacer({
        send,
        serializer: {
          serializeMedia: (payload) => payload,
          serializeClear: () => "clear",
          serializeMark: (name) => name,
        },
      });
      const harness = {
        talk: {
          outputAudioActive: playback === "playing",
          activeTurnId: "turn-1",
          cancelTurn: vi.fn(),
        },
        finishOutputAudio: vi.fn(),
      } as unknown as RealtimeVoiceSessionHarness;
      const controller = createRealtimeCallAudioController({
        audioPacer,
        callId: "call-1",
        harness,
        isOpen: () => true,
        pendingMarkAcks: new Map(),
        providerCallId: "CA-barge-in",
      });
      const consult = new AbortController();
      if (playback === "queued") {
        audioPacer.sendAudio(Buffer.alloc(160 * 20));
      }
      try {
        controller.cancelOutputAudioForBargeIn("local", () => consult.abort());
        expect(consult.signal.aborted).toBe(playback !== "silent");
        expect(send).toHaveBeenCalledWith("clear");
      } finally {
        audioPacer.close();
      }
    },
  );

  it("uses the outbound greeting fallback once after three seconds", async () => {
    const { triggerGreeting, ready } = greeting({ instructions: "Exact greeting" });

    ready();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(triggerGreeting).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(triggerGreeting).toHaveBeenCalledExactlyOnceWith("Exact greeting");
  });

  it.each([
    ["human", 30_000],
    ["unknown", 30_000],
    ["timeout", 30_000],
    ["timeout", 45_000],
    ["machine_start", 30_000],
    ["machine_end_other", 30_000],
    ["closed", 30_000],
  ] as const)(
    "holds the realtime opening until AMD resolves (%s, cap=%d)",
    async (classification, holdOpeningMaxMs) => {
      const call = amdCall();
      const { controller, triggerGreeting, ready } = greeting({
        call,
        ...(holdOpeningMaxMs === 45_000 ? { holdOpeningMaxMs } : {}),
      });
      ready();
      if (classification === "closed") {
        controller.close();
        await vi.advanceTimersByTimeAsync(holdOpeningMaxMs);
        expect(triggerGreeting).not.toHaveBeenCalled();
        return;
      }
      await vi.advanceTimersByTimeAsync(3_000);
      expect(triggerGreeting).not.toHaveBeenCalled();
      expect(controller.claim()).toBe(false);
      if (classification === "timeout") {
        await vi.advanceTimersByTimeAsync(holdOpeningMaxMs - 3_001);
        expect(controller.isBlocked()).toBe(true);
        expect(triggerGreeting).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      } else {
        call.metadata = { ...call.metadata, answeredBy: classification };
      }
      const machine = classification.startsWith("machine_");
      expect(controller.isBlocked()).toBe(machine);
      await vi.advanceTimersByTimeAsync(40_000);
      if (machine) {
        expect(triggerGreeting).not.toHaveBeenCalled();
        expect(controller.claim()).toBe(false);
        call.metadata = { ...call.metadata, answeredBy: "unknown" };
        expect(controller.isBlocked()).toBe(true);
      } else {
        expect(triggerGreeting).toHaveBeenCalledExactlyOnceWith("Exact opening");
        call.metadata = { ...call.metadata, answeredBy: "machine_end_other" };
        expect(controller.isBlocked()).toBe(true);
        expect(controller.claim()).toBe(false);
      }
      controller.close();
    },
  );

  it("starts idle monitoring on media activation and pauses it during consults", async () => {
    const { controller, onIdle } = activity();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(onIdle).not.toHaveBeenCalled();
    controller.start();
    controller.noteSpeech();
    await vi.advanceTimersByTimeAsync(999);
    expect(onIdle).not.toHaveBeenCalled();
    controller.beginConsult();
    controller.beginConsult();
    expect(controller.isPaused()).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onIdle).not.toHaveBeenCalled();
    controller.endConsult();
    expect(controller.isPaused()).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onIdle).not.toHaveBeenCalled();
    controller.endConsult();
    expect(controller.isPaused()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onIdle).toHaveBeenCalledOnce();
  });
});
