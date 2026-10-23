import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CallRecordSchema,
  type CallRecord,
  type InitiateCallInput,
  type OutboundCallOptions,
} from "../types.js";

const {
  clearMaxDurationTimerMock,
  startMaxDurationTimerMock,
  generateDtmfRedirectTwimlMock,
  generateNotifyTwimlMock,
  getCallByProviderCallIdMock,
  mapVoiceToPollyMock,
  persistCallRecordMock,
  rejectTranscriptWaiterMock,
} = vi.hoisted(() => ({
  clearMaxDurationTimerMock: vi.fn(),
  startMaxDurationTimerMock: vi.fn(),
  generateDtmfRedirectTwimlMock: vi.fn(),
  generateNotifyTwimlMock: vi.fn(),
  getCallByProviderCallIdMock: vi.fn(),
  mapVoiceToPollyMock: vi.fn(),
  persistCallRecordMock: vi.fn(),
  rejectTranscriptWaiterMock: vi.fn(),
}));

vi.mock("./store.js", () => ({
  persistCallRecord: persistCallRecordMock,
}));

vi.mock("./timers.js", () => ({
  clearMaxDurationTimer: clearMaxDurationTimerMock,
  clearTranscriptWaiter: vi.fn(),
  startMaxDurationTimer: startMaxDurationTimerMock,
  rejectTranscriptWaiter: rejectTranscriptWaiterMock,
  waitForFinalTranscript: vi.fn(),
}));

vi.mock("./lookup.js", () => ({
  getCallByProviderCallId: getCallByProviderCallIdMock,
}));

vi.mock("../voice-mapping.js", () => ({
  mapVoiceToPolly: mapVoiceToPollyMock,
}));

vi.mock("./twiml.js", () => ({
  generateDtmfRedirectTwiml: generateDtmfRedirectTwimlMock,
  generateNotifyTwiml: generateNotifyTwimlMock,
}));

import {
  continueCall,
  endCall,
  initiateCall,
  sendDtmf,
  speak,
  speakInitialMessage,
} from "./outbound.js";

function createCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return CallRecordSchema.parse({
    callId: "call-1",
    providerCallId: "provider-1",
    provider: "plivo",
    direction: "outbound",
    state: "active",
    from: "+15550000000",
    to: "+15550000001",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    ...overrides,
  });
}

function createContext(call?: CallRecord) {
  return {
    mutationQueue: new KeyedAsyncQueue(),
    isStopping: () => false,
    trackCallWork: vi.fn(),
    notifyHangupTimers: new Map(),
    pendingCallAdmissions: new Set<string>(),
    activeCalls: new Map<string, CallRecord>(call ? [[call.callId, call]] : []),
    providerCallIdMap: new Map<string, string>(),
    storePath: "/tmp/voice-call.json",
  };
}

function createActiveCallContext() {
  const call = createCall();
  const hangupCall = vi.fn(async () => {});
  const ctx = {
    ...createContext(call),
    providerCallIdMap: new Map([["provider-1", "call-1"]]),
    provider: { hangupCall },
    transcriptWaiters: new Map(),
    maxDurationTimers: new Map(),
    endCallOperations: new Map(),
  };

  return { call, ctx, hangupCall };
}

function dial<T extends object>(config: T, name = "twilio", providerCallId = "provider-1") {
  const initiateProviderCall = vi.fn(async (_input: InitiateCallInput) => ({ providerCallId }));
  const ctx = {
    ...createContext(),
    config: {
      maxConcurrentCalls: 3,
      outbound: { defaultMode: "conversation" },
      fromNumber: "+14155550100",
      ...config,
    },
    webhookUrl: "https://example.com/webhook",
    provider: { name, initiateCall: initiateProviderCall },
  };
  return {
    ctx,
    initiateProviderCall,
    place: (opts?: OutboundCallOptions, sessionKey?: string) =>
      initiateCall(ctx as never, "+14155550123", sessionKey, opts),
  };
}

function expectPlaced(result: Awaited<ReturnType<typeof initiateCall>>) {
  expect(result.success).toBe(true);
  expect(result.callId).toBeTypeOf("string");
  expect(result.callId).not.toBe("");
  return result.callId;
}

const placementInput = (callId: string) => ({
  callId,
  from: "+14155550100",
  to: "+14155550123",
  webhookUrl: "https://example.com/webhook",
});
const speechInput = (voice: string) => ({
  callId: "call-1",
  providerCallId: "provider-1",
  text: "hello",
  voice,
});

const openaiVoice = (voice: string) => ({
  tts: { provider: "openai", providers: { openai: { voice } } },
});

