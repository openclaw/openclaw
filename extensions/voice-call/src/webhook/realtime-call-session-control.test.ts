import type {
  RealtimeVoiceBridgeSession,
  RealtimeVoiceSessionHarness,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
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
  controller.onReady({ triggerGreeting } as unknown as RealtimeVoiceBridgeSession);
  return { controller, triggerGreeting };
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
  const elapse = async (ms: number, calls = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
    expect(onIdle).toHaveBeenCalledTimes(calls);
  };
  return { controller, elapse };
}

it.each(["opening hold", "nested consults"])("pauses speech idle during %s", async (reason) => {
  let paused = reason === "opening hold";
  const { controller, elapse } = activity(() => paused);
  await elapse(2_000);
  controller.start();
  controller.noteSpeech();
  if (!paused) {
    await elapse(999);
    controller.beginConsult();
    controller.beginConsult();
  }
  await elapse(3_000);
  if (!paused) {
    controller.endConsult();
  }
  await elapse(2_000);
  if (paused) {
    paused = false;
    controller.noteSpeech();
  } else {
    controller.endConsult();
  }
  await elapse(1_000, 1);
});

it("interrupts a consult while telephony audio remains queued", () => {
  const send = vi.fn(() => true);
  const audioPacer = new RealtimeAudioPacer({
    send,
    serializer: {
      serializeMedia: (payload) => payload,
      serializeClear: () => "clear",
      serializeMark: (name) => name,
    },
  });
  onTestFinished(() => audioPacer.close());
  const controller = createRealtimeCallAudioController({
    audioPacer,
    callId: "call-1",
    harness: { talk: { outputAudioActive: false } } as unknown as RealtimeVoiceSessionHarness,
    isOpen: () => true,
    pendingMarkAcks: new Map(),
    providerCallId: "CA-barge-in",
  });
  const consult = new AbortController();
  audioPacer.sendAudio(Buffer.alloc(160 * 20));
  controller.cancelOutputAudioForBargeIn("local", () => consult.abort());
  expect(consult.signal.aborted).toBe(true);
  expect(send).toHaveBeenCalledWith("clear");
});

it("uses the outbound greeting fallback once after three seconds", async () => {
  const { triggerGreeting } = greeting({ instructions: "Exact greeting" });
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
  ["closed", 30_000],
] as const)(
  "holds the realtime opening until AMD resolves (%s, cap=%d)",
  async (classification, holdOpeningMaxMs) => {
    const call: Pick<CallRecord, "direction" | "metadata"> = {
      direction: "outbound",
      metadata: { voicemailManagedByHost: true, mode: "conversation" },
    };
    const { controller, triggerGreeting } = greeting({
      call,
      ...(holdOpeningMaxMs === 45_000 ? { holdOpeningMaxMs } : {}),
    });
    if (classification === "closed") {
      controller.close();
      await vi.advanceTimersByTimeAsync(holdOpeningMaxMs);
      expect(triggerGreeting).not.toHaveBeenCalled();
      return;
    }
    await vi.advanceTimersByTimeAsync(3_000);
    expect(triggerGreeting).not.toHaveBeenCalled();
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
    expect(triggerGreeting.mock.calls).toEqual(machine ? [] : [["Exact opening"]]);
    call.metadata = { ...call.metadata, answeredBy: machine ? "unknown" : "machine_end_other" };
    expect(controller.isBlocked()).toBe(true);
    expect(controller.claim()).toBe(false);
    controller.close();
  },
);
