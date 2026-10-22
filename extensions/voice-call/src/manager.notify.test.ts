import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { normalizeVoiceCallConfig } from "./config.js";
import { CallManager } from "./manager.js";
import {
  createManagerHarness,
  FakeProvider,
  markCallAnswered,
  registerTestManagerCleanup,
} from "./manager.test-harness.js";
import { PlivoProvider } from "./providers/plivo.js";
import { TwilioProvider } from "./providers/twilio.js";
import type { HangupCallInput } from "./types.js";

class FailFirstPlayTtsProvider extends FakeProvider {
  override async playTts(input: Parameters<FakeProvider["playTts"]>[0]): Promise<void> {
    this.playTtsCalls.push(input);
    if (this.playTtsCalls.length === 1) {
      throw new Error("synthetic tts failure");
    }
  }
}

class DelayedPlayTtsProvider extends FakeProvider {
  readonly started = createDeferred<void>();
  private playback?: ReturnType<typeof createDeferred<void>>;
  override async playTts(input: Parameters<FakeProvider["playTts"]>[0]): Promise<void> {
    this.playTtsCalls.push(input);
    this.started.resolve();
    const playback = (this.playback = createDeferred<void>());
    await playback.promise;
  }
  releaseCurrentPlayback(): void {
    this.playback?.resolve();
    this.playback = undefined;
  }
}

class FailStartListeningProvider extends FakeProvider {
  override async startListening(
    input: Parameters<FakeProvider["startListening"]>[0],
  ): Promise<void> {
    this.startListeningCalls.push(input);
    throw new Error("synthetic start listening failure");
  }
}

class FailHangupProvider extends FakeProvider {
  override async hangupCall(input: Parameters<FakeProvider["hangupCall"]>[0]): Promise<void> {
    this.hangupCalls.push(input);
    throw new Error("synthetic hangup failure");
  }
}

function requireCall(manager: HarnessManager, callId: string) {
  return expectDefined(manager.getCall(callId), `active call ${callId}`);
}

type HarnessManager = Awaited<ReturnType<typeof createManagerHarness>>["manager"];

async function initiateCallWithMessage(
  manager: HarnessManager,
  message: string,
  mode: "notify" | "conversation",
) {
  const { callId, success } = await manager.initiateCall("+15550000001", undefined, {
    message,
    mode,
  });
  expect(success).toBe(true);
  return callId;
}

async function answerCall(
  manager: HarnessManager,
  callId: string,
  eventId: string,
  providerCallId = "call-uuid",
) {
  const initialMessage = vi.spyOn(manager, "speakInitialMessage");
  try {
    await manager.processEvent({
      id: eventId,
      type: "call.answered",
      callId,
      providerCallId,
      timestamp: Date.now(),
    });
    // The answered event owns dispatch; its detached greeting owns persistence and playback.
    await Promise.allSettled(initialMessage.mock.results.map((result) => result.value));
  } finally {
    initialMessage.mockRestore();
  }
}

function expectFirstPlayTtsText(provider: FakeProvider, text: string) {
  expect(provider.playTtsCalls).toHaveLength(1);
  expect(provider.playTtsCalls[0]).toMatchObject({ text });
}

async function answered(
  config: Parameters<typeof createManagerHarness>[0],
  provider = new FakeProvider("twilio"),
  message = "Hello",
  mode: "notify" | "conversation" = "conversation",
) {
  const harness = await createManagerHarness(config, provider);
  const callId = await initiateCallWithMessage(harness.manager, message, mode);
  await answerCall(harness.manager, callId, "answered");
  return { ...harness, callId };
}

function captureWarning() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => warn.mockRestore());
  return warn;
}