function speechContext(
  config: object = openaiVoice("alloy"),
  overrides: Partial<CallRecord> = {},
  name = "twilio",
) {
  const call = createCall(overrides);
  const playTts = vi.fn(async () => {});
  const ctx = {
    ...createContext(call),
    providerCallIdMap: new Map([["provider-1", "call-1"]]),
    provider: { name, playTts },
    initialMessageInFlight: new Set<string>(),
    activeTurnCalls: new Set<string>(),
    transcriptWaiters: new Map(),
    maxDurationTimers: new Map(),
    config,
  };
  return { call, playTts, ctx };
}

describe("voice-call outbound helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistCallRecordMock.mockReset().mockResolvedValue(undefined);
    mapVoiceToPollyMock.mockReturnValue("Polly.Joanna");
    generateDtmfRedirectTwimlMock.mockReturnValue("<DtmfRedirect />");
    generateNotifyTwimlMock.mockReturnValue("<Response />");
  });

  it("guards initiateCall when provider, webhook, capacity, or fromNumber are missing", async () => {
    const { ctx } = dial({ maxConcurrentCalls: 1, fromNumber: "" });
    for (const [override, error] of [
      [{ provider: undefined }, "Provider not initialized"],
      [{ webhookUrl: undefined }, "Webhook URL not configured"],
      [{ activeCalls: new Map([["existing", {}]]) }, "Maximum concurrent calls (1) reached"],
      [{}, "fromNumber not configured"],
    ] as const) {
      await expect(initiateCall({ ...ctx, ...override } as never, "+14155550123")).resolves.toEqual(
        {
          callId: "",
          success: false,
          error,
        },
      );
    }
  });

  it("holds Twilio notify calls silently until AMD classification", async () => {
    const {
      ctx,
      place,
      initiateProviderCall: initiate,
    } = dial(
      { voicemail: { detection: "twilio", onMachine: "leave-message" } },
      "twilio",
      "CA-notify",
    );
    await place({
      mode: "notify",
      message: "Your parcel is ready.",
    });
    expect(initiate.mock.calls[0]?.[0]).toMatchObject({
      inlineTwiml: '<Response><Pause length="60"/></Response>',
    });
    const call = [...ctx.activeCalls.values()][0];
    expect(call?.metadata?.pendingNotifyAmd).toBe(true);
    const playTts = vi.fn(async () => {});
    getCallByProviderCallIdMock.mockReturnValue(call);
    await speakInitialMessage(
      { ...ctx, initialMessageInFlight: new Set(), provider: { name: "twilio", playTts } } as never,
      "CA-notify",
    );
    expect(playTts).not.toHaveBeenCalled();
  });

  it.each(["notify", "conversation"] as const)(
    "initiates %s calls with TwiML and provider ids",
    async (mode) => {
      const setup = dial(openaiVoice("nova"));
      const { initiateProviderCall } = setup;
      const ctx = { ...setup.ctx, coreSession: { mainKey: "work" } };
      const message = mode === "notify" ? "hello there" : "hello meet";
      const result = await initiateCall(ctx as never, "+14155550123", "main", {
        mode,
        message,
        ...(mode === "conversation" ? { dtmfSequence: "ww123456#" } : {}),
      });
      const callId = expectPlaced(result);
      if (mode === "notify") {
        expect(mapVoiceToPollyMock).toHaveBeenCalledWith("nova");
        expect(generateNotifyTwimlMock).toHaveBeenCalledWith(message, "Polly.Joanna");
      } else {
        expect(generateDtmfRedirectTwimlMock).toHaveBeenCalledWith(
          "ww123456#",
          "https://example.com/webhook",
        );
      }
      expect(initiateProviderCall).toHaveBeenCalledWith({
        ...placementInput(callId),
        ...(mode === "notify"
          ? { inlineTwiml: "<Response />" }
          : {
              inlineTwiml: undefined,
              preConnectTwiml: "<DtmfRedirect />",
            }),
      });
      expect(ctx.providerCallIdMap.get("provider-1")).toBe(callId);
      expect(ctx.activeCalls.get(callId)).toMatchObject({
        sessionKey: "agent:main:work",
        metadata: { initialMessage: message, mode },
      });
      expect(persistCallRecordMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])(
    "persists configured or per-call agent identity (override=%s)",
    async (override) => {
      const { ctx, place } = dial({ agentId: "operator", sessionScope: "per-call" });
      const sessionKey = "agent:support:google-meet:meet-1";
      const callId = expectPlaced(
        await place(
          override ? { agentId: "Support" } : undefined,
          override ? sessionKey : undefined,
        ),
      );
      expect(ctx.activeCalls.get(callId)).toMatchObject({
        sessionKey: override ? sessionKey : `agent:operator:voice:call:${callId}`,
        agentId: override ? "support" : "operator",
      });
    },
  );

  it.each(["off", "twilio"] as const)(
    "caps a prepared brief and records voicemail ownership with detection=%s",
    async (detection) => {
      const { ctx, place, initiateProviderCall } = dial(
        {
          maxDurationSeconds: 300,
          voicemail: { detection, onMachine: "leave-message" },
        },
        "mock",
        "provider-brief",
      );
      const brief = { task: "Book a plumber", maxDurationSeconds: 600 };
      const result = await place({ brief });
      expect(ctx.activeCalls.get(result.callId)?.metadata).toMatchObject({
        brief,
        maxDurationSeconds: 300,
      });
      expect(ctx.activeCalls.get(result.callId)?.metadata?.voicemailManagedByHost).toBe(
        detection === "twilio" ? true : undefined,
      );
      expect(initiateProviderCall).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects DTMF sequences outside conversation mode", async () => {
    const { ctx, place, initiateProviderCall } = dial({
      outbound: { defaultMode: "notify" },
    });

    await expect(
      place(
        {
          message: "hello",
          dtmfSequence: "123456#",
        },
        "session-1",
      ),
    ).resolves.toEqual({
      callId: "",
      success: false,
      error: "dtmfSequence requires conversation mode",
    });

    expect(initiateProviderCall).not.toHaveBeenCalled();
    expect(ctx.activeCalls.size).toBe(0);
  });

  it("fails initiateCall cleanly when provider initiation throws", async () => {
    const { ctx, place, initiateProviderCall } = dial({ fromNumber: undefined }, "mock");
    initiateProviderCall.mockRejectedValueOnce(new Error("provider down"));
    const result = await place();
    expect(result).toMatchObject({ success: false, error: "provider down" });
    expect(result.callId).toBeTypeOf("string");
    expect(result.callId).not.toBe("");
    expect(ctx.activeCalls.size).toBe(0);
  });

  it("speaks through connected calls and rolls back to listening on provider errors", async () => {
    const { call, playTts, ctx } = speechContext();

    await expect(
      speak(ctx as never, "call-1", "hello", { listenAfterPlayback: true }),
    ).resolves.toEqual({ success: true });
    expect(call.state).toBe("speaking");
    expect(playTts).toHaveBeenCalledWith({
      ...speechInput("alloy"),
      listenAfterPlayback: true,
    });
    expect(call.transcript).toEqual([expect.objectContaining({ speaker: "bot", text: "hello" })]);

    playTts.mockImplementationOnce(async () => {
      throw new Error("tts failed");
    });
    await expect(speak(ctx as never, "call-1", "hello again")).resolves.toEqual({
      success: false,
      error: "tts failed",
    });
    expect(call.state).toBe("listening");
  });

  it("reports telephony queue overflow without starting a silent listening turn", async () => {
    const { call, playTts, ctx: base } = speechContext({ tts: { provider: "openai" } });
    playTts.mockImplementation(async () => {
      throw new Error("Telephony TTS queue is full for stream; maxPending=8");
    });
    const startListening = vi.fn(async () => {});
    const ctx = {
      ...base,
      provider: {
        name: "twilio",
        playTts,
        startListening,
        stopListening: vi.fn(async () => {}),
      },
    };

    await expect(continueCall(ctx as never, "call-1", "hello")).resolves.toEqual({
      success: false,
      error: "Telephony TTS queue is full for stream; maxPending=8",
    });

    expect(playTts).toHaveBeenCalledOnce();
    expect(startListening).not.toHaveBeenCalled();
    expect(ctx.activeTurnCalls.size).toBe(0);
    expect(call.state).toBe("listening");
  });

  it("caps notify-mode auto-hangup delay before scheduling", async () => {
    const { call, ctx } = speechContext(
      { ...openaiVoice("alloy"), outbound: { notifyHangupDelaySec: Number.MAX_SAFE_INTEGER } },
      { metadata: { initialMessage: "hello", mode: "notify" } },
    );
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    getCallByProviderCallIdMock.mockReturnValue(call);

    try {
      await speakInitialMessage(ctx as never, "provider-1");
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it.each([
    ["twilio", "inbound", "alloy"],
    ["twilio", "outbound", "coral"],
    ["telnyx", "outbound", "Telnyx.Qwen3TTS.12345678-1234-1234-1234-123456789abc"],
  ] as const)("uses the configured %s voice for %s calls", async (provider, direction, voice) => {
    const { ctx, playTts } = speechContext(
      provider === "telnyx"
        ? {
            tts: { provider, providers: { telnyx: { voiceId: voice } } },
          }
        : {
            ...openaiVoice("coral"),
            numbers: { "+15550002222": { tts: { providers: { openai: { voice: "alloy" } } } } },
          },
      {
        direction,
        to: "+15550002222",
        ...(direction === "inbound" ? { metadata: { numberRouteKey: "+15550002222" } } : {}),
      },
      provider,
    );
    await expect(speak(ctx as never, "call-1", "hello")).resolves.toEqual({ success: true });
    expect(playTts).toHaveBeenCalledWith(speechInput(voice));
  });

  it("sends DTMF through connected provider calls", async () => {
    const sendDtmfProvider = vi.fn(async () => {});
    const ctx = {
      ...createContext(createCall()),
      provider: { name: "twilio", sendDtmf: sendDtmfProvider },
      config: {},
    };

    await expect(sendDtmf(ctx as never, "call-1", "ww123#")).resolves.toEqual({
      success: true,
    });
    expect(sendDtmfProvider).toHaveBeenCalledWith({
      callId: "call-1",
      providerCallId: "provider-1",
      digits: "ww123#",
    });
  });

  it("rejects invalid or unsupported outbound DTMF", async () => {
    const ctx = {
      ...createContext(createCall()),
      provider: { name: "telnyx" },
      config: {},
    };

    await expect(sendDtmf(ctx as never, "call-1", "abc")).resolves.toEqual({
      success: false,
      error: "digits may only contain digits, *, #, comma, w, p",
    });
    await expect(sendDtmf(ctx as never, "call-1", "123#")).resolves.toEqual({
      success: false,
      error: "telnyx does not support outbound DTMF",
    });
  });

  it.each([undefined, "timeout"] as const)(
    "ends connected calls with reason %s, clears timers, and rejects pending transcripts",
    async (reason) => {
      const { call, ctx, hangupCall } = createActiveCallContext();
      const expectedReason = reason ?? "hangup-bot";
      const beforeEndMs = Date.now();
      await expect(
        endCall(ctx as never, "call-1", reason ? { reason } : undefined),
      ).resolves.toEqual({ success: true });
      const afterEndMs = Date.now();
      expect(hangupCall).toHaveBeenCalledWith({
        callId: "call-1",
        providerCallId: "provider-1",
        reason: expectedReason,
      });
      expect(call).toMatchObject({ endReason: expectedReason, state: expectedReason });
      expect(call.endedAt).toBeTypeOf("number");
      expect(call.endedAt).toBeGreaterThanOrEqual(beforeEndMs);
      expect(call.endedAt).toBeLessThanOrEqual(afterEndMs);
      expect(clearMaxDurationTimerMock).toHaveBeenCalledWith(ctx, "call-1");
      expect(rejectTranscriptWaiterMock).toHaveBeenCalledWith(
        ctx,
        "call-1",
        `Call ended: ${expectedReason}`,
      );
      expect([ctx.activeCalls.size, ctx.providerCallIdMap.size]).toEqual([0, 0]);
    },
  );

  it("handles missing, disconnected, and already-ended calls", async () => {
    const { ctx: missing } = speechContext();
    await expect(speak(missing as never, "missing", "hello")).resolves.toEqual({
      success: false,
      error: "Call not found",
    });

    const { call, ctx } = createActiveCallContext();
    call.state = "completed";
    await expect(endCall(ctx as never, "call-1")).resolves.toEqual({ success: true });
  });

  it.each([
    ["telnyx", true, true],
    ["twilio", true, false],
    ["telnyx", false, false],
  ] as const)(
    "issues realtime stream credentials for %s enabled=%s",
    async (name, enabled, issued) => {
      const { ctx, initiateProviderCall } = dial({ realtime: { enabled } }, name);
      const credentials = {
        token: "token-xyz",
        streamUrl: "wss://example.test/voice/stream/realtime/token-xyz",
      };
      const streamSessionIssuer = vi.fn(() => credentials);
      const result = await initiateCall({ ...ctx, streamSessionIssuer } as never, "+14155550123");
      expect(result.success).toBe(true);
      expect(streamSessionIssuer).toHaveBeenCalledTimes(issued ? 1 : 0);
      if (issued) {
        expect(streamSessionIssuer).toHaveBeenCalledWith(
          expect.objectContaining({
            providerName: "telnyx",
            direction: "outbound",
            to: "+14155550123",
          }),
        );
      }
      const input = initiateProviderCall.mock.calls[0]?.[0];
      expect([input?.streamUrl, input?.streamAuthToken]).toEqual(
        issued ? [credentials.streamUrl, credentials.token] : [undefined, undefined],
      );
    },
  );
});
