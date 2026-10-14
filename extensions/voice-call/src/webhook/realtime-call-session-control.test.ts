import type {
  RealtimeVoiceBridgeSession,
  RealtimeVoiceSessionHarness,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallRecord } from "../types.js";
import { RealtimeAudioPacer } from "./realtime-audio-pacer.js";
import {
  buildVerbatimGreetingInstructions,
  createOutboundGreetingController,
  createRealtimeCallActivityController,
  createRealtimeCallAudioController,
} from "./realtime-call-session-control.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("realtime call activity pause", () => {
  it("does not time speech idle while the opening hold is active", () => {
    vi.useFakeTimers();
    try {
      let paused = true;
      const onIdle = vi.fn();
      const activity = createRealtimeCallActivityController({
        idleHangupMs: 1_000,
        isPaused: () => paused,
        onIdle,
        onMediaWarning: () => {},
        onMediaTimeout: () => {},
      });
      activity.start();
      vi.advanceTimersByTime(5_000);
      expect(onIdle).not.toHaveBeenCalled();
      paused = false;
      activity.noteSpeech();
      vi.advanceTimersByTime(1_000);
      expect(onIdle).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("realtime call session control", () => {
  it.each(["silent", "playing", "queued"] as const)(
    "interrupts a consult only while model audio is active (%s)",
    (playback) => {
      vi.useFakeTimers();
      const sent: string[] = [];
      const audioPacer = new RealtimeAudioPacer({
        send: (message) => {
          sent.push(message);
          return true;
        },
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
        expect(sent).toContain("clear");
      } finally {
        audioPacer.close();
      }
    },
  );

  it("pins the outbound opening verbatim and cancels the fallback when speech begins", async () => {
    vi.useFakeTimers();
    const opening = "Buenas tardes. ¿A qué hora cierran hoy?";
    const instructions = buildVerbatimGreetingInstructions("Base rules", opening);
    const triggerGreeting = vi.fn();
    const controller = createOutboundGreetingController({ enabled: true, instructions });

    expect(instructions).toContain(`Answer: ${JSON.stringify(opening)}`);
    expect(instructions).toContain("Then stop and listen.");
    controller.onReady({ triggerGreeting } as unknown as RealtimeVoiceBridgeSession);
    expect(triggerGreeting).not.toHaveBeenCalled();
    expect(controller.claim()).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(triggerGreeting).not.toHaveBeenCalled();
  });

  it("uses the outbound greeting fallback once after three seconds", async () => {
    vi.useFakeTimers();
    const triggerGreeting = vi.fn();
    const controller = createOutboundGreetingController({
      enabled: true,
      instructions: "Exact greeting",
    });

    controller.onReady({ triggerGreeting } as unknown as RealtimeVoiceBridgeSession);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(triggerGreeting).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(triggerGreeting).toHaveBeenCalledOnce();
    expect(triggerGreeting).toHaveBeenCalledWith("Exact greeting");
  });

  it.each(["human", "unknown", "timeout", "machine_start", "machine_end_other"])(
    "holds the realtime opening and audio until AMD returns %s",
    async (classification) => {
      vi.useFakeTimers();
      const call: Pick<CallRecord, "direction" | "metadata"> = {
        direction: "outbound",
        metadata: { voicemailManagedByHost: true, mode: "conversation" },
      };
      const triggerGreeting = vi.fn();
      const controller = createOutboundGreetingController({
        enabled: true,
        instructions: "Exact opening",
        call,
      });
      controller.onReady({ triggerGreeting } as unknown as RealtimeVoiceBridgeSession);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(triggerGreeting).not.toHaveBeenCalled();
      expect(controller.claim()).toBe(false);
      if (classification === "timeout") {
        await vi.advanceTimersByTimeAsync(26_999);
        expect(controller.isBlocked()).toBe(true);
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

  it("uses the operator's AMD hold cap when no classification arrives", async () => {
    vi.useFakeTimers();
    const triggerGreeting = vi.fn();
    const controller = createOutboundGreetingController({
      enabled: true,
      instructions: "Exact opening",
      holdOpeningMaxMs: 45_000,
      call: {
        direction: "outbound",
        metadata: { voicemailManagedByHost: true, mode: "conversation" },
      },
    });
    controller.onReady({ triggerGreeting } as unknown as RealtimeVoiceBridgeSession);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(controller.isBlocked()).toBe(true);
    expect(triggerGreeting).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.isBlocked()).toBe(false);
    expect(triggerGreeting).toHaveBeenCalledExactlyOnceWith("Exact opening");
    controller.close();
  });

  it("cancels a pending AMD opening when the bridge closes", async () => {
    vi.useFakeTimers();
    const triggerGreeting = vi.fn();
    const controller = createOutboundGreetingController({
      enabled: true,
      instructions: "Exact opening",
      call: {
        direction: "outbound",
        metadata: { voicemailManagedByHost: true, mode: "conversation" },
      },
    });
    controller.onReady({ triggerGreeting } as unknown as RealtimeVoiceBridgeSession);
    controller.close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(triggerGreeting).not.toHaveBeenCalled();
  });

  it("starts idle monitoring on media activation and pauses it during consults", async () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const controller = createRealtimeCallActivityController({
      idleHangupMs: 1_000,
      mediaInactivityMs: 30_000,
      mediaGraceMs: 2_000,
      onIdle,
      onMediaWarning: vi.fn(),
      onMediaTimeout: vi.fn(),
    });

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
