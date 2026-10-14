import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "../config.js";
import { createEventManagerHarness } from "../manager.test-harness.js";
import { CallRecordSchema, type CallRecord } from "../types.js";
import { processEvent } from "./events.js";

const { cleanup, createContext, createProvider, setup } = createEventManagerHarness();
beforeEach(setup);
afterEach(cleanup);
function callRecord(metadata: CallRecord["metadata"] = {}): CallRecord {
  return CallRecordSchema.parse({
    callId: "amd-call",
    providerCallId: "CA-amd",
    provider: "twilio",
    direction: "outbound",
    state: "active",
    from: "+15550000000",
    to: "+15550000001",
    startedAt: Date.now(),
    metadata,
  });
}
function detection(answeredBy: string, id = "amd") {
  return { id, type: "call.amd" as const, callId: "amd-call", timestamp: Date.now(), answeredBy };
}
const voicemail = { detection: "twilio", onMachine: "leave-message" } as const;

describe("carrier answering machine flow", () => {
  it("records detection on a terminal status without restarting playback", async () => {
    const playMessageAndHangup = vi.fn(async () => {});
    const ctx = createContext({ provider: createProvider({ playMessageAndHangup }) });
    const call = callRecord();
    ctx.activeCalls.set(call.callId, call);
    await processEvent(ctx, {
      id: "ended",
      type: "call.ended",
      callId: call.callId,
      timestamp: Date.now(),
      reason: "completed",
      answeredBy: "machine_end_beep",
    });
    expect(call.metadata).toMatchObject({
      answeredByFirst: "machine_end_beep",
      answeredBy: "machine_end_beep",
    });
    expect(call.endReason).toBe("completed");
    expect(playMessageAndHangup).not.toHaveBeenCalled();
  });

  it("retains the first classification as later callbacks update the call", async () => {
    const ctx = createContext();
    const call = callRecord();
    ctx.activeCalls.set(call.callId, call);
    await processEvent(ctx, detection("machine_start", "first"));
    await processEvent(ctx, detection("machine_end_other", "last"));
    expect(call.metadata).toMatchObject({
      answeredByFirst: "machine_start",
      answeredBy: "machine_end_other",
    });
    await processEvent(ctx, {
      id: "ended",
      type: "call.ended",
      callId: call.callId,
      timestamp: Date.now(),
      reason: "completed",
      answeredBy: "machine_end_beep",
    });
    expect(call.metadata).toMatchObject({
      answeredByFirst: "machine_start",
      answeredBy: "machine_end_beep",
    });
  });

  it.each([false, true])(
    "uses realtime voicemail and waits before hangup (failure=%s)",
    async (failed) => {
      const playback = createDeferred<void>();
      const started = createDeferred<void>();
      const work: Promise<unknown>[] = [];
      const carrier = vi.fn();
      const beforeCarrierPlayback = vi.fn();
      const hangup = vi.fn(async () => {});
      const call = callRecord({ brief: { voicemailMessage: "We will call again later." } });
      const playRealtimeVoicemail = vi.fn(() => {
        started.resolve();
        return playback.promise;
      });
      const ctx = createContext({
        playRealtimeVoicemail,
        beforeCarrierPlayback,
        trackCallWork: (item) => {
          work.push(item);
        },
        provider: createProvider({
          name: "twilio",
          playMessageAndHangup: carrier,
          hangupCall: hangup,
        }),
        config: VoiceCallConfigSchema.parse({ voicemail }),
      });
      ctx.activeCalls.set(call.callId, call);
      await processEvent(ctx, detection("machine_end_beep"));
      await started.promise;
      expect(playRealtimeVoicemail).toHaveBeenCalledWith(
        call.callId,
        expect.stringContaining("We will call again later."),
      );
      expect(carrier).not.toHaveBeenCalled();
      expect(beforeCarrierPlayback).not.toHaveBeenCalled();
      expect(hangup).not.toHaveBeenCalled();
      if (failed) {
        playback.reject(new Error("No audible voicemail"));
      } else {
        playback.resolve();
      }
      await Promise.all(work);
      expect(hangup).toHaveBeenCalledTimes(1);
      expect(call.endReason).toBe(failed ? "error" : "voicemail");
      expect(call.metadata?.voicemailStatus).toBe(failed ? "failed" : "left");
    },
  );

  it("prepares the bridge once and persists the intended message before carrier playback", async () => {
    const prepared = createDeferred<void>();
    const work: Promise<unknown>[] = [];
    const preparing = createDeferred<void>();
    const beforeCarrierPlayback = vi.fn(() => {
      preparing.resolve();
      return prepared.promise;
    });
    const hangup = vi.fn(async () => {});
    const call = callRecord({
      brief: { task: "Arrange a plumber", voicemailMessage: "Please call me back." },
    });
    const playMessageAndHangup = vi.fn(async () => {
      expect(call.metadata?.voicemailStatus).toBe("playing");
      expect(call.transcript).toMatchObject([{ speaker: "bot", text: "Please call me back." }]);
    });
    const ctx = createContext({
      beforeCarrierPlayback,
      trackCallWork: (item) => {
        work.push(item);
      },
      provider: createProvider({ name: "twilio", playMessageAndHangup, hangupCall: hangup }),
      config: VoiceCallConfigSchema.parse({ voicemail }),
    });
    ctx.activeCalls.set(call.callId, call);
    await processEvent(ctx, detection("machine_end_beep"));
    await processEvent(ctx, detection("machine_end_beep", "redelivery"));
    await preparing.promise;
    expect(beforeCarrierPlayback).toHaveBeenCalledExactlyOnceWith(call.callId);
    expect(playMessageAndHangup).not.toHaveBeenCalled();
    prepared.resolve();
    await Promise.all(work);
    expect(playMessageAndHangup).toHaveBeenCalledExactlyOnceWith({
      callId: call.callId,
      providerCallId: "CA-amd",
      text: "Please call me back.",
    });
    expect(hangup).not.toHaveBeenCalled();
    expect(call.endReason).toBeUndefined();
    await processEvent(ctx, {
      id: "complete",
      type: "call.ended",
      callId: call.callId,
      timestamp: Date.now(),
      reason: "completed",
    });
    expect(call.metadata?.voicemailStatus).toBe("left");
    expect(call.endReason).toBe("voicemail");
  });

  it.each(["prepare", "request"])(
    "records %s failure without claiming voicemail was left",
    async (failure) => {
      const work: Promise<unknown>[] = [];
      const fail = async () => {
        throw new Error("carrier handoff failed");
      };
      const playMessageAndHangup = vi.fn(failure === "request" ? fail : async () => {});
      const hangup = vi.fn(async () => {});
      const ctx = createContext({
        beforeCarrierPlayback: failure === "prepare" ? fail : async () => {},
        trackCallWork: (item) => {
          work.push(item);
        },
        provider: createProvider({ name: "twilio", playMessageAndHangup, hangupCall: hangup }),
        config: VoiceCallConfigSchema.parse({ voicemail }),
      });
      const call = callRecord();
      ctx.activeCalls.set(call.callId, call);
      await processEvent(ctx, detection("machine_end_silence"));
      await Promise.all(work);
      expect(playMessageAndHangup).toHaveBeenCalledTimes(failure === "request" ? 1 : 0);
      expect(call.metadata).toMatchObject({
        voicemailStatus: "failed",
        voicemailError: "carrier handoff failed",
      });
      expect(call.endReason).toBe("error");
    },
  );

  it.each(["human", "unknown", "machine_end_beep"])(
    "holds notify speech until classification %s, then plays the right message once",
    async (answeredBy) => {
      const work: Promise<unknown>[] = [];
      const playMessageAndHangup = vi.fn(async () => {});
      const hangup = vi.fn(async () => {});
      const ctx = createContext({
        trackCallWork: (item) => {
          work.push(item);
        },
        provider: createProvider({ name: "twilio", playMessageAndHangup, hangupCall: hangup }),
        config: VoiceCallConfigSchema.parse({ voicemail }),
      });
      const call = callRecord({
        mode: "notify",
        pendingNotifyAmd: true,
        initialMessage: "Your parcel is ready.",
        brief: { voicemailMessage: "Please collect your parcel." },
      });
      ctx.activeCalls.set(call.callId, call);
      await processEvent(ctx, detection(answeredBy));
      await processEvent(ctx, detection(answeredBy, "redelivery"));
      await Promise.all(work);
      expect(playMessageAndHangup).toHaveBeenCalledExactlyOnceWith({
        callId: call.callId,
        providerCallId: "CA-amd",
        text:
          answeredBy === "machine_end_beep"
            ? "Please collect your parcel."
            : "Your parcel is ready.",
      });
      expect(hangup).not.toHaveBeenCalled();
      await processEvent(ctx, {
        id: "complete",
        type: "call.ended",
        callId: call.callId,
        timestamp: Date.now(),
        reason: "completed",
      });
      expect(call.endReason).toBe(answeredBy === "machine_end_beep" ? "voicemail" : "completed");
    },
  );

  it.each(["off", "hang-up"] as const)("handles AMD policy %s without speaking", async (mode) => {
    const work: Promise<unknown>[] = [];
    const playMessageAndHangup = vi.fn(async () => {});
    const hangup = vi.fn(async () => {});
    const ctx = createContext({
      trackCallWork: (item) => {
        work.push(item);
      },
      provider: createProvider({ name: "twilio", playMessageAndHangup, hangupCall: hangup }),
      config: VoiceCallConfigSchema.parse({
        voicemail: { detection: mode === "off" ? "off" : "twilio", onMachine: "hang-up" },
      }),
    });
    const call = callRecord();
    ctx.activeCalls.set(call.callId, call);
    await processEvent(ctx, detection("machine_start"));
    await Promise.all(work);
    expect(playMessageAndHangup).not.toHaveBeenCalled();
    expect(hangup).toHaveBeenCalledTimes(mode === "off" ? 0 : 1);
    expect(call.metadata?.voicemailStatus).toBe(mode === "off" ? undefined : "hang-up");
  });
});
