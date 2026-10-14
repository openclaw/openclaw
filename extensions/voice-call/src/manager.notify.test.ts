import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
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
  private failed = false;

  override async playTts(input: Parameters<FakeProvider["playTts"]>[0]): Promise<void> {
    this.playTtsCalls.push(input);
    if (!this.failed) {
      this.failed = true;
      throw new Error("synthetic tts failure");
    }
  }
}

class DelayedPlayTtsProvider extends FakeProvider {
  private releasePlayTts: (() => void) | null = null;
  private resolvePlayTtsStarted: (() => void) | null = null;
  readonly playTtsStarted = vi.fn();
  readonly playTtsStartedPromise = new Promise<void>((resolve) => {
    this.resolvePlayTtsStarted = resolve;
  });

  override async playTts(input: Parameters<FakeProvider["playTts"]>[0]): Promise<void> {
    this.playTtsCalls.push(input);
    this.playTtsStarted();
    this.resolvePlayTtsStarted?.();
    this.resolvePlayTtsStarted = null;
    await new Promise<void>((resolve) => {
      this.releasePlayTts = resolve;
    });
  }

  releaseCurrentPlayback(): void {
    this.releasePlayTts?.();
    this.releasePlayTts = null;
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

function requireFirstPlayTtsCall(provider: FakeProvider) {
  const call = provider.playTtsCalls.at(0);
  if (!call) {
    throw new Error("expected provider.playTts to be called once");
  }
  return call;
}

const requireRecord = createRequireRecord("record", "expected-label-record");

function requireSingleStartListeningCall(provider: FakeProvider) {
  expect(provider.startListeningCalls).toHaveLength(1);
  return requireRecord(provider.startListeningCalls.at(0), "start listening call");
}

type HarnessManager = Awaited<ReturnType<typeof createManagerHarness>>["manager"];

async function initiateCallWithMessage(
  manager: HarnessManager,
  to: string,
  message: string,
  mode: "notify" | "conversation",
) {
  const { callId, success } = await manager.initiateCall(to, undefined, { message, mode });
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
  expect(requireFirstPlayTtsCall(provider).text).toBe(text);
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
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const provider = new FailHangupProvider("plivo");
      const { manager } = await createManagerHarness(
        { outbound: { notifyHangupDelaySec: 1 } },
        provider,
      );
      const callId = await initiateCallWithMessage(manager, "+15550000014", "Notify", "notify");

      await answerCall(manager, callId, "evt-notify-failed-hangup");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(provider.hangupCalls).toHaveLength(1);
      expect(manager.getCall(callId)).toBeDefined();
      expect(warn).toHaveBeenCalledWith(
        `[voice-call] Notify mode failed to hang up call ${callId}: synthetic hangup failure`,
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("lets realtime conversations own the initial greeting instead of posting legacy TwiML", async () => {
    const { manager, provider } = await createManagerHarness(
      { realtime: { enabled: true, provider: "openai" } },
      new FakeProvider("twilio"),
    );

    const callId = await initiateCallWithMessage(
      manager,
      "+15550000010",
      "Tell Nana dinner is at 6pm.",
      "conversation",
    );
    await answerCall(manager, callId, "evt-conversation-twilio-realtime");

    expect(provider.playTtsCalls).toHaveLength(0);
    const metadata = requireRecord(requireCall(manager, callId).metadata, "call metadata");
    expect(metadata.initialMessage).toBe("Tell Nana dinner is at 6pm.");
  });

  it("speaks on answered when Twilio streaming is enabled but stream-connect path is unavailable", async () => {
    const twilioProvider = new FakeProvider("twilio");
    twilioProvider.twilioStreamConnectEnabled = false;
    const { manager, provider } = await createManagerHarness(
      { streaming: { enabled: true } },
      twilioProvider,
    );

    const callId = await initiateCallWithMessage(
      manager,
      "+15550000009",
      "Twilio stream unavailable",
      "conversation",
    );
    await answerCall(manager, callId, "evt-conversation-twilio-stream-unavailable");

    expectFirstPlayTtsText(provider, "Twilio stream unavailable");
  });

  it("logs fire-and-forget initial-message failures instead of leaking unhandled rejections", async () => {
    const provider = new FailStartListeningProvider("twilio");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { manager } = await createManagerHarness({ streaming: { enabled: false } }, provider);

      const callId = await initiateCallWithMessage(
        manager,
        "+15550000013",
        "Twilio hello",
        "conversation",
      );
      await answerCall(manager, callId, "evt-initial-message-start-listening-fails");

      expectFirstPlayTtsText(provider, "Twilio hello");
      const startListeningCall = requireSingleStartListeningCall(provider);
      expect(startListeningCall.callId).toBe(callId);
      expect(startListeningCall.providerCallId).toBe("call-uuid");
      expect(warn).toHaveBeenCalledOnce();
      expect(String(expectDefined(warn.mock.calls.at(0), "console warn")[0])).toContain(
        `[voice-call] Failed to speak initial message for call ${callId}: synthetic start listening failure`,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("preserves initialMessage after a failed first playback and retries on next trigger", async () => {
    useNotifyClock();
    const provider = new FailFirstPlayTtsProvider("plivo");
    const { manager } = await createManagerHarness({}, provider);

    const callId = await initiateCallWithMessage(manager, "+15550000006", "Retry me", "notify");
    await answerCall(manager, callId, "evt-retry-1");

    const afterFailure = requireCall(manager, callId);
    expect(provider.playTtsCalls).toHaveLength(1);
    const metadata = requireRecord(afterFailure.metadata, "call metadata after failed playback");
    expect(metadata.initialMessage).toBe("Retry me");
    expect(afterFailure.state).toBe("listening");

    await answerCall(manager, callId, "evt-retry-2");

    const afterSuccess = requireCall(manager, callId);
    expect(provider.playTtsCalls).toHaveLength(2);
    expect(afterSuccess.metadata).not.toHaveProperty("initialMessage");
    await expectNotifyHangup(manager, provider, callId);
  });

  it("prevents concurrent initial-message replays while first playback is in flight", async () => {
    const provider = new DelayedPlayTtsProvider("twilio");
    const { manager } = await createManagerHarness({ streaming: { enabled: true } }, provider);

    const callId = await initiateCallWithMessage(
      manager,
      "+15550000008",
      "In-flight hello",
      "conversation",
    );
    await answerCall(manager, callId, "evt-stream-answered-concurrent");
    expect(provider.playTtsCalls).toHaveLength(0);

    const first = manager.speakInitialMessage("call-uuid");
    const playbacks = [first];
    try {
      await provider.playTtsStartedPromise;
      expect(provider.playTtsStarted).toHaveBeenCalledTimes(1);

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
    expectFirstPlayTtsText(provider, "In-flight hello");
  });
});

function expectTranscriptWaiter(
  manager: Awaited<ReturnType<typeof createManagerHarness>>["manager"],
  callId: string,
) {
  const waiters = (
    manager as unknown as {
      transcriptWaiters: Map<string, unknown>;
    }
  ).transcriptWaiters;
  expect(waiters.has(callId)).toBe(true);
}

describe("CallManager closed-loop turns", () => {
  it("rejects overlapping continueCall requests for the same call", async () => {
    const { manager, provider } = await createManagerHarness({
      transcriptTimeoutMs: 5000,
    });

    const started = await manager.initiateCall("+15550000004");
    expect(started.success).toBe(true);

    await markCallAnswered(manager, started.callId, "evt-overlap-answered");

    const first = manager.continueCall(started.callId, "First prompt");
    const second = await manager.continueCall(started.callId, "Second prompt");
    expect(second.success).toBe(false);
    expect(second.error).toBe("Already waiting for transcript");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(1);
      expectTranscriptWaiter(manager, started.callId);
    });

    await manager.processEvent({
      id: "evt-overlap-speech",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "Done",
      isFinal: true,
    });

    const firstResult = await first;
    expect(firstResult.success).toBe(true);
    expect(firstResult.transcript).toBe("Done");
    expect(provider.startListeningCalls).toHaveLength(1);
    expect(provider.stopListeningCalls).toHaveLength(1);
  });

  it("tracks latency metadata across multiple closed-loop turns", async () => {
    const { manager, provider } = await createManagerHarness({
      transcriptTimeoutMs: 5000,
    });

    const started = await manager.initiateCall("+15550000005");
    expect(started.success).toBe(true);

    await markCallAnswered(manager, started.callId, "evt-multi-answered");

    const firstTurn = manager.continueCall(started.callId, "First question");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(1);
      expectTranscriptWaiter(manager, started.callId);
    });
    await manager.processEvent({
      id: "evt-multi-speech-1",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "First answer",
      isFinal: true,
    });
    await firstTurn;

    const secondTurn = manager.continueCall(started.callId, "Second question");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(2);
      expectTranscriptWaiter(manager, started.callId);
    });
    await manager.processEvent({
      id: "evt-multi-speech-2",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "Second answer",
      isFinal: true,
    });
    const secondResult = await secondTurn;

    expect(secondResult.success).toBe(true);

    const call = expectDefined(manager.getCall(started.callId), `active call ${started.callId}`);
    expect(call.transcript.map((entry) => entry.text)).toEqual([
      "First question",
      "First answer",
      "Second question",
      "Second answer",
    ]);
    const metadata = call.metadata ?? {};
    expect(metadata.turnCount).toBe(2);
    expect(typeof metadata.lastTurnLatencyMs).toBe("number");
    expect(typeof metadata.lastTurnListenWaitMs).toBe("number");
    expect(provider.startListeningCalls).toHaveLength(2);
    expect(provider.stopListeningCalls).toHaveLength(2);
  });
});

