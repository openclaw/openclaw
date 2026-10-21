import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CallRecordSchema, type CallRecord } from "../types.js";

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

function createActiveCallContext(params: { hangupCall?: ReturnType<typeof vi.fn> } = {}) {
  const call = createCall();
  const hangupCall = params.hangupCall ?? vi.fn(async () => {});
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

function createDialContext<T extends object>(config: T) {
  return {
    ...createContext(),
    config: {
      maxConcurrentCalls: 3,
      outbound: { defaultMode: "conversation" },
      fromNumber: "+14155550100",
      ...config,
    },
    webhookUrl: "https://example.com/webhook",
  };
}

function dial<T extends object>(config: T, name = "twilio", providerCallId = "provider-1") {
  const initiateProviderCall = vi.fn(async () => ({ providerCallId }));
  const ctx = {
    ...createDialContext(config),
    provider: { name, initiateCall: initiateProviderCall },
  };
  return { ctx, initiateProviderCall };
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
    const base = {
      ...createContext(),
      config: {
        maxConcurrentCalls: 1,
        outbound: { defaultMode: "conversation", notifyHangupDelaySec: 0 },
      },
      webhookUrl: "https://example.com/webhook",
    };
    const expectError = async (ctx: object, error: string) => {
      await expect(initiateCall(ctx as never, "+14155550123")).resolves.toEqual({
        callId: "",
        success: false,
        error,
      });
    };
    await expectError({ ...base, provider: undefined }, "Provider not initialized");
    await expectError(
      { ...base, provider: { name: "twilio" }, webhookUrl: undefined },
      "Webhook URL not configured",
    );
    await expectError(
      { ...base, activeCalls: new Map([["existing", {}]]), provider: { name: "twilio" } },
      "Maximum concurrent calls (1) reached",
    );
    await expectError(
      { ...base, provider: { name: "twilio" }, config: { ...base.config, fromNumber: "" } },
      "fromNumber not configured",
    );
  });

  it("holds Twilio notify calls silently until AMD classification", async () => {
    const initiate = vi.fn(async (_input: unknown) => ({
      providerCallId: "CA-notify",
      status: "initiated",
    }));
    const ctx = {
      ...createDialContext({ voicemail: { detection: "twilio", onMachine: "leave-message" } }),
      provider: { name: "twilio", initiateCall: initiate },
    };
    await initiateCall(ctx as never, "+14155550123", undefined, {
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

  it("initiates notify-mode calls with inline TwiML and records provider ids", async () => {
    const setup = dial({ tts: { provider: "openai", providers: { openai: { voice: "nova" } } } });
    const { initiateProviderCall } = setup;
    const ctx = { ...setup.ctx, coreSession: { mainKey: "work" } };

    const result = await initiateCall(ctx as never, "+14155550123", "main", {
      mode: "notify",
      message: "hello there",
    });
    expect(result.success).toBe(true);
    expect(result.callId).toBeTypeOf("string");
    expect(result.callId).not.toBe("");
    const callId = result.callId;

    expect(mapVoiceToPollyMock).toHaveBeenCalledWith("nova");
    expect(generateNotifyTwimlMock).toHaveBeenCalledWith("hello there", "Polly.Joanna");
    expect(initiateProviderCall).toHaveBeenCalledWith({
      callId,
      from: "+14155550100",
      to: "+14155550123",
      webhookUrl: "https://example.com/webhook",
      inlineTwiml: "<Response />",
    });
    expect(ctx.providerCallIdMap.get("provider-1")).toBe(callId);
    expect(ctx.activeCalls.get(callId)?.sessionKey).toBe("agent:main:work");
    expect(persistCallRecordMock).toHaveBeenCalledTimes(2);
  });

  it("persists the configured agent on outbound call records", async () => {
    const { ctx } = dial({ agentId: "operator", sessionScope: "per-call" });

    const result = await initiateCall(ctx as never, "+14155550123");

    expect(result.success).toBe(true);
    expect(result.callId).toBeTypeOf("string");
    expect(result.callId).not.toBe("");
    expect(ctx.activeCalls.get(result.callId)?.sessionKey).toBe(
      `agent:operator:voice:call:${result.callId}`,
    );
    expect(ctx.activeCalls.get(result.callId)?.agentId).toBe("operator");
  });

  it.each(["off", "twilio"] as const)(
    "caps a prepared brief and records voicemail ownership with detection=%s",
    async (detection) => {
      const { ctx, initiateProviderCall } = dial(
        {
          maxDurationSeconds: 300,
          voicemail: { detection, onMachine: "leave-message" },
        },
        "mock",
        "provider-brief",
      );
      const brief = { task: "Book a plumber", maxDurationSeconds: 600 };
      const result = await initiateCall(ctx as never, "+14155550123", undefined, { brief });
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

  it("uses the per-call agent for explicit session normalization", async () => {
    const { ctx } = dial({ agentId: "main" });

    const result = await initiateCall(
      ctx as never,
      "+14155550123",
      "agent:support:google-meet:meet-1",
      { agentId: "Support" },
    );

    expect(ctx.activeCalls.get(result.callId)).toMatchObject({
      agentId: "support",
      sessionKey: "agent:support:google-meet:meet-1",
    });
  });

  it("initiates conversation calls with pre-connect DTMF TwiML", async () => {
    const { ctx, initiateProviderCall } = dial({});

    const result = await initiateCall(ctx as never, "+14155550123", "session-1", {
      mode: "conversation",
      message: "hello meet",
      dtmfSequence: "ww123456#",
    });

    expect(result.success).toBe(true);
    expect(result.callId).toBeTypeOf("string");
    expect(result.callId).not.toBe("");
    const callId = result.callId;

    expect(generateDtmfRedirectTwimlMock).toHaveBeenCalledWith(
      "ww123456#",
      "https://example.com/webhook",
    );
    expect(initiateProviderCall).toHaveBeenCalledWith({
      callId,
      from: "+14155550100",
      to: "+14155550123",
      webhookUrl: "https://example.com/webhook",
      inlineTwiml: undefined,
      preConnectTwiml: "<DtmfRedirect />",
    });
    const metadata = ctx.activeCalls.get(callId)?.metadata;
    expect(metadata).toMatchObject({ initialMessage: "hello meet", mode: "conversation" });
  });

  it("rejects DTMF sequences outside conversation mode", async () => {
    const { ctx, initiateProviderCall } = dial({
      outbound: { defaultMode: "notify" },
    });

    await expect(
      initiateCall(ctx as never, "+14155550123", "session-1", {
        message: "hello",
        dtmfSequence: "123456#",
      }),
    ).resolves.toEqual({
      callId: "",
      success: false,
      error: "dtmfSequence requires conversation mode",
    });

    expect(initiateProviderCall).not.toHaveBeenCalled();
    expect(ctx.activeCalls.size).toBe(0);
  });

  it("fails initiateCall cleanly when provider initiation throws", async () => {
    const ctx = {
      ...createDialContext({
        fromNumber: undefined,
      }),
      provider: {
        name: "mock",
        initiateCall: vi.fn(async () => {
          throw new Error("provider down");
        }),
      },
    };

    const result = await initiateCall(ctx as never, "+14155550123");
    expect(result.success).toBe(false);
    expect(result.error).toBe("provider down");
    expect(result.callId).toBeTypeOf("string");
    expect(result.callId).not.toBe("");
    expect(ctx.activeCalls.size).toBe(0);
  });

  it("speaks through connected calls and rolls back to listening on provider errors", async () => {
    const call = createCall();
    const playTts = vi.fn(async () => {});
    const ctx = {
      ...createContext(call),
      provider: { name: "twilio", playTts },
      config: { tts: { provider: "openai", providers: { openai: { voice: "alloy" } } } },
    };

    await expect(
      speak(ctx as never, "call-1", "hello", { listenAfterPlayback: true }),
    ).resolves.toEqual({ success: true });
    expect(call.state).toBe("speaking");
    expect(playTts).toHaveBeenCalledWith({
      callId: "call-1",
      providerCallId: "provider-1",
      text: "hello",
      voice: "alloy",
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
    const call = createCall();
    const playTts = vi.fn(async () => {
      throw new Error("Telephony TTS queue is full for stream; maxPending=8");
    });
    const startListening = vi.fn(async () => {});
    const activeTurnCalls = new Set<string>();
    const ctx = {
      ...createContext(call),
      providerCallIdMap: new Map([["provider-1", "call-1"]]),
      provider: {
        name: "twilio",
        playTts,
        startListening,
        stopListening: vi.fn(async () => {}),
      },
      config: { tts: { provider: "openai" } },
      activeTurnCalls,
      transcriptWaiters: new Map(),
      maxDurationTimers: new Map(),
      initialMessageInFlight: new Set(),
    };

    await expect(continueCall(ctx as never, "call-1", "hello")).resolves.toEqual({
      success: false,
      error: "Telephony TTS queue is full for stream; maxPending=8",
    });

    expect(playTts).toHaveBeenCalledOnce();
    expect(startListening).not.toHaveBeenCalled();
    expect(activeTurnCalls.size).toBe(0);
    expect(call.state).toBe("listening");
  });

  it("passes configured voice ids through to Telnyx speak", async () => {
    const call = createCall();
    const playTts = vi.fn(async () => {});
    const ctx = {
      ...createContext(call),
      provider: { name: "telnyx", playTts },
      config: {
        tts: {
          provider: "telnyx",
          providers: {
            telnyx: {
              voiceId: "Telnyx.Qwen3TTS.12345678-1234-1234-1234-123456789abc",
            },
          },
        },
      },
    };

    await expect(speak(ctx as never, "call-1", "hello")).resolves.toEqual({ success: true });

    expect(playTts).toHaveBeenCalledWith({
      callId: "call-1",
      providerCallId: "provider-1",
      text: "hello",
      voice: "Telnyx.Qwen3TTS.12345678-1234-1234-1234-123456789abc",
    });
  });

  it("caps notify-mode auto-hangup delay before scheduling", async () => {
    const call = createCall({ metadata: { initialMessage: "hello", mode: "notify" } });
    const playTts = vi.fn(async () => {});
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    getCallByProviderCallIdMock.mockReturnValue(call);
    const ctx = {
      ...createContext(call),
      providerCallIdMap: new Map([["provider-1", "call-1"]]),
      provider: { name: "twilio", playTts },
      initialMessageInFlight: new Set(),
      config: {
        outbound: { notifyHangupDelaySec: Number.MAX_SAFE_INTEGER },
        tts: { provider: "openai", providers: { openai: { voice: "alloy" } } },
      },
    };

    try {
      await speakInitialMessage(ctx as never, "provider-1");
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it.each([
    ["inbound", "alloy"],
    ["outbound", "coral"],
  ] as const)(
    "uses the correct TTS voice for a routed number on %s calls",
    async (direction, voice) => {
      const call = createCall({
        direction,
        to: "+15550002222",
        ...(direction === "inbound" ? { metadata: { numberRouteKey: "+15550002222" } } : {}),
      });
      const playTts = vi.fn(async () => {});
      const ctx = {
        ...createContext(call),
        provider: { name: "twilio", playTts },
        config: {
          tts: { provider: "openai", providers: { openai: { voice: "coral" } } },
          numbers: { "+15550002222": { tts: { providers: { openai: { voice: "alloy" } } } } },
        },
      };
      await expect(speak(ctx as never, "call-1", "hello")).resolves.toEqual({ success: true });
      expect(playTts).toHaveBeenCalledWith({
        callId: "call-1",
        providerCallId: "provider-1",
        text: "hello",
        voice,
      });
    },
  );

  it("sends DTMF through connected provider calls", async () => {
    const call = createCall();
    const sendDtmfProvider = vi.fn(async () => {});
    const ctx = {
      ...createContext(call),
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
    const call = createCall();
    const ctx = {
      ...createContext(call),
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
      expect(ctx.activeCalls.size).toBe(0);
      expect(ctx.providerCallIdMap.size).toBe(0);
    },
  );

  it("handles missing, disconnected, and already-ended calls", async () => {
    await expect(
      speak(
        {
          ...createContext(),
          provider: { name: "twilio", playTts: vi.fn() },
          config: {},
        } as never,
        "missing",
        "hello",
      ),
    ).resolves.toEqual({ success: false, error: "Call not found" });

    const { call, ctx } = createActiveCallContext();
    call.state = "completed";
    await expect(endCall(ctx as never, "call-1")).resolves.toEqual({ success: true });
  });

  it("issues a stream session and threads streamUrl + streamAuthToken through for Telnyx realtime", async () => {
    const initiateProviderCall = vi.fn(async () => ({ providerCallId: "call-control-1" }));
    const streamSessionIssuer = vi.fn(() => ({
      token: "token-xyz",
      streamUrl: "wss://example.test/voice/stream/realtime/token-xyz",
    }));
    const ctx = {
      ...createDialContext({
        realtime: { enabled: true },
      }),
      provider: { name: "telnyx", initiateCall: initiateProviderCall },
      streamSessionIssuer,
    };

    const result = await initiateCall(ctx as never, "+14155550123");

    expect(result.success).toBe(true);
    expect(streamSessionIssuer).toHaveBeenCalledTimes(1);
    expect(streamSessionIssuer).toHaveBeenCalledWith(
      expect.objectContaining({
        providerName: "telnyx",
        direction: "outbound",
        to: "+14155550123",
      }),
    );
    expect(initiateProviderCall).toHaveBeenCalledWith(
      expect.objectContaining({
        streamUrl: "wss://example.test/voice/stream/realtime/token-xyz",
        streamAuthToken: "token-xyz",
      }),
    );
  });

  it("skips the stream session for Twilio realtime (Twilio learns the URL from TwiML)", async () => {
    const initiateProviderCall = vi.fn(
      async (_input: { streamUrl?: string; streamAuthToken?: string }) => ({
        providerCallId: "provider-1",
      }),
    );
    const streamSessionIssuer = vi.fn(() => ({
      token: "should-not-be-used",
      streamUrl: "wss://example.test/should-not-be-used",
    }));
    const ctx = {
      ...createDialContext({
        realtime: { enabled: true },
      }),
      provider: { name: "twilio", initiateCall: initiateProviderCall },
      streamSessionIssuer,
    };

    const result = await initiateCall(ctx as never, "+14155550123");

    expect(result.success).toBe(true);
    expect(streamSessionIssuer).not.toHaveBeenCalled();
    const [providerCall] = initiateProviderCall.mock.calls[0] ?? [];
    expect(providerCall?.streamUrl).toBeUndefined();
    expect(providerCall?.streamAuthToken).toBeUndefined();
  });

  it("does not issue a stream session when realtime is disabled", async () => {
    const initiateProviderCall = vi.fn(async () => ({ providerCallId: "call-control-1" }));
    const streamSessionIssuer = vi.fn();
    const ctx = {
      ...createDialContext({
        realtime: { enabled: false },
      }),
      provider: { name: "telnyx", initiateCall: initiateProviderCall },
      streamSessionIssuer,
    };

    await initiateCall(ctx as never, "+14155550123");

    expect(streamSessionIssuer).not.toHaveBeenCalled();
  });
});
