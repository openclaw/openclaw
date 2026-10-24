import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCallDeliveryRuntime } from "./call-delivery-runtime.js";
import { normalizeVoiceCallConfig } from "./config.js";
import { CallManager } from "./manager.js";
import {
  createManagerHarness,
  createTestStorePath,
  FakeProvider,
  registerTestManagerCleanup,
  writeCallsToStore,
} from "./manager.test-harness.js";
import type { CallRecord } from "./types.js";

type CallDeliveryMessage = { sessionKey: string; text: string; idempotencyKey: string };

function createDelivery(
  manager: CallManager,
  config: ReturnType<typeof normalizeVoiceCallConfig>,
  messages: CallDeliveryMessage[],
  summarize: PluginRuntime["subagent"]["complete"] = vi.fn().mockResolvedValue({
    text: "Needs follow-up.",
  }),
  beforeDeliver?: () => Promise<void>,
) {
  const runtime = createPluginRuntimeMock();
  vi.spyOn(runtime.gateway, "request").mockImplementation(async (method, params) => {
    if (method === "sessions.describe") {
      return {
        session: {
          key: params?.key,
          sessionId: "requester-session",
          deliveryContext: { channel: "telegram", to: "42" },
        },
      };
    }
    expect(method).toBe("send");
    await beforeDeliver?.();
    const { sessionKey, message: text, idempotencyKey } = params ?? {};
    if (
      typeof sessionKey !== "string" ||
      typeof text !== "string" ||
      typeof idempotencyKey !== "string"
    ) {
      throw new Error("Expected a requester channel message");
    }
    messages.push({ sessionKey, text, idempotencyKey });
    return { ok: true };
  });
  return createCallDeliveryRuntime({
    config,
    coreConfig: { agents: { entries: { owner: {} } } },
    runtime: { gateway: runtime.gateway, subagent: { complete: summarize } },
    manager,
    runInServiceContext: (run) => run(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
}

// These manager scenarios cover lifecycle races that a real carrier cannot reliably trigger.
// Required outcomes: terminal redelivery never duplicates reports; pending final speech flushes
// before the report; failed sends are recorded; stopping joins accepted work and clears timers.
describe("requester call delivery", () => {
  afterEach(() => vi.useRealTimers());

  async function setup(
    overrides: Record<string, unknown> = {},
    beforeDeliver?: () => Promise<void>,
  ) {
    const config = normalizeVoiceCallConfig({
      reports: { enabled: true, includeTranscript: true },
      live: { transcript: false, minIntervalMs: 1000 },
      ...overrides,
    });
    const { manager, storePath } = await createManagerHarness();
    const messages: CallDeliveryMessage[] = [];
    const summarize = vi.fn<PluginRuntime["subagent"]["complete"]>().mockResolvedValue({
      text: "Achieved: plumber booked for Friday at 09:00.",
    });
    const delivery = createDelivery(manager, config, messages, summarize, beforeDeliver);
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
    await manager.processEvent({
      id,
      callId: call.callId,
      timestamp: Date.now(),
      transcript: text,
      ...(speaker === "bot"
        ? { type: "call.assistant-speech" as const }
        : { type: "call.speech" as const, isFinal: true }),
    });
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
        idempotencyKey: `voice-call:${call.callId}:report:0`,
      });
      const { text } = expectDefined(messages[0], "first delivery message");
      for (const line of [
        "Achieved:",
        "End reason: hangup-user",
        "Callback to call: original-call",
        "Voicemail: failed",
        "Voicemail error: playback failed",
        "Notification: failed",
        "Notification error: notification playback failed",
      ]) {
        expect(text).toContain(line);
      }
      expect(text.includes("reference P123")).toBe(includeTranscript);
      expect(summarize).toHaveBeenCalledOnce();
      expect(expectDefined(summarize.mock.calls[0], "call summary request")[0].message).toContain(
        JSON.stringify({ task: "Book a plumber", approvals: "No deposit" }),
      );
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
    const { text } = expectDefined(messages[0], "first delivery message");
    expect(text).toContain("Callee: Hello");
    expect(text).toContain("Assistant: Can you visit Friday?");
    expect(text).not.toContain("partial");
    await speech(manager, call, "user", "Friday at 09:00");
    await end(manager, call);
    await delivery.observe(call);
    await delivery.stop();
    expect(messages.map((message) => message.idempotencyKey.includes(":live:"))).toEqual([
      true,
      true,
      false,
    ]);
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
    await vi.waitFor(() => {
      expect(messages).toHaveLength(1);
      expect(messages[0]?.idempotencyKey).toContain(":live:");
    });
    await delivery.stop();

    // A new process restores the still-active call from the store with a fresh delivery owner.
    const restarted = registerTestManagerCleanup(new CallManager(config, storePath));
    const resumed: CallDeliveryMessage[] = [];
    const nextDelivery = createDelivery(restarted, config, resumed);
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

  it("records interrupted live delivery without replaying its uncertain transcript batch", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sending = createDeferred<void>();
    const release = createDeferred<void>();
    const { manager, call, config, delivery } = await setup(
      { reports: { enabled: false }, live: { transcript: true, minIntervalMs: 1000 } },
      () => {
        sending.resolve();
        return release.promise;
      },
    );
    try {
      await speech(manager, call, "user", "First line");
      await vi.advanceTimersByTimeAsync(1000);
      await sending.promise;
      const snapshot = structuredClone(
        expectDefined(await manager.getCallFromMemoryOrStore(call.callId), "pending call"),
      );
      expect(snapshot.metadata?.liveTranscriptDelivery).toMatchObject({
        status: "pending",
        cursor: 1,
      });

      const recoveredStore = createTestStorePath();
      await writeCallsToStore(recoveredStore, [snapshot]);
      const restarted = registerTestManagerCleanup(new CallManager(config, recoveredStore));
      await restarted.initialize(new FakeProvider(), "https://example.com/voice/webhook");
      const restored = expectDefined(restarted.getCall(call.callId), "restored call");
      expect(restored.metadata?.liveTranscriptDelivery).toMatchObject({
        status: "failed",
        error: "interrupted by restart",
        cursor: 1,
      });
      const resumed: CallDeliveryMessage[] = [];
      const nextDelivery = createDelivery(restarted, config, resumed);
      try {
        await speech(restarted, restored, "user", "Second line");
        await end(restarted, restored);
        await nextDelivery.observe(restored);
        expect(resumed).toHaveLength(1);
        expect(resumed[0]?.text).toContain("Second line");
        expect(resumed[0]?.text).not.toContain("First line");
      } finally {
        await nextDelivery.stop();
      }
    } finally {
      release.reject(new Error("simulated process interruption"));
      await delivery.stop();
    }
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
    const delivery = createDelivery(
      manager,
      normalizeVoiceCallConfig({ reports: { enabled: true } }),
      [],
      undefined,
      async () => {
        throw new Error("session route unavailable");
      },
    );
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
