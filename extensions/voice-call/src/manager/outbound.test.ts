import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CallRecordSchema,
  type CallRecord,
  type InitiateCallInput,
  type OutboundCallOptions,
} from "../types.js";

const timers = vi.hoisted(() => ({
  clearMaxDurationTimer: vi.fn(),
  clearTranscriptWaiter: vi.fn(),
  startMaxDurationTimer: vi.fn(),
  rejectTranscriptWaiter: vi.fn(),
  waitForFinalTranscript: vi.fn(),
}));
const { persist } = vi.hoisted(() => ({ persist: vi.fn() }));
// mock-isolation: Observe outbound persistence without opening the call database.
vi.mock("./store.js", () => ({ persistCallRecord: persist }));
// mock-isolation: Observe call timer lifecycle without starting real deadlines or transcript waits.
vi.mock("./timers.js", () => timers);

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
    providerCallIdMap: new Map<string, string>(
      call?.providerCallId ? [[call.providerCallId, call.callId]] : [],
    ),
    transcriptWaiters: new Map(),
    maxDurationTimers: new Map(),
    endCallOperations: new Map(),
    initialMessageInFlight: new Set<string>(),
    activeTurnCalls: new Set<string>(),
    storePath: "/tmp/voice-call.json",
  };
}

function connected<P extends object>(
  provider: P,
  config: object = {},
  overrides: Partial<CallRecord> = {},
) {
  const call = createCall(overrides);
  return { call, ctx: { ...createContext(call), provider, config } };
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

const expectFailure = async (
  result: Promise<{ success: boolean; error?: string }>,
  error: string,
) => expect(result).resolves.toEqual({ success: false, error });

const openaiVoice = (voice: string) => ({
  tts: { provider: "openai", providers: { openai: { voice } } },
});

function speechContext(
  config: object = openaiVoice("alloy"),
  overrides: Partial<CallRecord> = {},
  name = "twilio",
) {
  const playTts = vi.fn(async () => {});
  return { ...connected({ name, playTts }, config, overrides), playTts };
}

beforeEach(() => {
  vi.clearAllMocks();
  persist.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

it("guards initiateCall when provider, webhook, capacity, or fromNumber are missing", async () => {
  const { ctx } = dial({ maxConcurrentCalls: 1, fromNumber: "" });
  for (const [override, error] of [
    [{ provider: undefined }, "Provider not initialized"],
    [{ webhookUrl: undefined }, "Webhook URL not configured"],
    [{ activeCalls: new Map([["existing", {}]]) }, "Maximum concurrent calls (1) reached"],
    [{}, "fromNumber not configured"],
  ] as const) {
    const result = await initiateCall({ ...ctx, ...override } as never, "+14155550123");
    expect(result).toEqual({ callId: "", success: false, error });
  }
});

it("holds Twilio notify calls silently until AMD classification", async () => {
  const { ctx, place, initiateProviderCall } = dial(
    { voicemail: { detection: "twilio", onMachine: "leave-message" } },
    "twilio",
    "CA-notify",
  );
  await place({ mode: "notify", message: "Your parcel is ready." });
  expect(initiateProviderCall.mock.calls[0]?.[0]).toMatchObject({
    inlineTwiml: '<Response><Pause length="60"/></Response>',
  });
  const call = [...ctx.activeCalls.values()][0];
  expect(call?.metadata?.pendingNotifyAmd).toBe(true);
  const playTts = vi.fn(async () => {});
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
    const input = initiateProviderCall.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      callId,
      from: "+14155550100",
      to: "+14155550123",
      webhookUrl: "https://example.com/webhook",
    });
    if (mode === "notify") {
      expect(input?.inlineTwiml).toContain('<Say voice="Polly.Salli">hello there</Say>');
      expect(input?.inlineTwiml).toContain("<Hangup/>");
    } else {
      expect(input?.inlineTwiml).toBeUndefined();
      expect(input?.preConnectTwiml).toContain('<Play digits="ww123456#" />');
      expect(input?.preConnectTwiml).toContain(
        '<Redirect method="POST">https://example.com/webhook</Redirect>',
      );
    }
    expect(ctx.providerCallIdMap.get("provider-1")).toBe(callId);
    expect(ctx.activeCalls.get(callId)).toMatchObject({
      sessionKey: "agent:main:work",
      metadata: { initialMessage: message, mode },
    });
  },
);

it.each([false, true])(
  "persists configured or per-call agent identity (override=%s)",
  async (override) => {
    const { ctx, place } = dial({ agentId: "operator", sessionScope: "per-call" });
    const sessionKey = "agent:support:google-meet:meet-1";
    const callId = expectPlaced(
      await place(override ? { agentId: "Support" } : undefined, override ? sessionKey : undefined),
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
    const { ctx, place } = dial(
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
  },
);

it("rejects DTMF sequences outside conversation mode", async () => {
  const { ctx, place, initiateProviderCall } = dial({ outbound: { defaultMode: "notify" } });
  expect(await place({ message: "hello", dtmfSequence: "123456#" }, "session-1")).toEqual({
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

it("reports telephony queue overflow without starting a silent listening turn", async () => {
  const error = "Telephony TTS queue is full for stream; maxPending=8";
  const startListening = vi.fn(async () => {});
  const { call, ctx } = connected(
    {
      name: "twilio",
      startListening,
      stopListening: vi.fn(async () => {}),
      playTts: vi.fn<() => Promise<void>>().mockRejectedValue(new Error(error)),
    },
    { tts: { provider: "openai" } },
  );

  await expectFailure(continueCall(ctx as never, "call-1", "hello"), error);

  expect(startListening).not.toHaveBeenCalled();
  expect(ctx.activeTurnCalls.size).toBe(0);
  expect(call.state).toBe("listening");
});

it.each([
  ["twilio", "inbound", "alloy"],
  ["twilio", "outbound", "coral"],
  ["telnyx", "outbound", "Telnyx.Qwen3TTS.12345678-1234-1234-1234-123456789abc"],
] as const)("uses the configured %s voice for %s calls", async (provider, direction, voice) => {
  const { call, ctx, playTts } = speechContext(
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
  expect(await speak(ctx as never, "call-1", "hello", { listenAfterPlayback: true })).toEqual({
    success: true,
  });
  expect(playTts).toHaveBeenCalledWith({
    callId: "call-1",
    providerCallId: "provider-1",
    text: "hello",
    voice,
    listenAfterPlayback: true,
  });
  expect(call).toMatchObject({
    state: "speaking",
    transcript: [expect.objectContaining({ speaker: "bot", text: "hello" })],
  });
});

it("sends DTMF through connected provider calls", async () => {
  const sendDtmfProvider = vi.fn(async () => {});
  const { ctx } = connected({ name: "twilio", sendDtmf: sendDtmfProvider });

  expect(await sendDtmf(ctx as never, "call-1", "ww123#")).toEqual({ success: true });
  expect(sendDtmfProvider).toHaveBeenCalledWith({
    callId: "call-1",
    providerCallId: "provider-1",
    digits: "ww123#",
  });
});

it("rejects invalid or unsupported outbound DTMF", async () => {
  const { ctx } = connected({ name: "telnyx" });

  await expectFailure(
    sendDtmf(ctx as never, "call-1", "abc"),
    "digits may only contain digits, *, #, comma, w, p",
  );
  await expectFailure(
    sendDtmf(ctx as never, "call-1", "123#"),
    "telnyx does not support outbound DTMF",
  );
});

it.each([undefined, "timeout"] as const)(
  "ends connected calls with reason %s, clears timers, and rejects pending transcripts",
  async (reason) => {
    const hangupCall = vi.fn(async () => {});
    const { call, ctx } = connected({ hangupCall });
    const expectedReason = reason ?? "hangup-bot";
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000 });
    expect(await endCall(ctx as never, "call-1", reason ? { reason } : undefined)).toEqual({
      success: true,
    });
    expect(hangupCall).toHaveBeenCalledWith({
      callId: "call-1",
      providerCallId: "provider-1",
      reason: expectedReason,
    });
    expect(call).toMatchObject({
      endReason: expectedReason,
      state: expectedReason,
      endedAt: 1_000,
    });
    expect(timers.clearMaxDurationTimer).toHaveBeenCalledWith(ctx, "call-1");
    expect(timers.rejectTranscriptWaiter).toHaveBeenCalledWith(
      ctx,
      "call-1",
      `Call ended: ${expectedReason}`,
    );
    expect([ctx.activeCalls.size, ctx.providerCallIdMap.size]).toEqual([0, 0]);
  },
);

it("handles missing and already-ended calls", async () => {
  const { ctx: missing } = speechContext();
  await expectFailure(speak(missing as never, "missing", "hello"), "Call not found");

  const { ctx } = connected({}, {}, { state: "completed" });
  expect(await endCall(ctx as never, "call-1")).toEqual({ success: true });
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
