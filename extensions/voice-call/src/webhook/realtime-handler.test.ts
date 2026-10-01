import { once } from "node:events";
import http from "node:http";
import { Duplex } from "node:stream";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceSessionHarness,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import { VoiceCallConfigSchema, type VoiceCallRealtimeConfig } from "../config.js";
import { CallManager } from "../manager.js";
import type { CallRecord, NormalizedEvent } from "../types.js";
import {
  connectWs as openWebSocket,
  startUpgradeWsServer as openUpgradeServer,
  waitForClose,
} from "../websocket-test-support.js";
import { RealtimeAudioPacer } from "./realtime-audio-pacer.js";
import { RealtimeCallHandler, type ToolHandlerContext } from "./realtime-handler.js";
import {
  createRealtimeConfig,
  createBridge as createTestBridge,
  makeRealtimeProvider,
  updateCallMetadata,
  sendCarrierStart,
} from "./realtime-handler.lifecycle.test-helpers.js";
import { StreamDisconnectGrace } from "./stream-disconnect-grace.js";

const realtimeVoiceHarnessTestHooks = vi.hoisted(() => ({
  onCreate: undefined as ((harness: RealtimeVoiceSessionHarness) => void) | undefined,
}));

vi.mock("openclaw/plugin-sdk/realtime-voice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/realtime-voice")>();
  return {
    ...actual,
    createRealtimeVoiceSessionHarness: (
      params: Parameters<typeof actual.createRealtimeVoiceSessionHarness>[0],
    ) => {
      const harness = actual.createRealtimeVoiceSessionHarness(params);
      realtimeVoiceHarnessTestHooks.onCreate?.(harness);
      return harness;
    },
  };
});

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  realtimeVoiceHarnessTestHooks.onCreate = undefined;
  vi.useRealTimers();
  for (const close of cleanup.splice(0).toReversed()) {
    await close();
  }
});

async function connectWs(url: string) {
  const ws = await openWebSocket(url);
  cleanup.push(async () => {
    if (ws.readyState !== WebSocket.CLOSED) {
      const closed = waitForClose(ws);
      ws.close();
      await closed;
    }
  });
  return ws;
}

async function startUpgradeWsServer(params: Parameters<typeof openUpgradeServer>[0]) {
  const server = await openUpgradeServer(params);
  cleanup.push(server.close);
  return server;
}

function makeRequest(url: string, host = "gateway.ts.net"): http.IncomingMessage {
  const req = new http.IncomingMessage(null as never);
  req.url = url;
  req.method = "POST";
  req.headers = host ? { host } : {};
  return req;
}

function makeBridge(overrides: Partial<RealtimeVoiceBridge> = {}): RealtimeVoiceBridge {
  return createTestBridge(() => {}, { submitToolResult: vi.fn(), ...overrides });
}

const PROVIDER_WITH_LOCAL_BARGE_IN_CAPABILITIES = {
  transports: ["gateway-relay"],
  inputAudioFormats: [{ encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 }],
  outputAudioFormats: [{ encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 }],
  supportsBargeIn: true,
} satisfies NonNullable<RealtimeVoiceProviderPlugin["capabilities"]>;

const PROVIDER_BARGE_IN_CAPABILITIES = {
  ...PROVIDER_WITH_LOCAL_BARGE_IN_CAPABILITIES,
  handlesInputAudioBargeIn: true,
};

function makeHandler(
  overrides?: Partial<VoiceCallRealtimeConfig>,
  deps?: {
    manager?: Partial<CallManager>;
    providerConfig?: Record<string, unknown>;
    realtimeProvider?: RealtimeVoiceProviderPlugin;
    resolveInstructions?: (call: CallRecord) => string;
    streamDisconnectLifecycle?: {
      connect: (providerCallId: string, streamId: string) => void;
      disconnect: (providerCallId: string, streamId: string) => void;
      retire: (providerCallId: string, streamId: string) => void;
    };
  },
) {
  const config: VoiceCallRealtimeConfig = { ...createRealtimeConfig(), ...overrides };
  const realtimeProvider = deps?.realtimeProvider ?? makeRealtimeProvider(() => makeBridge());
  const providerConfig = deps?.providerConfig ?? { apiKey: "test-key" };
  const handler = new RealtimeCallHandler(
    config,
    {
      processEvent: vi.fn<CallManager["processEvent"]>(async () => ({ kind: "processed" })),
      updateCallMetadata,
      endCall: vi.fn(async () => ({ success: true })),
      getCallForStream: vi.fn<CallManager["getCallForStream"]>(async () => undefined),
      getCallByProviderCallId: vi.fn(),
      ...deps?.manager,
    } as unknown as CallManager,
    (call) => ({
      agentId: call.agentId ?? "main",
      provider: realtimeProvider,
      providerConfig,
      instructions: deps?.resolveInstructions?.(call) ?? config.instructions,
    }),
    "/voice/webhook",
    deps?.streamDisconnectLifecycle ?? {
      connect: () => {},
      disconnect: () => {},
      retire: () => {},
    },
    undefined,
  );
  onTestFinished(() => handler.close());
  return handler;
}

async function startRealtimeServer(handler: RealtimeCallHandler, params?: URLSearchParams) {
  const payload = handler.buildTwiMLPayload(makeRequest("/voice/webhook"), params);
  const streamUrl = expectDefined(payload.body.match(/wss:\/\/[^" ]+/)?.[0], "realtime stream URL");
  return startStreamSessionServer(handler, streamUrl);
}

async function startStreamSessionServer(handler: RealtimeCallHandler, streamUrl: string) {
  return startUpgradeWsServer({
    urlPath: new URL(streamUrl).pathname,
    onUpgrade: (request, socket, head) => handler.handleWebSocketUpgrade(request, socket, head),
  });
}

async function waitForRealtimeTest(
  callback: () => void | Promise<void>,
  options: { timeout?: number; interval?: number } = {},
) {
  await vi.waitFor(callback, { interval: 1, ...options });
}

type RealtimeBridgeRequest = Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0];
type RecentTalkEvent = { turnId?: string; type: string };

function makeCallRecord(providerCallId: string, overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call-1",
    providerCallId,
    provider: "twilio",
    direction: "inbound",
    state: "ringing",
    from: "+15550001234",
    to: "+15550009999",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    metadata: {},
    ...overrides,
  };
}

function makeCallHarness(
  bridge:
    | Partial<RealtimeVoiceBridge>
    | ((request: RealtimeBridgeRequest, index: number) => RealtimeVoiceBridge) = {},
  options: {
    call?: CallRecord;
    config?: Partial<VoiceCallRealtimeConfig>;
    deps?: Parameters<typeof makeHandler>[1];
  } = {},
) {
  const call = options.call ?? makeCallRecord("CA-test");
  const calls = new Map([[call.providerCallId, call]]);
  const getCallByProviderCallId = (id: string) => {
    if (options.call) {
      return options.call;
    }
    const record = calls.get(id) ?? makeCallRecord(id);
    calls.set(id, record);
    return record;
  };
  const callbacks: RealtimeBridgeRequest[] = [];
  const processEvent = vi.fn<CallManager["processEvent"]>(async () => ({ kind: "processed" }));
  const endCall = vi.fn(async () => ({ success: true }));
  const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
    callbacks.push(request);
    return typeof bridge === "function"
      ? bridge(request, callbacks.length - 1)
      : makeBridge(bridge);
  });
  const handler = makeHandler(options.config, {
    ...options.deps,
    manager: {
      processEvent,
      endCall,
      getCallByProviderCallId,
      ...options.deps?.manager,
    },
    realtimeProvider: {
      ...makeRealtimeProvider(createBridge),
      ...options.deps?.realtimeProvider,
      createBridge,
    },
  });
  async function start(streamId = "MZ-test", providerCallId = call.providerCallId) {
    const count = callbacks.length;
    const ws = await connectWs((await startRealtimeServer(handler)).url);
    sendCarrierStart(ws, streamId, providerCallId);
    await waitForRealtimeTest(() => expect(callbacks).toHaveLength(count + 1));
    return { ws, callbacks: expectDefined(callbacks[count], "provider callbacks") };
  }
  return { call, handler, callbacks, createBridge, processEvent, endCall, start };
}