function useNotifyClock() {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  // Registered before the harness so its LIFO cleanup drains work before restoring time.
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

async function expectNotifyHangup(manager: HarnessManager, provider: FakeProvider, callId: string) {
  await vi.advanceTimersByTimeAsync(2_999);
  expect(provider.hangupCalls).toEqual([]);
  expect(await manager.getCallForStream(callId)).toBeDefined();
  await vi.advanceTimersByTimeAsync(1);
  // The timer dispatches hangup; the queued read joins its real persistence before cleanup.
  expect(await manager.getCallForStream(callId)).toBeUndefined();
  expect(provider.hangupCalls).toEqual([
    { callId, providerCallId: "call-uuid", reason: "hangup-bot" },
  ]);
  expect(await manager.getCallFromMemoryOrStore(callId)).toMatchObject({
    state: "hangup-bot",
    endReason: "hangup-bot",
  });
}

describe("CallManager notify and mapping", () => {
  it("logs a failed notify auto-hangup and leaves the call active for retry", async () => {
    useNotifyClock();
    const warn = captureWarning();
    const { manager, provider, callId } = await answered(
      { outbound: { notifyHangupDelaySec: 1 } },
      new FailHangupProvider("plivo"),
      "Notify",
      "notify",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(provider.hangupCalls).toHaveLength(1);
    expect(manager.getCall(callId)).toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      `[voice-call] Notify mode failed to hang up call ${callId}: synthetic hangup failure`,
    );
  });

  it("lets realtime conversations own the initial greeting instead of posting legacy TwiML", async () => {
    const { manager, provider, callId } = await answered({
      realtime: { enabled: true, provider: "openai" },
    });
    expect(provider.playTtsCalls).toHaveLength(0);
    expect(requireCall(manager, callId).metadata).toMatchObject({ initialMessage: "Hello" });
  });

  it("speaks on answered when Twilio streaming is enabled but stream-connect path is unavailable", async () => {
    const twilioProvider = new FakeProvider("twilio");
    twilioProvider.twilioStreamConnectEnabled = false;
    const { provider } = await answered({ streaming: { enabled: true } }, twilioProvider);
    expectFirstPlayTtsText(provider, "Hello");
  });

  it("logs fire-and-forget initial-message failures instead of leaking unhandled rejections", async () => {
    const warn = captureWarning();
    const { provider, callId } = await answered(
      { streaming: { enabled: false } },
      new FailStartListeningProvider("twilio"),
    );
    expectFirstPlayTtsText(provider, "Hello");
    expect(provider.startListeningCalls).toHaveLength(1);
    expect(provider.startListeningCalls[0]).toMatchObject({ callId, providerCallId: "call-uuid" });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(expectDefined(warn.mock.calls.at(0), "console warn")[0])).toContain(
      `[voice-call] Failed to speak initial message for call ${callId}: synthetic start listening failure`,
    );
  });

  it("preserves initialMessage after a failed first playback and retries on next trigger", async () => {
    useNotifyClock();
    const { manager, provider, callId } = await answered(
      {},
      new FailFirstPlayTtsProvider("plivo"),
      "Retry me",
      "notify",
    );
    expect(provider.playTtsCalls).toHaveLength(1);
    expect(requireCall(manager, callId)).toMatchObject({
      state: "listening",
      metadata: { initialMessage: "Retry me" },
    });
    await answerCall(manager, callId, "evt-retry-2");
    const afterSuccess = requireCall(manager, callId);
    expect(provider.playTtsCalls).toHaveLength(2);
    expect(afterSuccess.metadata).not.toHaveProperty("initialMessage");
    await expectNotifyHangup(manager, provider, callId);
  });

  it("prevents concurrent initial-message replays while first playback is in flight", async () => {
    const provider = new DelayedPlayTtsProvider("twilio");
    const { manager, callId } = await answered({ streaming: { enabled: true } }, provider);
    expect(provider.playTtsCalls).toHaveLength(0);
    const first = manager.speakInitialMessage("call-uuid");
    const playbacks = [first];
    try {
      await provider.started.promise;
      expect(provider.playTtsCalls).toHaveLength(1);
      const repeated = manager.speakInitialMessage("call-uuid");
      playbacks.push(repeated);
      await repeated;
      expect(provider.playTtsCalls).toHaveLength(1);
    } finally {
      provider.releaseCurrentPlayback();
      await Promise.all(playbacks);
    }
    const call = requireCall(manager, callId);
    expect(call.metadata).not.toHaveProperty("initialMessage");
    expectFirstPlayTtsText(provider, "Hello");
  });
});

async function speech(manager: HarnessManager, callId: string, id: string, transcript: string) {
  await manager.processEvent({
    id,
    type: "call.speech",
    callId,
    providerCallId: "request-uuid",
    timestamp: Date.now(),
    transcript,
    isFinal: true,
  });
}

async function waitForListening(
  manager: HarnessManager,
  provider: FakeProvider,
  callId: string,
  count: number,
) {
  await vi.waitFor(() => {
    expect(provider.startListeningCalls).toHaveLength(count);
    const { transcriptWaiters } = manager as unknown as { transcriptWaiters: Map<string, unknown> };
    expect(transcriptWaiters.has(callId)).toBe(true);
  });
}

async function closedLoop() {
  const harness = await createManagerHarness({ transcriptTimeoutMs: 5000 });
  const started = await harness.manager.initiateCall("+15550000004");
  expect(started.success).toBe(true);
  await markCallAnswered(harness.manager, started.callId, "answered");
  return { ...harness, callId: started.callId };
}

