import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCallDelivery, type CallDeliveryMessage } from "./call-delivery.js";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import {
  createManagerHarness,
  FakeProvider,
  registerTestManagerCleanup,
} from "./manager.test-harness.js";
import type { CallRecord } from "./types.js";

// These manager scenarios cover lifecycle races that a real carrier cannot reliably trigger.
// Required outcomes: terminal redelivery never duplicates reports; pending final speech flushes
// before the report; failed sends are recorded; stopping joins accepted work and clears timers.
describe("requester call delivery", () => {
  afterEach(() => vi.useRealTimers());

  async function setup(overrides: Record<string, unknown> = {}) {
    const config = VoiceCallConfigSchema.parse({
      reports: { enabled: true, includeTranscript: true },
      live: { transcript: false, minIntervalMs: 1000 },
      ...overrides,
    });
    const { manager, storePath } = await createManagerHarness();
    const messages: CallDeliveryMessage[] = [];
    const summarize = vi.fn(
      async (_call: CallRecord) => "Achieved: plumber booked for Friday at 09:00.",
    );
    const delivery = createCallDelivery({
      config,
      deliver: async (message) => {
        messages.push(message);
      },
      summarize,
      persist: (call) => manager.persistDeliveryStatus(call),
    });
    manager.onCallUpdated = delivery.observe;
    const result = await manager.initiateCall("+15550000001", "voice-session", {
      requesterSessionKey: "agent:owner:telegram:direct:42",
    });
    const call = expectDefined(manager.getCall(result.callId), "initiated call");
    call.metadata = {
      ...call.metadata,
      brief: { task: "Book a plumber", approvals: "No deposit" },
    };
    return { manager, call, config, delivery, messages, storePath, summarize };
  }

  async function speech(
    manager: Awaited<ReturnType<typeof setup>>["manager"],
    call: CallRecord,
    speaker: "bot" | "user",
    text: string,
    id = text,
  ) {
    await manager.processEvent(
      speaker === "bot"
        ? {
            id,
            callId: call.callId,
            timestamp: Date.now(),
            type: "call.assistant-speech",
            transcript: text,
          }
        : {
            id,
            callId: call.callId,
            timestamp: Date.now(),
            type: "call.speech",
            transcript: text,
            isFinal: true,
          },
    );
  }

  async function end(manager: Awaited<ReturnType<typeof setup>>["manager"], call: CallRecord) {
    await manager.processEvent({
      id: "ended",
      callId: call.callId,
      timestamp: Date.now(),
      type: "call.ended",
      reason: "hangup-user",
    });
  }

  it.each([true, false])(
    "reports once with includeTranscript=%s and persists delivery status",
    async (includeTranscript) => {
      const { manager, call, delivery, messages, summarize } = await setup({
        reports: { enabled: true, includeTranscript },
      });
      call.metadata = {
        ...call.metadata,
        callbackOfCallId: "original-call",
        answeredBy: "machine_end_beep",
        voicemailStatus: "failed",
        voicemailError: "playback failed",
        notifyStatus: "failed",
        notifyError: "notification playback failed",
      };
      await speech(manager, call, "bot", "Can you visit Friday?");
      await speech(manager, call, "user", "Friday at 09:00, reference P123.");
      await end(manager, call);
      await end(manager, call);
      await delivery.observe(call);
      await delivery.stop();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        sessionKey: "agent:owner:telegram:direct:42",
        kind: "report",
        callId: call.callId,
      });
      expect(expectDefined(messages[0], "first delivery message").text).toContain("Achieved:");
      expect(expectDefined(messages[0], "first delivery message").text).toContain(
        "End reason: hangup-user",
      );
      expect(expectDefined(messages[0], "first delivery message").text).toContain(
        "Callback to call: original-call",
      );
      expect(expectDefined(messages[0], "first delivery message").text).toContain(
        "Voicemail: failed",
      );
      expect(expectDefined(messages[0], "first delivery message").text).toContain(
        "Voicemail error: playback failed",
      );
      expect(expectDefined(messages[0], "first delivery message").text).toContain(
        "Notification: failed",
      );
      expect(expectDefined(messages[0], "first delivery message").text).toContain(
        "Notification error: notification playback failed",
      );
      expect(
        expectDefined(messages[0], "first delivery message").text.includes("reference P123"),
      ).toBe(includeTranscript);
      expect(summarize).toHaveBeenCalledOnce();
      expect(
        expectDefined(summarize.mock.calls[0], "call summary request")[0].metadata?.brief,
      ).toEqual({
        task: "Book a plumber",
        approvals: "No deposit",
      });
      expect(
        (await manager.getCallFromMemoryOrStore(call.callId))?.metadata?.callReport,
      ).toMatchObject({ status: "delivered" });
    },
  );

  it("batches only final speech from both sides and flushes before the report", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { manager, call, delivery, messages } = await setup({
      live: { transcript: true, minIntervalMs: 1000 },
    });
    await manager.processEvent({
      id: "partial",
      callId: call.callId,
      timestamp: Date.now(),
      type: "call.speech",
      transcript: "partial",
      isFinal: false,
    });
    await speech(manager, call, "user", "Hello");
    await speech(manager, call, "bot", "Can you visit Friday?");
    expect(messages).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    // The batch position is persisted before sending, so the send follows a store write.
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(expectDefined(messages[0], "first delivery message").text).toContain("Callee: Hello");
    expect(expectDefined(messages[0], "first delivery message").text).toContain(
      "Assistant: Can you visit Friday?",
    );
    expect(expectDefined(messages[0], "first delivery message").text).not.toContain("partial");
    await speech(manager, call, "user", "Friday at 09:00");
    await end(manager, call);
    await delivery.observe(call);
    await delivery.stop();
    expect(messages.map((message) => message.kind)).toEqual(["live", "live", "report"]);
    expect(expectDefined(messages[1], "terminal live transcript").text).toContain(
      "Friday at 09:00",
    );
  });

  it("resumes live transcript batches after a restart without resending earlier lines", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { manager, call, config, delivery, messages, storePath } = await setup({
      live: { transcript: true, minIntervalMs: 1000 },
    });
    await speech(manager, call, "user", "Hello");
    await speech(manager, call, "bot", "Can you visit Friday?");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(messages.map((message) => message.kind)).toEqual(["live"]));
    await delivery.stop();

    // A new process restores the still-active call from the store with a fresh delivery owner.
    const restarted = registerTestManagerCleanup(new CallManager(config, storePath));
    const resumed: CallDeliveryMessage[] = [];
    const nextDelivery = createCallDelivery({
      config,
      deliver: async (message) => {
        resumed.push(message);
      },
      summarize: async () => "Needs follow-up.",
      persist: (snapshot) => restarted.persistDeliveryStatus(snapshot),
    });
    restarted.onCallUpdated = nextDelivery.observe;
    await restarted.initialize(new FakeProvider(), "https://example.com/voice/webhook");
    const restored = expectDefined(restarted.getCall(call.callId), "restored call");
    await speech(restarted, restored, "user", "Friday at 09:00");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(resumed).toHaveLength(1));
    await nextDelivery.stop();

    expect(resumed).toHaveLength(1);
    const text = expectDefined(resumed[0], "resumed live batch").text;
    expect(text).toContain("Callee: Friday at 09:00");
    expect(text).not.toContain("Hello");
    expect(text).not.toContain("Can you visit Friday?");
  });

  it("reports inbound calls only to their configured session", async () => {
    const { manager, call, delivery, messages } = await setup({
      reports: { enabled: true, inboundSessionKey: "agent:owner:telegram:direct:42" },
    });
    call.direction = "inbound";
    delete call.metadata?.requesterSessionKey;
    delete call.sessionKey;
    await end(manager, call);
    await delivery.observe(call);
    await delivery.stop();
    expect(expectDefined(messages[0], "first delivery message").sessionKey).toBe(
      "agent:owner:telegram:direct:42",
    );
  });

  it("persists the final bridge transcript before producing the terminal report", async () => {
    const { manager, call, delivery, messages } = await setup();
    manager.beforeCallEnd = async (ending) => {
      await speech(manager, ending, "bot", "Confirmed Friday at 09:00", "bridge-final");
    };
    await end(manager, call);
    await delivery.observe(call);
    expect(expectDefined(messages[0], "first delivery message").text).toContain(
      "Assistant: Confirmed Friday at 09:00",
    );
    await delivery.stop();
  });

  it("records a failed report and still settles call shutdown", async () => {
    const { manager, call } = await setup();
    const delivery = createCallDelivery({
      config: VoiceCallConfigSchema.parse({ reports: { enabled: true } }),
      summarize: async () => "Needs follow-up.",
      deliver: async () => {
        throw new Error("session route unavailable");
      },
      persist: (snapshot) => manager.persistDeliveryStatus(snapshot),
    });
    manager.onCallUpdated = delivery.observe;
    await end(manager, call);
    await delivery.observe(call);
    await delivery.stop();
    expect(
      (await manager.getCallFromMemoryOrStore(call.callId))?.metadata?.callReport,
    ).toMatchObject({ status: "failed", error: "session route unavailable" });
  });

  it("stop cancels delayed live batches and ignores later call updates", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { manager, call, delivery, messages } = await setup({
      live: { transcript: true, minIntervalMs: 1000 },
    });
    await speech(manager, call, "user", "Hello");
    await delivery.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(messages).toEqual([]);
    await end(manager, call);
    expect(messages).toEqual([]);
  });
});