describe("CallManager inbound allowlist", () => {
  it.each([
    { label: "missing caller ID", from: undefined },
    { label: "an allowlist suffix", from: "+99915550001234" },
  ])("rejects inbound calls with $label", async ({ from }) => {
    const { manager, provider } = await createManagerHarness({
      inboundPolicy: "allowlist",
      allowFrom: ["+15550001234"],
    });
    await manager.processEvent({
      id: "evt-allowlist-rejected",
      type: "call.initiated",
      callId: "call-rejected",
      providerCallId: "provider-rejected",
      timestamp: Date.now(),
      direction: "inbound",
      from,
      to: "+15550000000",
    });
    expect(manager.getCallByProviderCallId("provider-rejected")).toBeUndefined();
    expect(provider.hangupCalls).toHaveLength(1);
    expect(provider.hangupCalls[0]?.providerCallId).toBe("provider-rejected");
  });

  it("rejects duplicate inbound events with a single hangup call", async () => {
    const { manager, provider } = await createManagerHarness({
      inboundPolicy: "disabled",
    });

    await manager.processEvent({
      id: "evt-reject-init",
      type: "call.initiated",
      callId: "provider-dup",
      providerCallId: "provider-dup",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15552222222",
      to: "+15550000000",
    });

    await manager.processEvent({
      id: "evt-reject-ring",
      type: "call.ringing",
      callId: "provider-dup",
      providerCallId: "provider-dup",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15552222222",
      to: "+15550000000",
    });

    expect(manager.getCallByProviderCallId("provider-dup")).toBeUndefined();
    expect(provider.hangupCalls).toEqual([
      { callId: "provider-dup", providerCallId: "provider-dup", reason: "hangup-bot" },
    ]);
  });

  it("retries rejected inbound hangup after a transient provider failure", async () => {
    class FlakyHangupProvider extends FakeProvider {
      hangupFailuresRemaining = 1;

      override async hangupCall(input: Parameters<FakeProvider["hangupCall"]>[0]): Promise<void> {
        this.hangupCalls.push(input);
        if (this.hangupFailuresRemaining > 0) {
          this.hangupFailuresRemaining -= 1;
          throw new Error("provider down");
        }
      }
    }

    const provider = new FlakyHangupProvider();
    const { manager } = await createManagerHarness(
      {
        inboundPolicy: "disabled",
      },
      provider,
    );

    await manager.processEvent({
      id: "evt-reject-fail-init",
      type: "call.initiated",
      callId: "provider-flaky",
      providerCallId: "provider-flaky",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15553333333",
      to: "+15550000000",
    });
    await Promise.resolve();

    await manager.processEvent({
      id: "evt-reject-fail-ring",
      type: "call.ringing",
      callId: "provider-flaky",
      providerCallId: "provider-flaky",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15553333333",
      to: "+15550000000",
    });

    expect(manager.getCallByProviderCallId("provider-flaky")).toBeUndefined();
    expect(provider.hangupCalls).toHaveLength(2);
    expect(provider.hangupCalls.map((call) => call.providerCallId)).toEqual([
      "provider-flaky",
      "provider-flaky",
    ]);
  });

  it("accepts inbound calls that exactly match the allowlist", async () => {
    const { manager } = await createManagerHarness({
      inboundPolicy: "allowlist",
      allowFrom: ["+15550001234"],
    });

    await manager.processEvent({
      id: "evt-allowlist-exact",
      type: "call.initiated",
      callId: "call-exact",
      providerCallId: "provider-exact",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15550001234",
      to: "+15550000000",
    });

    const call = manager.getCallByProviderCallId("provider-exact");
    if (!call) {
      throw new Error("expected exact allowlist match to keep the inbound call");
    }
    expect(call.providerCallId).toBe("provider-exact");
    expect(call.direction).toBe("inbound");
    expect(call.from).toBe("+15550001234");
    expect(call.to).toBe("+15550000000");
    expect(call.callId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
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
  const call = manager.getCall(result.callId);
  if (!call) {
    throw new Error("expected initiated call");
  }
  return { call, manager, provider };
}

describe("CallManager termination lifecycle", () => {
  it.each(["twilio", "plivo"] as const)(
    "keeps finalized identity for fresh %s callbacks after restart",
    async (providerName) => {
      const config = VoiceCallConfigSchema.parse({
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
      const initialProviderId = manager.getCall(started.callId)?.providerCallId;
      if (!initialProviderId) {
        throw new Error("expected an initiated provider call");
      }
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
        const event = parsed.events[0];
        if (!event) {
          throw new Error("expected a normalized provider callback");
        }
        return event;
      };
      await manager.processEvent(callback(initialProviderId, "in-progress", true));
      await expect(
        manager.speak(started.callId, "Preserve this call transcript."),
      ).resolves.toEqual({
        success: true,
      });
      await expect(manager.endCall(started.callId, { reason: "hangup-bot" })).resolves.toEqual({
        success: true,
      });
      const terminal = await manager.getCallFromMemoryOrStore(started.callId);
      if (!terminal) {
        throw new Error("expected the finalized call in SQLite");
      }
      expect(terminal).toMatchObject({
        agentId: "sales",
        sessionKey: "agent:sales:voice:fixture",
        state: "hangup-bot",
        transcript: [expect.objectContaining({ text: "Preserve this call transcript." })],
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
    expect(call).toMatchObject({
      state: "completed",
      endReason: "completed",
      endedAt,
    });
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
      const retryAttempt = provider.attempts.at(-1);
      if (!retryAttempt) {
        throw new Error("expected retry hangup attempt");
      }
      retryAttempt.resolve();
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