function callTool(
  callbacks: RealtimeBridgeRequest | undefined,
  callId: string,
  name: string,
  args: unknown = {},
) {
  expectDefined(callbacks, "provider callbacks").onToolCall?.({
    itemId: callId,
    callId,
    name,
    args,
  });
}

function requestConsult(
  callbacks: RealtimeBridgeRequest | undefined,
  callId: string,
  question: string,
) {
  callTool(callbacks, callId, "openclaw_agent_consult", { question });
}

function resetContinuity(callbacks: RealtimeBridgeRequest | undefined) {
  expectDefined(callbacks, "provider callbacks").onEvent?.({
    direction: "client",
    type: "session.continuity.reset",
  });
}

function sendMedia(ws: WebSocket, audio: Buffer) {
  ws.send(JSON.stringify({ event: "media", media: { payload: audio.toString("base64") } }));
}

function parseWebSocketMessage(data: RawData): Record<string, unknown> {
  const bytes = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
  return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
}

async function bargeInHarness(params: {
  bridgeHandlesInputAudioBargeIn?: boolean;
  handlesProviderBargeIn?: boolean;
  interruptResponseOnInputAudio?: boolean;
  providerCallId: string;
}) {
  const sendAudio = vi.fn();
  const handleBargeIn = vi.fn();
  const fixture = makeCallHarness(
    {
      handleBargeIn,
      sendAudio,
      ...(params.bridgeHandlesInputAudioBargeIn === undefined
        ? {}
        : {
            handlesInputAudioBargeIn: params.bridgeHandlesInputAudioBargeIn,
          }),
    },
    {
      call: makeCallRecord(params.providerCallId),
      deps: {
        providerConfig: {
          apiKey: "test-key",
          interruptResponseOnInputAudio: params.interruptResponseOnInputAudio,
        },
        realtimeProvider: makeRealtimeProvider(() => makeBridge(), {
          capabilities: params.handlesProviderBargeIn
            ? PROVIDER_BARGE_IN_CAPABILITIES
            : PROVIDER_WITH_LOCAL_BARGE_IN_CAPABILITIES,
          id: params.handlesProviderBargeIn ? "openai" : "test",
        }),
      },
    },
  );
  const { ws, callbacks } = await fixture.start();
  const outboundMessages: Array<Record<string, unknown>> = [];
  ws.on("message", (data) => outboundMessages.push(parseWebSocketMessage(data)));
  return { ...fixture, ws, callbacks, sendAudio, handleBargeIn, outboundMessages };
}

function recentTalkEvents(call: CallRecord): RecentTalkEvent[] {
  return (call.metadata?.recentTalkEvents as RecentTalkEvent[] | undefined) ?? [];
}

function talkEvents(call: CallRecord, type: string) {
  return recentTalkEvents(call).filter((event) => event.type === type);
}

function callEvents(
  processEvent: ReturnType<typeof vi.fn<CallManager["processEvent"]>>,
  type: NormalizedEvent["type"],
) {
  return processEvent.mock.calls.map(([event]) => event).filter((event) => event.type === type);
}

function transcripts(
  processEvent: ReturnType<typeof vi.fn<CallManager["processEvent"]>>,
  type: "call.speech" | "call.assistant-speech" = "call.speech",
) {
  return callEvents(processEvent, type).flatMap((event) =>
    event.type === "call.speech" || event.type === "call.assistant-speech"
      ? [event.transcript]
      : [],
  );
}

async function expectFrame(messages: Array<Record<string, unknown>>, type: string) {
  await waitForRealtimeTest(() =>
    expect(messages.some((message) => message.event === type)).toBe(true),
  );
}

function requireCancelledTurn(call: CallRecord): RecentTalkEvent & { turnId: string } {
  const cancelled = recentTalkEvents(call).find((event) => event.type === "turn.cancelled");
  if (!cancelled?.turnId) {
    throw new Error("expected barge-in to cancel the active turn");
  }
  return cancelled as RecentTalkEvent & { turnId: string };
}