describe("CallManager closed-loop turns", () => {
  it("rejects overlapping continueCall requests for the same call", async () => {
    const { manager, provider, callId } = await closedLoop();
    const first = manager.continueCall(callId, "First prompt");
    const second = await manager.continueCall(callId, "Second prompt");
    expect(second).toMatchObject({ success: false, error: "Already waiting for transcript" });
    await waitForListening(manager, provider, callId, 1);
    await speech(manager, callId, "evt-overlap-speech", "Done");
    expect(await first).toMatchObject({ success: true, transcript: "Done" });
    expect(provider.startListeningCalls).toHaveLength(1);
    expect(provider.stopListeningCalls).toHaveLength(1);
  });

  it("tracks latency metadata across multiple closed-loop turns", async () => {
    const { manager, provider, callId } = await closedLoop();
    let turn = 0;
    for (const ordinal of ["First", "Second"]) {
      const result = manager.continueCall(callId, `${ordinal} question`);
      await waitForListening(manager, provider, callId, ++turn);
      await speech(manager, callId, `speech-${turn}`, `${ordinal} answer`);
      const reply = await result;
      if (turn === 2) {
        expect(reply.success).toBe(true);
      }
    }
    const call = requireCall(manager, callId);
    expect(call.transcript.map((entry) => entry.text)).toEqual([
      "First question",
      "First answer",
      "Second question",
      "Second answer",
    ]);
    expect(call.metadata).toMatchObject({
      turnCount: 2,
      lastTurnLatencyMs: expect.any(Number),
      lastTurnListenWaitMs: expect.any(Number),
    });
    expect(provider.startListeningCalls).toHaveLength(2);
    expect(provider.stopListeningCalls).toHaveLength(2);
  });
});

function inbound(
  providerCallId: string,
  from: string | undefined,
  type: "call.initiated" | "call.ringing" = "call.initiated",
  callId = providerCallId,
) {
  return {
    id: `${callId}-${type}`,
    type,
    callId,
    providerCallId,
    timestamp: Date.now(),
    direction: "inbound" as const,
    from,
    to: "+15550000000",
  };
}

describe("CallManager inbound allowlist", () => {
  it.each([
    { label: "missing caller ID", from: undefined },
    { label: "an allowlist suffix", from: "+99915550001234" },
  ])("rejects inbound calls with $label", async ({ from }) => {
    const { manager, provider } = await createManagerHarness({
      inboundPolicy: "allowlist",
      allowFrom: ["+15550001234"],
    });
    await manager.processEvent(
      inbound("provider-rejected", from, "call.initiated", "call-rejected"),
    );
    expect(manager.getCallByProviderCallId("provider-rejected")).toBeUndefined();
    expect(provider.hangupCalls).toHaveLength(1);
    expect(provider.hangupCalls[0]?.providerCallId).toBe("provider-rejected");
  });

  it("retries rejected inbound hangup after a transient provider failure", async () => {
    class FlakyHangupProvider extends FakeProvider {
      override async hangupCall(input: Parameters<FakeProvider["hangupCall"]>[0]): Promise<void> {
        this.hangupCalls.push(input);
        if (this.hangupCalls.length === 1) {
          throw new Error("provider down");
        }
      }
    }
    const provider = new FlakyHangupProvider();
    const { manager } = await createManagerHarness({ inboundPolicy: "disabled" }, provider);
    await manager.processEvent(inbound("provider-flaky", "+15553333333"));
    await Promise.resolve();
    await manager.processEvent(inbound("provider-flaky", "+15553333333", "call.ringing"));
    expect(manager.getCallByProviderCallId("provider-flaky")).toBeUndefined();
    expect(provider.hangupCalls).toHaveLength(2);
    expect(provider.hangupCalls.map((call) => call.providerCallId)).toEqual([
      "provider-flaky",
      "provider-flaky",
    ]);
  });
});

class DeferredHangupProvider extends FakeProvider {
  readonly attempts: Array<ReturnType<typeof createDeferred<void>>> = [];
  override hangupCall(input: HangupCallInput): Promise<void> {
    this.hangupCalls.push(input);
    const attempt = createDeferred<void>();
    this.attempts.push(attempt);
    return attempt.promise;
  }
}

async function initiateCall() {
  const provider = new DeferredHangupProvider();
  const { manager } = await createManagerHarness({}, provider);
  const result = await manager.initiateCall("+15550000001");
  expect(result.success).toBe(true);
  const call = requireCall(manager, result.callId);
  return { call, manager, provider };
}

