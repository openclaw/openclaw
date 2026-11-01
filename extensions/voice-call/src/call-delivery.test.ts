import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
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
const requester = "agent:owner:telegram:direct:42";

function createDelivery(
  manager: CallManager,
  config: ReturnType<typeof normalizeVoiceCallConfig>,
  messages: CallDeliveryMessage[],
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
    runtime: {
      gateway: runtime.gateway,
      subagent: { complete: async () => ({ text: "Achieved: plumber booked for Friday." }) },
    },
    manager,
    runInServiceContext: (run) => run(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
}

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
    const delivery = createDelivery(manager, config, messages, beforeDeliver);
    const result = await manager.initiateCall("+15550000001", "voice-session", {
      requesterSessionKey: requester,
    });
    const call = expectDefined(manager.getCall(result.callId), "initiated call");
    return { manager, call, config, delivery, messages, storePath };
  }

  async function speech(
    manager: CallManager,
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

  async function end(manager: CallManager, call: CallRecord) {
    await manager.processEvent({
      id: "ended",
      callId: call.callId,
      timestamp: Date.now(),
      type: "call.ended",
      reason: "hangup-user",
    });
  }

  async function finish(
    manager: CallManager,
    call: CallRecord,
    delivery: ReturnType<typeof createDelivery>,
  ) {
    await end(manager, call);
    await delivery.observe(call);
    await delivery.stop();
  }

  function setupLive() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    return setup({ live: { transcript: true, minIntervalMs: 1000 } });
  }

  it.each([true, false])(
    "reports once with includeTranscript=%s and persists delivery status",
    async (includeTranscript) => {
      const { manager, call, delivery, messages } = await setup({
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
      manager.beforeCallEnd = (ending) =>
        speech(manager, ending, "bot", "Confirmed Friday at 09:00", "bridge-final");
      await end(manager, call);
      await finish(manager, call, delivery);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        sessionKey: requester,
        idempotencyKey: `voice-call:${call.callId}:report:0`,
      });
      const text = messages[0]?.text;
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
      expect(text?.includes("reference P123")).toBe(includeTranscript);
      expect(text?.includes("Assistant: Confirmed Friday at 09:00")).toBe(includeTranscript);
      const saved = await manager.getCallFromMemoryOrStore(call.callId);
      expect(saved?.metadata?.callReport).toMatchObject({ status: "delivered" });
    },
  );

  it("batches only final speech from both sides and flushes before the report", async () => {
    const { manager, call, delivery, messages } = await setupLive();
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
    const text = messages[0]?.text;
    expect(text).toContain("Callee: Hello");
    expect(text).toContain("Assistant: Can you visit Friday?");
    expect(text).not.toContain("partial");
    await speech(manager, call, "user", "Friday at 09:00");
    await finish(manager, call, delivery);
    expect(messages.map((message) => message.idempotencyKey.includes(":live:"))).toEqual([
      true,
      true,
      false,
    ]);
    expect(messages[1]?.text).toContain("Friday at 09:00");
  });

  it("reports inbound calls only to their configured session", async () => {
    const { manager, call, delivery, messages } = await setup({
      reports: { enabled: true, inboundSessionKey: requester },
    });
    call.direction = "inbound";
    delete call.metadata?.requesterSessionKey;
    delete call.sessionKey;
    await finish(manager, call, delivery);
    expect(messages[0]?.sessionKey).toBe(requester);
  });

  it.each(["sent", "pending"] as const)(
    "resumes a %s batch without replaying it",
    async (status) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const sending = createDeferred<void>();
      const release = createDeferred<void>();
      const { manager, call, config, delivery, messages, storePath } = await setup(
        { reports: { enabled: false }, live: { transcript: true, minIntervalMs: 1000 } },
        () => {
          sending.resolve();
          return status === "pending" ? release.promise : Promise.resolve();
        },
      );
      try {
        await speech(manager, call, "user", "Hello");
        await speech(manager, call, "bot", "Can you visit Friday?");
        await vi.advanceTimersByTimeAsync(1000);
        await sending.promise;
        if (status === "sent") {
          await vi.waitFor(() => expect(messages).toHaveLength(1));
          expect(messages[0]?.idempotencyKey).toContain(":live:");
          await delivery.stop();
        }
        const snapshot = structuredClone(
          expectDefined(await manager.getCallFromMemoryOrStore(call.callId), "saved call"),
        );
        expect(snapshot.metadata?.liveTranscriptDelivery).toMatchObject({ status, cursor: 2 });
        const recoveredStore = status === "sent" ? storePath : createTestStorePath();
        if (status === "pending") {
          await writeCallsToStore(recoveredStore, [snapshot]);
        }
        const restarted = registerTestManagerCleanup(new CallManager(config, recoveredStore));
        await restarted.initialize(new FakeProvider(), "https://example.com/voice/webhook");
        const restored = expectDefined(restarted.getCall(call.callId), "restored call");
        expect(restored.metadata?.liveTranscriptDelivery).toMatchObject({
          status: status === "sent" ? "sent" : "failed",
          ...(status === "pending" ? { error: "interrupted by restart" } : {}),
          cursor: 2,
        });
        const resumed: CallDeliveryMessage[] = [];
        const nextDelivery = createDelivery(restarted, config, resumed);
        try {
          await speech(restarted, restored, "user", "Friday at 09:00");
          if (status === "sent") {
            await vi.advanceTimersByTimeAsync(1000);
            await vi.waitFor(() => expect(resumed).toHaveLength(1));
          } else {
            await end(restarted, restored);
            await nextDelivery.observe(restored);
          }
          await nextDelivery.stop();
          expect(resumed).toHaveLength(1);
          expect(resumed[0]?.text).toContain("Callee: Friday at 09:00");
          expect(resumed[0]?.text).not.toContain("Hello");
          expect(resumed[0]?.text).not.toContain("Can you visit Friday?");
        } finally {
          await nextDelivery.stop();
        }
      } finally {
        if (status === "pending") {
          release.reject(new Error("simulated process interruption"));
        }
        await delivery.stop();
      }
    },
  );

  it("stop cancels delayed live batches and ignores later call updates", async () => {
    const { manager, call, delivery, messages } = await setupLive();
    await speech(manager, call, "user", "Hello");
    await delivery.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(messages).toEqual([]);
    await end(manager, call);
    expect(messages).toEqual([]);
  });
});
