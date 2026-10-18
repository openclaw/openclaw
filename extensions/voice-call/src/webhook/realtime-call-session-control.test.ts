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
    vi.useFakeTimers();
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
    const { controller, triggerGreeting, ready } = greeting({ instructions });

    expect(instructions).toContain(`Answer: ${JSON.stringify(opening)}`);
    expect(instructions).toContain("Then stop and listen.");
    ready();
    expect(triggerGreeting).not.toHaveBeenCalled();
    expect(controller.claim()).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(triggerGreeting).not.toHaveBeenCalled();
  });

  it("uses the outbound greeting fallback once after three seconds", async () => {
    vi.useFakeTimers();
    const { triggerGreeting, ready } = greeting({ instructions: "Exact greeting" });

    ready();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(triggerGreeting).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(triggerGreeting).toHaveBeenCalledExactlyOnceWith("Exact greeting");
  });

  it.each(["human", "unknown", "timeout", "machine_start", "machine_end_other"])(
    "holds the realtime opening and audio until AMD returns %s",
    async (classification) => {
      vi.useFakeTimers();
      const call = amdCall();
      const { controller, triggerGreeting, ready } = greeting({ call });
      ready();
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
    const { controller, triggerGreeting, ready } = greeting({ call: amdCall() });
    ready();
    controller.close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(triggerGreeting).not.toHaveBeenCalled();
  });

  it("starts idle monitoring on media activation and pauses it during consults", async () => {
    vi.useFakeTimers();
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