describe("CallManager termination lifecycle", () => {
  it.each(["twilio", "plivo"] as const)(
    "keeps finalized identity for fresh %s callbacks after restart",
    async (providerName) => {
      const config = normalizeVoiceCallConfig({
        enabled: true,
        provider: providerName,
        fromNumber: "+15550000000",
        agentId: "default-agent",
      });
      const { manager, provider, storePath } = await createManagerHarness(
        config,
        new FakeProvider(providerName),
      );
      const started = await manager.initiateCall("+15550000001", "agent:sales:voice:fixture", {
        agentId: "sales",
      });
      expect(started.success).toBe(true);
      const initialProviderId = expectDefined(
        manager.getCall(started.callId)?.providerCallId,
        "initiated provider call",
      );
      const parser =
        providerName === "twilio"
          ? new TwilioProvider({ accountSid: "AC-fixture", authToken: "synthetic-token" })
          : new PlivoProvider({ authId: "MA-fixture", authToken: "synthetic-token" });
      const callback = (providerId: string, callStatus: string, includeInternalId: boolean) => {
        const query: Record<string, string> = includeInternalId
          ? { callId: started.callId, type: "status" }
          : {};
        const rawBody = new URLSearchParams({
          CallStatus: callStatus,
          From: "+15550000000",
          To: "+15550000001",
          Direction: providerName === "twilio" ? "outbound-api" : "outbound",
          ...(providerName === "twilio" ? { CallSid: providerId } : { RequestUUID: providerId }),
          ...(providerName === "plivo" && includeInternalId ? { CallUUID: "call-uuid" } : {}),
        }).toString();
        const parsed = parser.parseWebhookEvent({
          headers: {},
          rawBody,
          url: `https://example.com/voice/webhook?${new URLSearchParams(query)}`,
          method: "POST",
          query,
        });
        expect(parsed.events).toHaveLength(1);
        return expectDefined(parsed.events[0], "normalized provider callback");
      };
      await manager.processEvent(callback(initialProviderId, "in-progress", true));
      await expect(manager.speak(started.callId, "Recorded.")).resolves.toEqual({ success: true });
      await expect(manager.endCall(started.callId, { reason: "hangup-bot" })).resolves.toEqual({
        success: true,
      });
      const terminal = expectDefined(
        await manager.getCallFromMemoryOrStore(started.callId),
        "finalized call in SQLite",
      );
      expect(terminal).toMatchObject({
        agentId: "sales",
        sessionKey: "agent:sales:voice:fixture",
        state: "hangup-bot",
        transcript: [expect.objectContaining({ text: "Recorded." })],
      });
      resetPluginStateStoreForTests();
      const current = registerTestManagerCleanup(new CallManager(config, storePath));
      await current.initialize(provider, "https://example.com/voice/webhook");
      const late = callback(
        initialProviderId,
        providerName === "plivo" ? "ringing" : "completed",
        providerName === "twilio",
      );
      expect((await current.processEvent(late)).kind).not.toBe("final-speech");
      const history = await current.getCallHistory();
      expect(new Set(history.map((call) => call.callId))).toEqual(new Set([started.callId]));
      expect(await current.getCallFromMemoryOrStore(initialProviderId)).toMatchObject({
        ...terminal,
        processedEventIds: expect.arrayContaining(terminal.processedEventIds),
      });
      expect(current.getActiveCalls()).toEqual([]);
      expect(provider.playTtsCalls).toHaveLength(1);
      expect(provider.hangupCalls).toHaveLength(1);
      expect(provider.startListeningCalls).toEqual([]);
    },
  );

  it("preserves the first provider terminal facts when a pending manager hangup settles", async () => {
    const { call, manager, provider } = await initiateCall();
    const endedAt = Date.now() + 1_000;
    const pendingEnd = manager.endCall(call.callId, { reason: "timeout" });
    try {
      expect(provider.attempts).toHaveLength(1);
      await manager.processEvent({
        id: "provider-terminal",
        type: "call.ended",
        callId: call.callId,
        providerCallId: call.providerCallId,
        timestamp: endedAt,
        reason: "completed",
      });
    } finally {
      for (const attempt of provider.attempts) {
        attempt.resolve();
      }
      await pendingEnd;
    }
    await expect(pendingEnd).resolves.toEqual({ success: true });
    expect(call).toMatchObject({ state: "completed", endReason: "completed", endedAt });
  });

  it("shares one carrier hangup result and releases a failed operation for retry", async () => {
    const { call, manager, provider } = await initiateCall();
    const first = manager.endCall(call.callId, { reason: "error" });
    const second = manager.endCall(call.callId, { reason: "error" });
    const firstAttemptCount = provider.attempts.length;
    for (const attempt of provider.attempts) {
      attempt.reject(new Error("carrier unavailable"));
    }
    const [firstResult, secondResult] = await Promise.all([first, second]);
    const retry = manager.endCall(call.callId, { reason: "error" });
    try {
      expectDefined(provider.attempts.at(-1), "retry hangup attempt").resolve();
    } finally {
      for (const attempt of provider.attempts) {
        attempt.resolve();
      }
      await retry;
    }
    await expect(retry).resolves.toEqual({ success: true });
    expect(second).toBe(first);
    expect(firstAttemptCount).toBe(1);
    expect(secondResult).toBe(firstResult);
    expect(firstResult).toEqual({ success: false, error: "carrier unavailable" });
    expect(provider.hangupCalls).toHaveLength(2);
  });
});
