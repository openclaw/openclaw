import type {
  RealtimeVoiceBridgeSession,
  RealtimeVoiceSessionHarness,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
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