describe("RealtimeCallHandler path routing", () => {
  it("finishes a failed telephony turn without closing the call", async () => {
    const { callbacks, call, ws } = await bargeInHarness({ providerCallId: "CA-response-failed" });
    callbacks.onTranscript?.("user", "first turn", true);
    callbacks.onAudio(Buffer.from([1]));
    callbacks.onResponseDone?.({
      status: "failed",
      responseId: "response-1",
      message: "provider failed",
    });
    expect(talkEvents(call, "turn.ended")).toHaveLength(1);
    expect(talkEvents(call, "output.audio.done")).toHaveLength(1);
    expect(talkEvents(call, "session.error")).toHaveLength(1);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("persists a final transcript before consulting without blocking carrier audio", async () => {
    const { callbacks, processEvent, handler, sendAudio, ws } = await bargeInHarness({
      providerCallId: "CA-pending-transcript",
    });
    const consult = vi.fn(async () => ({ text: "Deployment is healthy." }));
    handler.registerToolHandler("openclaw_agent_consult", consult);
    const persistence = createDeferred<Awaited<ReturnType<CallManager["processEvent"]>>>();
    processEvent.mockReturnValueOnce(persistence.promise);
    callbacks.onTranscript?.("user", "Check the deployment.", true);
    callbacks.onToolCall?.({
      itemId: "item-pending-store",
      callId: "consult-pending-store",
      name: "openclaw_agent_consult",
      args: { question: "Check the deployment." },
    });
    const audio = Buffer.from([0xff, 0xfe]);
    ws.send(JSON.stringify({ event: "media", media: { payload: audio.toString("base64") } }));
    try {
      await waitForRealtimeTest(() => expect(sendAudio).toHaveBeenCalledWith(audio));
      expect(consult).not.toHaveBeenCalled();
      expect(processEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "call.speech",
          transcript: "Check the deployment.",
        }),
      );
      persistence.resolve({ kind: "processed" });
      await waitForRealtimeTest(() => expect(consult).toHaveBeenCalledOnce());
    } finally {
      persistence.resolve({ kind: "processed" });
    }
  });

  it("preserves a public path prefix ahead of serve.path", () => {
    const handler = makeHandler({ streamPath: "/custom/stream/realtime" });
    handler.setPublicUrl("https://public.example:8443/api/voice/webhook");
    const payload = handler.buildTwiMLPayload(makeRequest("/voice/webhook", "127.0.0.1:3334"));

    expect(handler.getStreamPathPattern()).toBe("/api/custom/stream/realtime");
    expect(payload.body).toMatch(
      /wss:\/\/public\.example:8443\/api\/custom\/stream\/realtime\/[0-9a-f-]{36}/,
    );
  });

  it("normalizes Twilio outbound realtime directions", async () => {
    const triggerGreeting = vi.fn();
    const { callbacks, handler, processEvent, createBridge } = makeCallHarness(
      { triggerGreeting },
      {
        call: makeCallRecord("CA-outbound", { direction: "outbound" }),
      },
    );
    const server = await startRealtimeServer(
      handler,
      new URLSearchParams({
        Direction: "outbound-dial",
        From: "+15550001234",
        To: "+15550009999",
      }),
    );
    const ws = await connectWs(server.url);
    sendCarrierStart(ws, "MZ-outbound", "CA-outbound");
    await waitForRealtimeTest(() => expect(createBridge).toHaveBeenCalled());
    expect(createBridge.mock.calls[0]?.[0].audioFormat).toEqual({
      encoding: "g711_ulaw",
      sampleRateHz: 8000,
      channels: 1,
    });
    callbacks[0]?.onReady?.();
    expect(triggerGreeting).not.toHaveBeenCalled();
    expect(processEvent.mock.calls[0]?.[0]).toMatchObject({
      type: "call.initiated",
      direction: "outbound",
      from: "+15550001234",
      to: "+15550009999",
    });
  });

  it("joins Telnyx realtime streams to the token-bound call", async () => {
    const call = makeCallRecord("v3:call-1", {
      agentId: "support",
      provider: "telnyx",
      state: "answered",
      metadata: { initialMessage: "hello" },
    });
    const resolveInstructions = vi.fn((record: CallRecord) => `instructions:${record.agentId}`);
    const triggerGreeting = vi.fn();
    const { handler, callbacks, processEvent, createBridge } = makeCallHarness(
      { triggerGreeting },
      {
        call,
        deps: { manager: { getCallForStream: async () => call }, resolveInstructions },
      },
    );
    handler.setPublicUrl("https://public.example/voice/webhook");
    const session = handler.issueStreamSession({
      providerName: "telnyx",
      callId: "call-1",
      from: "+15550001234",
      to: "+15550009999",
      direction: "inbound",
    });
    const server = await startStreamSessionServer(handler, session.streamUrl);

    const ws = await connectWs(server.url);
    ws.send(
      JSON.stringify({
        event: "start",
        stream_id: "stream-1",
        start: { call_control_id: "v3:call-1" },
      }),
    );
    await waitForRealtimeTest(() => expect(createBridge).toHaveBeenCalled());

    const eventTypes = processEvent.mock.calls.map(([event]) => event.type);
    expect(eventTypes).toEqual(["call.answered"]);
    expect(processEvent.mock.calls[0]?.[0].callId).toBe("call-1");
    expect(createBridge.mock.calls[0]?.[0].instructions).toBe("instructions:support");
    expect(createBridge.mock.calls[0]?.[0].agentId).toBe("support");
    callbacks[0]?.onReady?.();
    expect(triggerGreeting).toHaveBeenCalledTimes(1);
    expect(triggerGreeting.mock.calls[0]?.[0]).toContain("hello");
  });

  it("rejects stream sessions when token expiry would exceed the Date range", async () => {
    const { handler, processEvent, createBridge } = makeCallHarness();
    handler.setPublicUrl("https://public.example/voice/webhook");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    const session = handler.issueStreamSession({
      providerName: "telnyx",
      callId: "call-overflow",
      direction: "inbound",
    });
    nowSpy.mockRestore();
    const server = await startStreamSessionServer(handler, session.streamUrl);

    await expect(connectWs(server.url)).rejects.toThrow("Unexpected server response: 401");
    expect(createBridge).not.toHaveBeenCalled();
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("rejects Telnyx stream starts that do not match the token-bound call", async () => {
    const call = makeCallRecord("v3:call-1", { provider: "telnyx", state: "answered" });
    const { handler, processEvent, createBridge } = makeCallHarness(
      {},
      {
        call,
        deps: { manager: { getCallForStream: async () => call } },
      },
    );
    handler.setPublicUrl("https://public.example/voice/webhook");
    const session = handler.issueStreamSession({
      providerName: "telnyx",
      callId: "call-1",
      direction: "inbound",
    });
    const server = await startStreamSessionServer(handler, session.streamUrl);

    const ws = await connectWs(server.url);
    ws.send(
      JSON.stringify({
        event: "start",
        stream_id: "stream-1",
        start: { call_control_id: "v3:other" },
      }),
    );
    const close = await waitForClose(ws);

    expect(close.code).toBe(1008);
    expect(createBridge).not.toHaveBeenCalled();
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("cleans up realtime streams immediately and finalizes after disconnect grace", async () => {
    let callbacks: RealtimeBridgeRequest | undefined;
    const processEvent = vi.fn<CallManager["processEvent"]>(async () => ({ kind: "processed" }));
    const endCall = vi.fn(async () => ({ success: true }));
    const close = vi.fn(() => {
      callbacks?.onTranscript?.("user", "last words", true);
      callbacks?.onClose?.("completed");
      throw new Error("provider close failed");
    });
    let finalization: ReturnType<CallManager["processEvent"]> | undefined;
    onTestFinished(async () => {
      await finalization;
    });
    const streamDisconnectLifecycle = new StreamDisconnectGrace(({ providerCallId }) => {
      finalization = processEvent({
        id: "disconnect-grace-expired",
        type: "call.ended",
        callId: "call-1",
        providerCallId,
        timestamp: Date.now(),
        reason: "completed",
      });
      void finalization.catch(() => {});
    });
    const disconnected = createDeferred<void>();
    const originalDisconnect = streamDisconnectLifecycle.disconnect.bind(streamDisconnectLifecycle);
    const disconnect = vi
      .spyOn(streamDisconnectLifecycle, "disconnect")
      .mockImplementation((providerCallId, streamId) => {
        originalDisconnect(providerCallId, streamId);
        disconnected.resolve();
      });
    const { start } = makeCallHarness(
      (request) => {
        callbacks = request;
        return makeBridge({ close });
      },
      {
        call: makeCallRecord("CA-complete"),
        deps: { manager: { processEvent, endCall }, streamDisconnectLifecycle },
      },
    );
    const { ws } = await start("MZ-complete");

    vi.useFakeTimers();
    ws.send(JSON.stringify({ event: "stop" }));

    await disconnected.promise;
    expect(close).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledExactlyOnceWith("CA-complete", "MZ-complete");
    expect(endCall).not.toHaveBeenCalled();
    expect(transcripts(processEvent)).toEqual(["last words"]);
    expect(callEvents(processEvent, "call.ended")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(processEvent.mock.calls.some(([event]) => event.type === "call.ended")).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const endedEvents = callEvents(processEvent, "call.ended");
    expect(endedEvents).toEqual([
      expect.objectContaining({
        callId: "call-1",
        providerCallId: "CA-complete",
        reason: "completed",
      }),
    ]);

    vi.useRealTimers();
    const wsClosed = waitForClose(ws);
    ws.close();
    await wsClosed;
    expect(close).toHaveBeenCalledTimes(1);
    expect(callEvents(processEvent, "call.ended")).toHaveLength(1);
    expect(endCall).not.toHaveBeenCalled();
  });

  it("starts fresh transcript and Talk state after provider continuity resets", async () => {
    const { callbacks, call, outboundMessages, processEvent } = await bargeInHarness({
      providerCallId: "CA-continuity-reset",
    });
    callbacks.onTranscript?.("user", "Old caller ", false);
    callbacks.onTranscript?.("assistant", "Old assistant ", false);
    callbacks.onAudio?.(Buffer.alloc(320, 0xff));
    const oldTurnId = recentTalkEvents(call).findLast(
      (event) => event.type === "turn.started",
    )?.turnId;
    expect(oldTurnId).toBeTruthy();

    callbacks.onEvent?.({
      direction: "client",
      type: "session.continuity.reset",
    });
    callbacks.onEvent?.({
      direction: "client",
      type: "session.continuity.reset",
    });

    await expectFrame(outboundMessages, "clear");
    expect(requireCancelledTurn(call).turnId).toBe(oldTurnId);
    const resetEvents = recentTalkEvents(call);
    expect(resetEvents.filter((event) => event.type === "turn.cancelled")).toHaveLength(1);
    expect(resetEvents.findIndex((event) => event.type === "output.audio.done")).toBeLessThan(
      resetEvents.findIndex((event) => event.type === "turn.cancelled"),
    );

    callbacks.onTranscript?.("user", "Fresh caller", true);
    callbacks.onTranscript?.("assistant", "Fresh assistant", true);
    callbacks.onEvent?.({ direction: "server", type: "response.done" });

    expect(transcripts(processEvent)).toEqual(["Fresh caller"]);
    expect(transcripts(processEvent, "call.assistant-speech")).toEqual(["Fresh assistant"]);
    const startedTurns = talkEvents(call, "turn.started");
    expect(startedTurns).toHaveLength(2);
    expect(startedTurns[1]?.turnId).not.toBe(oldTurnId);
  });

  it("passes the disabled input-interruption policy without cancelling speech-start", async () => {
    const { callbacks, call, createBridge, outboundMessages } = await bargeInHarness({
      providerCallId: "CA-disabled-barge-in",
      handlesProviderBargeIn: true,
      interruptResponseOnInputAudio: false,
    });
    expect(createBridge.mock.calls[0]?.[0].interruptResponseOnInputAudio).toBe(false);

    callbacks?.onAudio?.(Buffer.from([1, 2, 3]));
    await expectFrame(outboundMessages, "media");

    callbacks?.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });

    await Promise.resolve();
    expect(outboundMessages.some((message) => message.event === "clear")).toBe(false);
    expect(recentTalkEvents(call).some((event) => event.type === "turn.cancelled")).toBe(false);
  });

  it("clears queued telephony audio when provider barge-in follows response.done", async () => {
    const { callbacks, call, outboundMessages } = await bargeInHarness({
      providerCallId: "CA-late-barge-in",
      handlesProviderBargeIn: true,
    });
    callbacks?.onAudio?.(Buffer.alloc(320, 0xff));
    await expectFrame(outboundMessages, "media");
    callbacks?.onEvent?.({ direction: "server", type: "response.done" });
    const clearCountBeforeBargeIn = outboundMessages.filter(
      (message) => message.event === "clear",
    ).length;

    callbacks?.onClearAudio("barge-in");

    await waitForRealtimeTest(() =>
      expect(outboundMessages.filter((message) => message.event === "clear").length).toBe(
        clearCountBeforeBargeIn + 1,
      ),
    );
    expect(talkEvents(call, "turn.cancelled")).toHaveLength(0);
  });

  it("supplies item-relative telephony playout state to the provider bridge", async () => {
    const { callbacks, outboundMessages, ws } = await bargeInHarness({
      providerCallId: "CA-playback-state",
      handlesProviderBargeIn: true,
    });
    expect(callbacks.getPlaybackState).toBeTypeOf("function");
    expect(callbacks.getPlaybackState?.()).toEqual([]);

    callbacks?.onAudio?.(Buffer.alloc(8 * 160, 0xff), { itemId: "item-1" });
    await expectFrame(outboundMessages, "media");
    // Carrier playout remains unconfirmed until its mark receipt arrives.
    const drainedPlayback = callbacks.getPlaybackState?.();
    expect(drainedPlayback).toHaveLength(1);
    expect(drainedPlayback?.[0]?.itemId).toBe("item-1");
    expect(drainedPlayback?.[0]?.audioEndMs ?? 160).toBeLessThan(40);

    let markAcknowledged = false;
    callbacks?.onMark?.("mark-1", () => {
      markAcknowledged = true;
    });
    await expectFrame(outboundMessages, "mark");

    ws.send(JSON.stringify({ event: "mark", mark: { name: "mark-1" } }));
    await waitForRealtimeTest(() => expect(markAcknowledged).toBe(true));
    expect(callbacks.getPlaybackState?.()).toEqual([]);

    callbacks?.onClearAudio("barge-in");
    await expectFrame(outboundMessages, "clear");
    expect(callbacks.getPlaybackState?.()).toEqual([]);
  });

  it("discards provider mark acknowledgements after barge-in", async () => {
    const { callbacks, call, outboundMessages, ws } = await bargeInHarness({
      providerCallId: "CA-mark-clear",
      handlesProviderBargeIn: true,
    });
    callbacks?.onAudio?.(Buffer.alloc(8 * 160, 0xff), { itemId: "item-1" });
    await expectFrame(outboundMessages, "media");

    // Late receipts must not acknowledge marks retired by the playback reset.
    let markAcknowledged = false;
    callbacks?.onMark?.("mark-1", () => {
      markAcknowledged = true;
    });

    expect(recentTalkEvents(call).some((event) => event.type === "turn.cancelled")).toBe(false);
    callbacks?.onClearAudio("barge-in");
    expect(
      recentTalkEvents(call).findLast((event) => event.type === "output.audio.done")?.turnId,
    ).toBe(requireCancelledTurn(call).turnId);
    await expectFrame(outboundMessages, "clear");

    ws.send(JSON.stringify({ event: "mark", mark: { name: "mark-1" } }));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 60);
    });
    expect(markAcknowledged).toBe(false);
  });

  it("lets a session bridge override provider-level barge-in capabilities", async () => {
    const { callbacks, call, handleBargeIn, outboundMessages, sendAudio, ws } =
      await bargeInHarness({
        bridgeHandlesInputAudioBargeIn: false,
        handlesProviderBargeIn: true,
        providerCallId: "CA-bridge-local-barge-in",
      });
    callbacks?.onAudio?.(Buffer.from([1, 2, 3]));
    for (let i = 0; i < 4; i += 1) {
      sendMedia(ws, Buffer.alloc(160, 0x00));
    }

    await waitForRealtimeTest(() => {
      expect(sendAudio).toHaveBeenCalledTimes(4);
      expect(requireCancelledTurn(call).turnId).toMatch(/^turn-\d+$/);
      expect(outboundMessages.some((message) => message.event === "clear")).toBe(true);
    });
    expect(handleBargeIn).toHaveBeenCalledWith({ audioPlaybackActive: true });
  });

  it("clears remote playback after local pacing and output state have finished", async () => {
    const { callbacks, call, handleBargeIn, outboundMessages, ws } = await bargeInHarness({
      providerCallId: "CA-late-local-barge-in",
    });
    callbacks?.onAudio?.(Buffer.from([1, 2, 3]));
    await expectFrame(outboundMessages, "media");
    callbacks?.onEvent?.({ direction: "server", type: "response.done" });
    const clearCountBeforeBargeIn = outboundMessages.filter(
      (message) => message.event === "clear",
    ).length;

    for (let i = 0; i < 4; i += 1) {
      sendMedia(ws, Buffer.alloc(160, 0x00));
    }

    await waitForRealtimeTest(() => {
      expect(handleBargeIn).toHaveBeenCalledWith({ audioPlaybackActive: false });
      expect(outboundMessages.filter((message) => message.event === "clear").length).toBe(
        clearCountBeforeBargeIn + 1,
      );
    });
    expect(talkEvents(call, "turn.cancelled")).toHaveLength(0);
  });

  it("ends the closure-bound current call without requesting another provider response", async () => {
    const closeBridge = vi.fn();
    const submitToolResult = vi.fn();
    const endCall = vi.fn(async (_callId: string) => ({ success: true }));
    const { call, start } = makeCallHarness(
      { close: closeBridge, submitToolResult },
      {
        call: makeCallRecord("CA-end-current"),
        deps: { manager: { endCall } },
      },
    );
    const { ws, callbacks } = await start();

    const closed = waitForClose(ws);
    callTool(callbacks, "provider-end-current", "openclaw_end_call");

    await waitForRealtimeTest(() => {
      expect(endCall).toHaveBeenCalledExactlyOnceWith("call-1");
      expect(closeBridge).toHaveBeenCalledOnce();
    });
    expect(await closed).toEqual({ code: 1000, reason: "Call ended" });
    expect(submitToolResult).not.toHaveBeenCalled();
    expect(recentTalkEvents(call)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "tool.result" })]),
    );
  });

  it("reports an actionable end-call failure while leaving the current call connected", async () => {
    const closeBridge = vi.fn();
    const submitToolResult = vi.fn();
    const endCall = vi.fn(async () => ({ success: false, error: "carrier rejected hangup" }));
    const { call, start } = makeCallHarness(
      { close: closeBridge, submitToolResult },
      {
        call: makeCallRecord("CA-end-failed"),
        deps: { manager: { endCall } },
      },
    );
    const { ws, callbacks } = await start();

    callTool(callbacks, "provider-end-failed", "openclaw_end_call");

    await waitForRealtimeTest(() =>
      expect(submitToolResult).toHaveBeenCalledWith(
        "provider-end-failed",
        {
          error:
            "Could not end the current phone call: carrier rejected hangup. Tell the caller the call could not be ended and they can hang up or ask you to try again.",
        },
        undefined,
      ),
    );
    expect(endCall).toHaveBeenCalledExactlyOnceWith("call-1");
    expect(closeBridge).not.toHaveBeenCalled();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(recentTalkEvents(call)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "tool.error" })]),
    );
  });

  it("submits continuing responses only for realtime agent consult calls", async () => {
    const consultResult = createDeferred<unknown>();
    const workingSubmission = createDeferred<void>();
    const finalSubmission = createDeferred<void>();
    let receivedPartialTranscript: string | undefined;
    const submitToolResult = vi
      .fn<RealtimeVoiceBridge["submitToolResult"]>()
      .mockReturnValueOnce(workingSubmission.promise)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(finalSubmission.promise)
      .mockReturnValueOnce(finalSubmission.promise)
      .mockReturnValueOnce(undefined)
      .mockRejectedValueOnce(new Error("working result rejected"));
    const { call, handler, start } = makeCallHarness({
      supportsToolResultContinuation: true,
      submitToolResult,
    });
    const consultHandler = vi.fn(
      (_args: unknown, _callId: string, context: { partialUserTranscript?: string }) => {
        receivedPartialTranscript = context.partialUserTranscript;
        return consultResult.promise;
      },
    );
    handler.registerToolHandler("openclaw_agent_consult", consultHandler);
    handler.registerToolHandler("custom_lookup", async () => ({ ok: true }));
    const { callbacks } = await start();

    vi.useFakeTimers();
    callbacks?.onTranscript?.("user", "Are the basement", false);
    requestConsult(callbacks, "consult-call", "Are the basement lights on?");
    requestConsult(callbacks, "consult-call-2", "Are the basement lights on?");
    expect(receivedPartialTranscript).toBeUndefined();
    await waitForRealtimeTest(() =>
      expect(submitToolResult).toHaveBeenCalledWith(
        "consult-call",
        expect.objectContaining({
          status: "working",
          tool: "openclaw_agent_consult",
          message: expect.any(String),
        }),
        { willContinue: true },
      ),
    );
    workingSubmission.resolve();
    await vi.advanceTimersByTimeAsync(350);
    await waitForRealtimeTest(() => expect(receivedPartialTranscript).toBe("Are the basement"));

    expect(
      submitToolResult.mock.calls.filter(
        ([, result]) =>
          result && typeof result === "object" && "status" in result && result.status === "working",
      ),
    ).toHaveLength(2);

    consultResult.resolve({ text: "The basement lights are on." });

    await waitForRealtimeTest(() =>
      expect(submitToolResult).toHaveBeenLastCalledWith(
        "consult-call-2",
        {
          text: "The basement lights are on.",
        },
        undefined,
      ),
    );
    expect(recentTalkEvents(call).some((event) => event.type === "tool.result")).toBe(false);
    finalSubmission.resolve();
    await waitForRealtimeTest(() =>
      expect(recentTalkEvents(call).some((event) => event.type === "tool.result")).toBe(true),
    );
    expect(consultHandler).toHaveBeenCalledTimes(1);

    submitToolResult.mockClear();
    callTool(callbacks, "custom-call", "custom_lookup");

    await waitForRealtimeTest(() =>
      expect(submitToolResult).toHaveBeenCalledWith("custom-call", { ok: true }, undefined),
    );
    const customCallResults = submitToolResult.mock.calls.filter(
      ([callId]) => callId === "custom-call",
    );
    expect(customCallResults).toHaveLength(1);
    expect(customCallResults[0]?.[2]).toBeUndefined();

    submitToolResult.mockClear();
    requestConsult(callbacks, "consult-rejected", "Do not run this twice");
    await waitForRealtimeTest(() =>
      expect(recentTalkEvents(call).some((event) => event.type === "tool.error")).toBe(true),
    );
    expect(consultHandler).toHaveBeenCalledTimes(1);
    expect(submitToolResult).toHaveBeenCalledTimes(2);
    expect(submitToolResult).toHaveBeenNthCalledWith(
      1,
      "consult-rejected",
      expect.objectContaining({ status: "working" }),
      { willContinue: true },
    );
    expect(submitToolResult).toHaveBeenNthCalledWith(
      2,
      "consult-rejected",
      { error: "working result rejected" },
      undefined,
    );
  });

  const cancellationResult = { status: "cancelled", message: "Cancelled the active OpenClaw run." };
  it.each([
    {
      path: "forced",
      synchronous: false,
      outcome: {
        label: "cancellation",
        error: AbortSignal.abort().reason,
        result: cancellationResult,
      },
    },
    {
      path: "forced",
      synchronous: false,
      outcome: {
        label: "failure",
        error: new Error("Host run timed out"),
        result: { error: "Host run timed out" },
      },
    },
    {
      path: "forced",
      synchronous: false,
      outcome: { label: "empty answer", result: { text: "", canceled: true } },
    },
    {
      path: "general",
      synchronous: true,
      outcome: {
        label: "synchronous failure",
        error: new Error("Operation aborted"),
        result: { error: "Operation aborted" },
      },
    },
  ])(
    "projects $path $outcome.label once while the phone stays open",
    async ({ path, outcome, synchronous }) => {
      const submitToolResult = vi.fn();
      const sendUserMessage = vi.fn();
      const closeBridge = vi.fn();
      const { call, handler, start } = makeCallHarness(
        {
          supportsToolResultContinuation: true,
          submitToolResult,
          sendUserMessage,
          close: closeBridge,
        },
        { config: { consultPolicy: path === "forced" ? "always" : "auto" } },
      );
      const pending = createDeferred<unknown>();
      const hostTool = vi.fn((_args: unknown, _callId: string, _context: ToolHandlerContext) => {
        if (synchronous && "error" in outcome) {
          throw outcome.error;
        }
        return pending.promise;
      });
      const name = path === "general" ? "custom_lookup" : "openclaw_agent_consult";
      handler.registerToolHandler(name, hostTool);
      const { ws, callbacks: provider } = await start();

      try {
        vi.useFakeTimers();
        const question = "Check the deployment.";
        if (path === "forced") {
          provider.onTranscript?.("user", question, true);
          await vi.advanceTimersByTimeAsync(200);
          expect(hostTool).toHaveBeenCalledOnce();
        }
        const callIds = path === "general" ? ["host-tool"] : ["host-tool", "shared-host-tool"];
        for (const callId of callIds) {
          provider.onToolCall?.({ itemId: callId, callId, name, args: { question } });
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(hostTool).toHaveBeenCalledOnce();
        expect(hostTool.mock.calls[0]?.[2].abortSignal?.aborted).toBe(
          path === "general" ? undefined : false,
        );

        if ("error" in outcome && !synchronous) {
          pending.reject(outcome.error);
        } else {
          pending.resolve(outcome.result);
        }
        await vi.advanceTimersByTimeAsync(0);

        const finals = submitToolResult.mock.calls.filter(
          (submission) => !submission[2]?.willContinue,
        );
        expect(finals).toEqual(callIds.map((callId) => [callId, outcome.result, undefined]));
        const terminalEvents = recentTalkEvents(call).filter((event) =>
          ["tool.result", "tool.error"].includes(event.type),
        );
        expect(terminalEvents.map((event) => event.type)).toEqual(
          callIds.map(() => ("error" in outcome.result ? "tool.error" : "tool.result")),
        );
        expect(sendUserMessage).not.toHaveBeenCalled();
        expect(closeBridge).not.toHaveBeenCalled();
        expect(ws.readyState).toBe(WebSocket.OPEN);
        expect(hostTool.mock.calls[0]?.[2].abortSignal?.aborted).toBe(
          path === "general" ? undefined : false,
        );
      } finally {
        pending.resolve(undefined);
        ws.terminate();
      }
    },
  );

  it("clears cancelled consult dedupe for a fresh provider session", async () => {
    let sessionHarness: RealtimeVoiceSessionHarness | undefined;
    realtimeVoiceHarnessTestHooks.onCreate = (harness) => {
      sessionHarness = harness;
    };
    const submitToolResult = vi.fn();
    const { handler, start } = makeCallHarness({ submitToolResult });
    const consult = vi.fn(async () => ({ text: "fresh consult answer" }));
    handler.registerToolHandler("openclaw_agent_consult", consult);
    const { callbacks } = await start();

    const coordinator = expectDefined(
      sessionHarness,
      "voice-call realtime session harness",
    ).forcedConsults;
    const cancelled = expectDefined(
      coordinator.prepare("same question"),
      "cancelled forced consult",
    );
    coordinator.markStarted(cancelled);
    coordinator.markCancelled(cancelled);

    requestConsult(callbacks, "native-cancelled", "same question");
    await waitForRealtimeTest(() =>
      expect(submitToolResult).toHaveBeenCalledWith(
        "native-cancelled",
        {
          status: "cancelled",
          message: "OpenClaw cancelled this consult before completion. Do not restart it.",
        },
        undefined,
      ),
    );
    expect(consult).not.toHaveBeenCalled();

    resetContinuity(callbacks);
    resetContinuity(callbacks);
    expect(coordinator.handles()).toEqual([]);

    requestConsult(callbacks, "native-fresh", "same question");

    await waitForRealtimeTest(() => {
      expect(consult).toHaveBeenCalledTimes(1);
      expect(submitToolResult).toHaveBeenCalledWith(
        "native-fresh",
        { text: "fresh consult answer" },
        undefined,
      );
    });
  });

  it("keeps a replacement session's forced consult when the old result resolves late", async () => {
    const sessionHarnesses: RealtimeVoiceSessionHarness[] = [];
    realtimeVoiceHarnessTestHooks.onCreate = (harness) => {
      sessionHarnesses.push(harness);
    };
    const oldSendUserMessage = vi.fn();
    const replacementSendUserMessage = vi.fn();
    const oldSubmitToolResult = vi.fn();
    const oldCloseBridge = vi.fn();
    const bridges = [
      makeBridge({
        close: oldCloseBridge,
        sendUserMessage: oldSendUserMessage,
        submitToolResult: oldSubmitToolResult,
      }),
      makeBridge({
        sendUserMessage: replacementSendUserMessage,
      }),
    ];
    const { handler, callbacks, start } = makeCallHarness(
      (_request, index) => expectDefined(bridges[index], "replacement bridge"),
      { config: { consultPolicy: "always" } },
    );
    const oldResult = createDeferred<{ text: string }>();
    const replacementResult = createDeferred<{ text: string }>();
    const consult = vi
      .fn<
        (_args: unknown, _callId: string, context: ToolHandlerContext) => Promise<{ text: string }>
      >()
      .mockImplementationOnce(() => oldResult.promise)
      .mockImplementationOnce(() => replacementResult.promise);
    handler.registerToolHandler("openclaw_agent_consult", consult);
    const clearAudio = vi.spyOn(RealtimeAudioPacer.prototype, "clearAudio");

    try {
      const { ws: oldWs } = await start("MZ-forced-old", "CA-forced-old");
      callbacks[0]?.onTranscript?.("user", "Check the old deployment.", true);
      await waitForRealtimeTest(() => expect(consult).toHaveBeenCalledTimes(1));
      const oldCoordinator = expectDefined(
        sessionHarnesses[0],
        "old voice-call realtime session harness",
      ).forcedConsults;
      const oldForcedHandle = expectDefined(
        oldCoordinator.handles().find((handle) => handle.question === "Check the old deployment."),
        "old forced consult handle",
      );
      const stalePendingHandle = expectDefined(
        oldCoordinator.prepare("Pending work from the old session."),
        "stale pending forced consult handle",
      );
      const stalePendingRun = vi.fn();
      oldCoordinator.schedule(stalePendingHandle, 60_000, stalePendingRun);
      requestConsult(callbacks[0], "old-native-consult", "Check the old deployment.");
      expect(consult).toHaveBeenCalledTimes(1);

      await start("MZ-forced-replacement", "CA-forced-replacement");
      expect(consult.mock.calls[0]?.[2].abortSignal?.aborted).toBe(true);
      expect(oldCoordinator.handles()).not.toContainEqual(stalePendingHandle);
      expect(stalePendingRun).not.toHaveBeenCalled();
      callbacks[1]?.onTranscript?.("user", "Check the new deployment.", true);
      await waitForRealtimeTest(() => expect(consult).toHaveBeenCalledTimes(2));
      expect(clearAudio).toHaveBeenCalledTimes(2);

      requestConsult(callbacks[0], "stale-native-consult", "Check the old deployment.");
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(oldSubmitToolResult).not.toHaveBeenCalled();
      expect(consult).toHaveBeenCalledTimes(2);

      oldResult.resolve({ text: "The old deployment is healthy." });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(clearAudio).toHaveBeenCalledTimes(2);
      expect(oldSendUserMessage).not.toHaveBeenCalled();
      expect(oldCoordinator.handles()).not.toContainEqual(oldForcedHandle);

      const oldClosed = waitForClose(oldWs);
      oldWs.close();
      await oldClosed;
      await waitForRealtimeTest(() => expect(oldCloseBridge).toHaveBeenCalledTimes(1));

      replacementResult.resolve({ text: "The new deployment is healthy." });
      await waitForRealtimeTest(() => expect(replacementSendUserMessage).toHaveBeenCalledTimes(1));
      expect(replacementSendUserMessage).toHaveBeenCalledWith(
        "Internal OpenClaw consult result is ready.\nDo not call tools for this internal result.\nSpeak the following answer to the caller now, briefly and naturally:\nThe new deployment is healthy.",
      );
      expect(consult.mock.calls[1]).toEqual([
        { question: "Check the new deployment." },
        "call-1",
        { abortSignal: expect.any(AbortSignal) },
      ]);
      expect(clearAudio).toHaveBeenCalledTimes(3);
    } finally {
      clearAudio.mockRestore();
    }
  });

  it("retires predecessor audio and isolates late bridge events from its replacement", async () => {
    const oldCloseBridge = vi.fn();
    const replacementCloseBridge = vi.fn();
    const bridges = [
      makeBridge({ close: oldCloseBridge }),
      makeBridge({ close: replacementCloseBridge }),
    ];
    const { callbacks, start, processEvent, endCall } = makeCallHarness((request, index) => {
      if (index === 1) {
        request.onTranscript?.("user", "Fresh ", false);
      }
      return expectDefined(bridges[index], "replacement bridge");
    });
    const { ws: oldWs } = await start("MZ-continuity-old");
    callbacks[0]?.onTranscript?.("user", "Old ", false);

    const { ws: replacementWs } = await start("MZ-continuity-replacement");
    const replacementOutboundMessages: Array<Record<string, unknown>> = [];
    replacementWs.on("message", (data) =>
      replacementOutboundMessages.push(parseWebSocketMessage(data)),
    );
    await waitForRealtimeTest(() => expect(oldCloseBridge).toHaveBeenCalledOnce());
    callTool(callbacks[0], "stale-end-call", "openclaw_end_call");
    await Promise.resolve();
    expect(endCall).not.toHaveBeenCalled();
    expect(replacementWs.readyState).toBe(WebSocket.OPEN);

    callbacks[0]?.onAudio(Buffer.from([0x01]));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(replacementOutboundMessages).toHaveLength(0);

    callbacks[1]?.onAudio(Buffer.from([0x02]));
    await waitForRealtimeTest(() =>
      expect(replacementOutboundMessages).toEqual([
        expect.objectContaining({
          event: "media",
          media: { payload: Buffer.from([0x02]).toString("base64") },
        }),
      ]),
    );

    callbacks[0]?.onTranscript?.("user", "stale partial", false);
    callbacks[0]?.onTranscript?.("user", "stale final", true);
    callbacks[0]?.onTranscript?.("assistant", "stale assistant", true);
    resetContinuity(callbacks[0]);
    resetContinuity(callbacks[0]);
    const oldClosed = waitForClose(oldWs);
    callbacks[0]?.onClose?.("error");
    await oldClosed;
    await waitForRealtimeTest(() => expect(oldCloseBridge).toHaveBeenCalledOnce());
    expect(replacementCloseBridge).not.toHaveBeenCalled();
    expect(endCall).not.toHaveBeenCalled();
    expect(callEvents(processEvent, "call.ended")).toHaveLength(0);
    callbacks[1]?.onTranscript?.("user", "caller", true);

    await waitForRealtimeTest(() =>
      expect(transcripts(processEvent, "call.speech")).toEqual(["Fresh caller"]),
    );
    expect(callEvents(processEvent, "call.assistant-speech")).toHaveLength(0);
  });

  it("keeps the predecessor after replacement creation closes", async () => {
    const oldTriggerGreeting = vi.fn();
    const replacementConnect = vi.fn(async () => {});
    const replacementClose = vi.fn(() => {
      callbacks[1]?.onTranscript?.("user", "Failed teardown transcript", true);
      callbacks[1]?.onClose?.("error");
      throw new Error("replacement close failed");
    });
    const { callbacks, call, handler, processEvent, endCall, start } = makeCallHarness(
      (request, index) => {
        if (index === 0) {
          return makeBridge({ triggerGreeting: oldTriggerGreeting });
        }
        request.onTranscript?.("user", "Failed ", false);
        request.onClose?.("error");
        request.onTranscript?.("user", "Closed before adoption", true);
        return makeBridge({ connect: replacementConnect, close: replacementClose });
      },
    );
    await start("MZ-transcript-rollback-old");
    callbacks[0]?.onTranscript?.("user", "Old ", false);

    const replacementServer = await startRealtimeServer(handler);
    const replacementWs = await connectWs(replacementServer.url);
    const replacementClosed = waitForClose(replacementWs);
    sendCarrierStart(replacementWs, "MZ-transcript-rollback-new", call.providerCallId);
    await replacementClosed;
    expect(replacementConnect).not.toHaveBeenCalled();
    expect(replacementClose).toHaveBeenCalledTimes(1);
    callbacks[1]?.onClose?.("error");
    callbacks[1]?.onTranscript?.("user", "Late failed replacement", true);

    expect(handler.speak(call.callId, "Continue the existing call.")).toEqual({
      success: true,
    });
    expect(oldTriggerGreeting).toHaveBeenCalledWith("Continue the existing call.");
    expect(endCall).not.toHaveBeenCalled();
    expect(callEvents(processEvent, "call.ended")).toHaveLength(0);

    callbacks[0]?.onTranscript?.("user", "caller", true);
    await waitForRealtimeTest(() =>
      expect(transcripts(processEvent, "call.speech")).toEqual(["Old caller"]),
    );
  });

  it("does not share a native consult with a replacement realtime session", async () => {
    const oldSubmitToolResult = vi.fn();
    const replacementSubmitToolResult = vi.fn();
    const bridges = [
      makeBridge({
        supportsToolResultContinuation: true,
        submitToolResult: oldSubmitToolResult,
      }),
      makeBridge({
        supportsToolResultContinuation: true,
        submitToolResult: replacementSubmitToolResult,
      }),
    ];
    const { handler, callbacks, start } = makeCallHarness((_request, index) =>
      expectDefined(bridges[index], "replacement bridge"),
    );
    const oldResult = createDeferred<{ text: string }>();
    const replacementResult = createDeferred<{ text: string }>();
    const consult = vi
      .fn()
      .mockImplementationOnce(() => oldResult.promise)
      .mockImplementationOnce(() => replacementResult.promise);
    handler.registerToolHandler("openclaw_agent_consult", consult);

    await start("MZ-native-old", "CA-native-old");
    requestConsult(callbacks[0], "native-old", "Check the old deployment.");
    await waitForRealtimeTest(() => {
      expect(consult).toHaveBeenCalledTimes(1);
      expect(oldSubmitToolResult).toHaveBeenCalledTimes(1);
    });

    await start("MZ-native-replacement", "CA-native-replacement");
    requestConsult(callbacks[1], "native-replacement", "Check the new deployment.");
    await waitForRealtimeTest(() => expect(consult).toHaveBeenCalledTimes(2));

    oldResult.resolve({ text: "The old deployment is healthy." });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(oldSubmitToolResult).toHaveBeenCalledTimes(1);

    replacementResult.resolve({ text: "The new deployment is healthy." });
    await waitForRealtimeTest(() =>
      expect(replacementSubmitToolResult).toHaveBeenLastCalledWith(
        "native-replacement",
        { text: "The new deployment is healthy." },
        undefined,
      ),
    );
  });

  it("does not carry a final transcript into the next direct voice turn", async () => {
    const { processEvent, start } = makeCallHarness();
    const { callbacks } = await start();

    callbacks?.onTranscript?.("user", "Hel", false);
    callbacks?.onTranscript?.("user", "lo there.", false);
    callbacks?.onTranscript?.("user", "Hello there.", true);
    callbacks?.onTranscript?.("user", "How are you?", true);
    callbacks?.onTranscript?.("user", "Hel", false);
    callbacks?.onTranscript?.("user", "lo", true);
    callbacks?.onTranscript?.("user", "hello", false);
    callbacks?.onTranscript?.("user", "hello", false);
    callbacks?.onTranscript?.("user", "hello", true);
    const longTranscript = `${"prefix ".repeat(200)}final words.`;
    callbacks?.onTranscript?.("user", longTranscript, false);
    callbacks?.onTranscript?.("user", longTranscript, true);

    expect(transcripts(processEvent)).toEqual([
      "Hello there.",
      "How are you?",
      "Hello",
      "hello",
      longTranscript,
    ]);
  });

  it("waits for partial transcript fragments to settle before consulting", async () => {
    const submitToolResult = vi.fn();
    const { handler, start } = makeCallHarness({
      supportsToolResultContinuation: true,
      submitToolResult,
    });
    const consult = vi.fn<
      (args: unknown, callId: string, context: Record<string, unknown>) => Promise<{ text: string }>
    >(async () => ({ text: "I sent it." }));
    handler.registerToolHandler("openclaw_agent_consult", consult);
    const { callbacks } = await start();

    vi.useFakeTimers();
    callbacks?.onTranscript?.("user", "Send a Discord", false);
    requestConsult(callbacks, "consult-call", "message");
    await vi.advanceTimersByTimeAsync(50);
    callbacks?.onTranscript?.("user", "message.", false);
    await vi.advanceTimersByTimeAsync(350);

    await waitForRealtimeTest(
      () => {
        expect(consult).toHaveBeenCalledTimes(1);
      },
      { timeout: 2_000 },
    );
    const [args, callId, context] = expectDefined(consult.mock.calls.at(0), "consult");
    const consultArgs = args as { question?: string; context?: string } | undefined;
    expect(consultArgs?.question).toBe("Send a Discord message.");
    expect(consultArgs?.context).toBe(
      "Realtime provider supplied a shorter consult question: message",
    );
    expect(callId).toBe("call-1");
    expect(context).toEqual({
      partialUserTranscript: "Send a Discord message.",
      abortSignal: expect.any(AbortSignal),
    });
    await waitForRealtimeTest(() =>
      expect(submitToolResult).toHaveBeenLastCalledWith(
        "consult-call",
        { text: "I sent it." },
        undefined,
      ),
    );
  });

  it("does not force a duplicate consult when the realtime provider calls the consult tool", async () => {
    const submitToolResult = vi.fn();
    const { handler, start } = makeCallHarness(
      { supportsToolResultContinuation: true, submitToolResult },
      { config: { consultPolicy: "always" } },
    );
    const consult = vi.fn(async () => ({ text: "Native consult result." }));
    handler.registerToolHandler("openclaw_agent_consult", consult);
    const { callbacks } = await start();

    vi.useFakeTimers();
    callbacks?.onTranscript?.("user", "Send me a Discord message.", true);
    requestConsult(callbacks, "consult-call", "Send me a Discord message.");

    await waitForRealtimeTest(() =>
      expect(submitToolResult).toHaveBeenLastCalledWith(
        "consult-call",
        { text: "Native consult result." },
        undefined,
      ),
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(consult).toHaveBeenCalledTimes(1);
  });

  it("does not submit an interim checking result when fast context is enabled", async () => {
    const submitToolResult = vi.fn();
    const { handler, start } = makeCallHarness(
      { supportsToolResultContinuation: true, submitToolResult },
      {
        config: {
          fastContext: {
            enabled: true,
            timeoutMs: 800,
            maxResults: 3,
            sources: ["memory", "sessions"],
            fallbackToConsult: false,
          },
        },
      },
    );
    handler.registerToolHandler("openclaw_agent_consult", async () => ({ text: "Fast context." }));
    const { callbacks } = await start();

    requestConsult(callbacks, "consult-call", "What do you remember?");

    await waitForRealtimeTest(() =>
      expect(submitToolResult).toHaveBeenCalledWith(
        "consult-call",
        { text: "Fast context." },
        undefined,
      ),
    );
    expect(submitToolResult).toHaveBeenCalledTimes(1);
  });

  it("closes realtime streams when paced outbound audio exceeds the internal queue cap", async () => {
    const { start } = makeCallHarness();
    const { callbacks, ws } = await start();
    callbacks.onAudio(Buffer.alloc(8_000 * 121, 0x7f));
    const closed = await waitForClose(ws);

    expect(closed.code).toBe(1013);
  });

  it("rejects oversized pre-start frames before bridge setup", async () => {
    const createBridge = vi.fn(() => makeBridge());
    const processEvent = vi.fn<CallManager["processEvent"]>(async () => ({ kind: "processed" }));
    const getCallByProviderCallId = vi.fn();
    const handler = makeHandler(undefined, {
      manager: {
        processEvent,
        getCallByProviderCallId,
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const server = await startRealtimeServer(handler);

    const ws = await connectWs(server.url);
    ws.send(
      JSON.stringify({
        event: "start",
        start: {
          streamSid: "MZ-oversized",
          callSid: "CA-oversized",
          padding: "A".repeat(300 * 1024),
        },
      }),
    );

    const closed = await waitForClose(ws);

    expect(closed.code).toBe(1009);
    expect(createBridge).not.toHaveBeenCalled();
    expect(processEvent).not.toHaveBeenCalled();
    expect(getCallByProviderCallId).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

function createHandler() {
  const config = VoiceCallConfigSchema.parse({ realtime: { enabled: true } });
  const resolveRegistration = vi.fn((): never => {
    throw new Error("Rejected upgrades must not acquire a provider");
  });
  const handler = new RealtimeCallHandler(
    config.realtime,
    new CallManager(config),
    resolveRegistration,
    "/voice/webhook",
    { connect() {}, disconnect() {}, retire() {} },
  );
  return { handler, resolveRegistration };
}

describe("realtime upgrade rejection", () => {
  it.each([
    [401, "Unauthorized"],
    [503, "Service Unavailable"],
  ] as const)(
    "flushes HTTP %s before closing without acquiring a provider",
    async (status, reason) => {
      const { handler, resolveRegistration } = createHandler();
      const request = makeRequest("/voice/stream/realtime/invalid-token");
      const shutdown = createDeferred<void>();
      const closing = status === 503 ? handler.close(shutdown.promise) : undefined;
      let flush = () => {};
      let response = "";
      const socket = new Duplex({
        read() {},
        write(chunk: Buffer, _encoding, callback) {
          response += chunk.toString();
          flush = callback;
        },
      });
      const closed = once(socket, "close");
      try {
        handler.handleWebSocketUpgrade(request, socket, Buffer.alloc(0));
        expect(response).toBe(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
        expect(socket.destroyed).toBe(false);
        expect(resolveRegistration).not.toHaveBeenCalled();
        flush();
        await closed;
        expect(socket.destroyed).toBe(true);
      } finally {
        flush();
        socket.destroy();
        shutdown.resolve();
        await closing;
        await handler.close();
      }
    },
  );

  it("owns raw socket errors while rejection bytes are buffered", async () => {
    const { handler } = createHandler();
    const request = makeRequest("/voice/stream/realtime/invalid-token");
    let flush = () => {};
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        flush = callback;
      },
    });
    try {
      handler.handleWebSocketUpgrade(request, socket, Buffer.alloc(0));
      expect(() => socket.emit("error", new Error("synthetic raw socket failure"))).not.toThrow();
      expect(socket.destroyed).toBe(true);
    } finally {
      flush();
      socket.destroy();
      await handler.close();
    }
  });
});
