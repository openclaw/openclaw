import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceSessionHarness,
} from "openclaw/plugin-sdk/realtime-voice";
import { WebSocket, type RawData } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { VoiceCallRealtimeConfig } from "../config.js";
import type { CallManager } from "../manager.js";
import type { CallRecord, NormalizedEvent, ToolHandlerContext } from "../types.js";
import {
  connectWs as openWebSocket,
  startUpgradeWsServer as openUpgradeServer,
  waitForClose,
} from "../websocket-test-support.js";
import { RealtimeAudioPacer } from "./realtime-audio-pacer.js";
import { makeBridge, makeCall as makeCallRecord } from "./realtime-call-control.test-helpers.js";
import { RealtimeCallHandler } from "./realtime-handler.js";
import {
  createRealtimeConfig,
  makeRequest,
  makeRealtimeProvider,
  updateCallMetadata,
  sendCarrierStart,
} from "./realtime-handler.lifecycle.test-helpers.js";
import { StreamDisconnectGrace } from "./stream-disconnect-grace.js";

const realtimeVoiceHarnessTestHooks = vi.hoisted(() => ({
  sessions: new Map<string, RealtimeVoiceSessionHarness>(),
}));

vi.mock("openclaw/plugin-sdk/realtime-voice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/realtime-voice")>();
  return {
    ...actual,
    createRealtimeVoiceSessionHarness: (
      params: Parameters<typeof actual.createRealtimeVoiceSessionHarness>[0],
    ) => {
      const harness = actual.createRealtimeVoiceSessionHarness(params);
      realtimeVoiceHarnessTestHooks.sessions.set(params.talk.sessionId, harness);
      return harness;
    },
  };
});

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  realtimeVoiceHarnessTestHooks.sessions.clear();
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

async function waitFor(
  callback: () => void | Promise<void>,
  options: { timeout?: number; interval?: number } = {},
) {
  await vi.waitFor(callback, { interval: 1, ...options });
}

async function waitForCalls(mock: unknown, count = 1) {
  await waitFor(() => expect(mock).toHaveBeenCalledTimes(count));
}

function delay(ms = 0) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

type RealtimeBridgeRequest = Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0];
type RecentTalkEvent = { turnId?: string; type: string };

function makeCallHarness(
  bridge:
    | Partial<RealtimeVoiceBridge>
    | ((request: RealtimeBridgeRequest, index: number) => RealtimeVoiceBridge) = {},
  options: {
    call?: CallRecord;
    config?: Partial<VoiceCallRealtimeConfig>;
    deps?: {
      manager?: Partial<CallManager>;
      providerConfig?: Record<string, unknown>;
      realtimeProvider?: RealtimeVoiceProviderPlugin;
      resolveInstructions?: (call: CallRecord) => string;
      streamDisconnectLifecycle?: StreamDisconnectGrace;
    };
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
  const config = { ...createRealtimeConfig(), ...options.config };
  const streamDisconnectLifecycle =
    options.deps?.streamDisconnectLifecycle ?? new StreamDisconnectGrace(() => {});
  const provider = {
    ...makeRealtimeProvider(createBridge),
    ...options.deps?.realtimeProvider,
    createBridge,
  };
  const handler = new RealtimeCallHandler(
    config,
    {
      processEvent,
      endCall,
      updateCallMetadata,
      getCallForStream: vi.fn<CallManager["getCallForStream"]>(async () => undefined),
      getCallByProviderCallId,
      ...options.deps?.manager,
    } as unknown as CallManager,
    (record) => ({
      agentId: record.agentId ?? "main",
      provider,
      providerConfig: options.deps?.providerConfig ?? { apiKey: "test-key" },
      instructions: options.deps?.resolveInstructions?.(record) ?? config.instructions,
    }),
    "/voice/webhook",
    streamDisconnectLifecycle,
  );
  onTestFinished(async () => {
    try {
      await handler.close();
    } finally {
      streamDisconnectLifecycle.close();
    }
  });
  async function start(streamId = "MZ-test", providerCallId = call.providerCallId) {
    const count = callbacks.length;
    const ws = await connectWs((await startRealtimeServer(handler)).url);
    sendCarrierStart(ws, streamId, providerCallId);
    await waitFor(() => expect(callbacks).toHaveLength(count + 1));
    return { ws, callbacks: expectDefined(callbacks[count], "provider callbacks") };
  }
  return { call, handler, callbacks, createBridge, processEvent, endCall, start };
}

async function openConsult(
  run: Parameters<RealtimeCallHandler["registerToolHandler"]>[1],
  config?: Partial<VoiceCallRealtimeConfig>,
  bridge: Partial<RealtimeVoiceBridge> = {},
) {
  const submitToolResult = vi.fn<RealtimeVoiceBridge["submitToolResult"]>();
  const fixture = makeCallHarness({ submitToolResult, ...bridge }, { config });
  const consult = vi.fn(run);
  fixture.handler.registerToolHandler("openclaw_agent_consult", consult);
  return { ...fixture, ...(await fixture.start()), submitToolResult, consult };
}

function replacementHarness(
  bridges: RealtimeVoiceBridge[],
  config?: Partial<VoiceCallRealtimeConfig>,
) {
  return makeCallHarness((_request, index) => expectDefined(bridges[index], "replacement bridge"), {
    config,
  });
}

function registerPendingConsult(handler: RealtimeCallHandler) {
  const oldResult = createDeferred<{ text: string }>();
  const replacementResult = createDeferred<{ text: string }>();
  const consult = vi
    .fn<Parameters<RealtimeCallHandler["registerToolHandler"]>[1]>()
    .mockImplementationOnce(() => oldResult.promise)
    .mockImplementationOnce(() => replacementResult.promise);
  handler.registerToolHandler("openclaw_agent_consult", consult);
  return { oldResult, replacementResult, consult };
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

async function expectToolResult(
  submit: RealtimeVoiceBridge["submitToolResult"],
  id: string,
  result: unknown,
  last = false,
) {
  await waitFor(() => {
    if (last) {
      expect(submit).toHaveBeenLastCalledWith(id, result, undefined);
    } else {
      expect(submit).toHaveBeenCalledWith(id, result, undefined);
    }
  });
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

function sessionFor(call: CallRecord) {
  return expectDefined(
    realtimeVoiceHarnessTestHooks.sessions.get(`voice-call:${call.callId}:realtime`),
    "voice-call realtime session harness",
  );
}

function recentTalkEvents(call: CallRecord): RecentTalkEvent[] {
  return sessionFor(call).talk.recentEvents.slice(-12);
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
  await waitFor(() => expect(messages.some((message) => message.event === type)).toBe(true));
}

function requireCancelledTurn(call: CallRecord): RecentTalkEvent & { turnId: string } {
  const cancelled = recentTalkEvents(call).find((event) => event.type === "turn.cancelled");
  if (!cancelled?.turnId) {
    throw new Error("expected barge-in to cancel the active turn");
  }
  return cancelled as RecentTalkEvent & { turnId: string };
}

describe("RealtimeCallHandler path routing", () => {
  it("persists a final transcript before consulting without blocking carrier audio", async () => {
    const { callbacks, processEvent, handler, sendAudio, ws } = await bargeInHarness({
      providerCallId: "CA-pending-transcript",
    });
    const consult = vi.fn(async () => ({ text: "Deployment is healthy." }));
    handler.registerToolHandler("openclaw_agent_consult", consult);
    const persistence = createDeferred<Awaited<ReturnType<CallManager["processEvent"]>>>();
    processEvent.mockReturnValueOnce(persistence.promise);
    callbacks.onTranscript?.("user", "Check the deployment.", true);
    requestConsult(callbacks, "consult-pending-store", "Check the deployment.");
    const audio = Buffer.from([0xff, 0xfe]);
    sendMedia(ws, audio);
    try {
      await waitFor(() => expect(sendAudio).toHaveBeenCalledWith(audio));
      expect(consult).not.toHaveBeenCalled();
      expect(processEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "call.speech",
          transcript: "Check the deployment.",
        }),
      );
      persistence.resolve({ kind: "processed" });
      await waitForCalls(consult);
    } finally {
      persistence.resolve({ kind: "processed" });
    }
  });

  it("preserves a public path prefix ahead of serve.path", () => {
    const { handler } = makeCallHarness({}, { config: { streamPath: "/custom/stream/realtime" } });
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
    await waitFor(() => expect(createBridge).toHaveBeenCalled());
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

  it.each([true, false])(
    "admits Telnyx stream only when its call matches the token: %s",
    async (matches) => {
      const call = makeCallRecord("v3:call-1", {
        provider: "telnyx",
        state: "answered",
        ...(matches ? { agentId: "support", metadata: { initialMessage: "hello" } } : {}),
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
        direction: "inbound",
        ...(matches ? { from: "+15550001234", to: "+15550009999" } : {}),
      });
      const server = await startStreamSessionServer(handler, session.streamUrl);

      const ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          stream_id: "stream-1",
          start: { call_control_id: matches ? "v3:call-1" : "v3:other" },
        }),
      );
      if (!matches) {
        expect((await waitForClose(ws)).code).toBe(1008);
        expect(createBridge).not.toHaveBeenCalled();
        expect(processEvent).not.toHaveBeenCalled();
        return;
      }
      await waitFor(() => expect(createBridge).toHaveBeenCalled());

      expect(processEvent.mock.calls).toEqual([
        [expect.objectContaining({ type: "call.answered", callId: "call-1" })],
      ]);
      expect(createBridge.mock.calls[0]?.[0]).toMatchObject({
        instructions: "instructions:support",
        agentId: "support",
      });
      callbacks[0]?.onReady?.();
      expect(triggerGreeting).toHaveBeenCalledTimes(1);
      expect(triggerGreeting.mock.calls[0]?.[0]).toContain("hello");
    },
  );

  it("drains the stream before finalizing disconnect grace", async () => {
    const expired = vi.fn();
    const streamDisconnectLifecycle = new StreamDisconnectGrace(expired);
    const disconnected = createDeferred<void>();
    const disconnect = streamDisconnectLifecycle.disconnect.bind(streamDisconnectLifecycle);
    vi.spyOn(streamDisconnectLifecycle, "disconnect").mockImplementation((call, stream) => {
      disconnect(call, stream);
      disconnected.resolve();
    });
    let callbacks: RealtimeBridgeRequest | undefined;
    const close = vi.fn(() => {
      callbacks?.onTranscript?.("user", "last words", true);
      callbacks?.onClose?.("completed");
      throw new Error("provider close failed");
    });
    const { start, processEvent, endCall } = makeCallHarness(
      (request) => {
        callbacks = request;
        return makeBridge({ close });
      },
      { deps: { streamDisconnectLifecycle } },
    );
    const { ws } = await start();
    vi.useFakeTimers();
    ws.send(JSON.stringify({ event: "stop" }));
    await disconnected.promise;
    expect(close).toHaveBeenCalledOnce();
    expect(transcripts(processEvent)).toEqual(["last words"]);
    expect(endCall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(expired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(expired).toHaveBeenCalledExactlyOnceWith({
      providerCallId: "CA-test",
      streamId: "MZ-test",
    });
    vi.useRealTimers();
    const closed = waitForClose(ws);
    ws.close();
    await closed;
    expect(close).toHaveBeenCalledOnce();
    expect(expired).toHaveBeenCalledOnce();
    expect(endCall).not.toHaveBeenCalled();
  });

  it.each(["played", "retired"] as const)(
    "tracks item-relative playout for %s carrier marks",
    async (state) => {
      const { callbacks, call, outboundMessages, ws } = await bargeInHarness({
        providerCallId: "CA-playback-state",
        handlesProviderBargeIn: true,
      });
      expect(callbacks.getPlaybackState).toBeTypeOf("function");
      expect(callbacks.getPlaybackState?.()).toEqual([]);
      callbacks.onAudio(Buffer.alloc(8 * 160, 0xff), { itemId: "item-1" });
      await expectFrame(outboundMessages, "media");
      const playback = callbacks.getPlaybackState?.();
      expect(playback).toHaveLength(1);
      expect(playback?.[0]?.itemId).toBe("item-1");
      expect(playback?.[0]?.audioEndMs ?? 160).toBeLessThan(40);
      let acknowledged = false;
      callbacks.onMark?.("mark-1", () => {
        acknowledged = true;
      });
      if (state === "retired") {
        expect(talkEvents(call, "turn.cancelled")).toHaveLength(0);
        callbacks.onClearAudio("barge-in");
        expect(
          recentTalkEvents(call).findLast((event) => event.type === "output.audio.done")?.turnId,
        ).toBe(requireCancelledTurn(call).turnId);
        await expectFrame(outboundMessages, "clear");
      } else {
        await expectFrame(outboundMessages, "mark");
      }
      ws.send(JSON.stringify({ event: "mark", mark: { name: "mark-1" } }));
      if (state === "retired") {
        await delay(60);
        expect(acknowledged).toBe(false);
      } else {
        await waitFor(() => expect(acknowledged).toBe(true));
        expect(callbacks.getPlaybackState?.()).toEqual([]);
        callbacks.onClearAudio("barge-in");
        await expectFrame(outboundMessages, "clear");
      }
      expect(callbacks.getPlaybackState?.()).toEqual([]);
    },
  );

  it.each(["disabled", "override", "provider", "local"] as const)(
    "applies %s interruption policy without cancelling an ended turn",
    async (mode) => {
      const done = mode === "provider" || mode === "local";
      const { callbacks, call, createBridge, handleBargeIn, outboundMessages, sendAudio, ws } =
        await bargeInHarness({
          providerCallId: "CA-barge-in",
          handlesProviderBargeIn: mode !== "local",
          bridgeHandlesInputAudioBargeIn: mode === "override" ? false : undefined,
          interruptResponseOnInputAudio: mode === "disabled" ? false : undefined,
        });
      callbacks.onAudio(mode === "provider" ? Buffer.alloc(320, 0xff) : Buffer.from([1, 2, 3]));
      await expectFrame(outboundMessages, "media");
      if (mode === "disabled") {
        expect(createBridge.mock.calls[0]?.[0].interruptResponseOnInputAudio).toBe(false);
        callbacks.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });
        await Promise.resolve();
        expect(outboundMessages.some((message) => message.event === "clear")).toBe(false);
        expect(talkEvents(call, "turn.cancelled")).toHaveLength(0);
        return;
      }
      if (done) {
        callbacks.onEvent?.({ direction: "server", type: "response.done" });
      }
      const clears = outboundMessages.filter((message) => message.event === "clear").length;
      if (mode === "provider") {
        callbacks.onClearAudio("barge-in");
      } else {
        for (let i = 0; i < 4; i++) {
          sendMedia(ws, Buffer.alloc(160, 0x00));
        }
        await waitForCalls(sendAudio, 4);
      }
      await waitFor(() =>
        expect(outboundMessages.filter((message) => message.event === "clear")).toHaveLength(
          clears + 1,
        ),
      );
      if (done) {
        expect(talkEvents(call, "turn.cancelled")).toHaveLength(0);
        if (mode === "local") {
          expect(handleBargeIn).not.toHaveBeenCalled();
        }
      } else {
        expect(requireCancelledTurn(call).turnId).toMatch(/^turn-\d+$/);
        expect(handleBargeIn).toHaveBeenCalledWith({ audioPlaybackActive: true });
      }
    },
  );

  it.each([true, false])(
    "settles closure-bound end-call success=%s without another provider response",
    async (success) => {
      const closeBridge = vi.fn();
      const submitToolResult = vi.fn();
      const endCall = vi.fn(async () =>
        success ? { success: true } : { success: false, error: "carrier rejected hangup" },
      );
      const id = success ? "end-current" : "end-failed";
      const { call, start } = makeCallHarness(
        { close: closeBridge, submitToolResult },
        { call: makeCallRecord(`CA-${id}`), deps: { manager: { endCall } } },
      );
      const { ws, callbacks } = await start();
      const closed = success ? waitForClose(ws) : undefined;
      callTool(callbacks, `provider-${id}`, "openclaw_end_call");
      if (success) {
        await waitFor(() => {
          expect(endCall).toHaveBeenCalledExactlyOnceWith("call-1");
          expect(closeBridge).toHaveBeenCalledOnce();
        });
        expect(await closed).toEqual({ code: 1000, reason: "Call ended" });
        expect(submitToolResult).not.toHaveBeenCalled();
      } else {
        await expectToolResult(submitToolResult, `provider-${id}`, {
          error:
            "Could not end the current phone call: carrier rejected hangup. Tell the caller the call could not be ended and they can hang up or ask you to try again.",
        });
        expect(closeBridge).not.toHaveBeenCalled();
        expect(ws.readyState).toBe(WebSocket.OPEN);
      }
      expect(endCall).toHaveBeenCalledExactlyOnceWith("call-1");
      expect(talkEvents(call, success ? "tool.result" : "tool.error").length).toBeGreaterThan(0);
    },
  );

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
    // Share a handler-level replay, not a different provider invocation.
    requestConsult(callbacks, "consult-call", "Are the basement lights on?");
    expect(receivedPartialTranscript).toBeUndefined();
    await waitFor(() =>
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
    await waitFor(() => expect(receivedPartialTranscript).toBe("Are the basement"));

    expect(
      submitToolResult.mock.calls.filter(
        ([, result]) =>
          result && typeof result === "object" && "status" in result && result.status === "working",
      ),
    ).toHaveLength(2);

    consultResult.resolve({ text: "The basement lights are on." });

    await expectToolResult(
      submitToolResult,
      "consult-call",
      { text: "The basement lights are on." },
      true,
    );
    expect(recentTalkEvents(call).some((event) => event.type === "tool.result")).toBe(false);
    finalSubmission.resolve();
    await waitFor(() =>
      expect(recentTalkEvents(call).some((event) => event.type === "tool.result")).toBe(true),
    );
    expect(consultHandler).toHaveBeenCalledTimes(1);

    submitToolResult.mockClear();
    callTool(callbacks, "custom-call", "custom_lookup");

    await expectToolResult(submitToolResult, "custom-call", { ok: true });
    expect(submitToolResult.mock.calls.filter(([id]) => id === "custom-call")).toEqual([
      ["custom-call", { ok: true }, undefined],
    ]);

    submitToolResult.mockClear();
    requestConsult(callbacks, "consult-rejected", "Do not run this twice");
    await waitFor(() =>
      expect(recentTalkEvents(call).some((event) => event.type === "tool.error")).toBe(true),
    );
    expect(consultHandler).toHaveBeenCalledTimes(1);
    expect(submitToolResult.mock.calls).toEqual([
      ["consult-rejected", expect.objectContaining({ status: "working" }), { willContinue: true }],
      ["consult-rejected", { error: "working result rejected" }, undefined],
    ]);
  });

  const cancellationResult = { status: "cancelled", message: "Cancelled the active OpenClaw run." };
  it.each([
    {
      label: "cancellation",
      error: AbortSignal.abort().reason,
      result: cancellationResult,
    },
    {
      label: "failure",
      error: new Error("Host run timed out"),
      result: { error: "Host run timed out" },
    },
    { label: "empty answer", result: { text: "", canceled: true } },
    {
      path: "general",
      synchronous: true,
      label: "synchronous failure",
      error: new Error("Operation aborted"),
      result: { error: "Operation aborted" },
    },
  ])(
    "projects $label without logging tool-result content while the phone stays open",
    async ({ path = "forced", synchronous = false, ...outcome }) => {
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
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        vi.useFakeTimers();
        const question = "Check the deployment.";
        if (path === "forced") {
          provider.onTranscript?.("user", question, true);
          await vi.advanceTimersByTimeAsync(200);
        }
        const callIds = path === "general" ? ["a"] : ["a", "b"];
        for (const callId of callIds) {
          provider.onToolCall?.({ itemId: callId, callId, name, args: { question } });
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(hostTool).toHaveBeenCalledOnce();

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
        if ("error" in outcome.result) {
          expect([...log.mock.calls, ...warn.mock.calls].flat().join("\n")).not.toContain(
            outcome.result.error,
          );
        }
        const terminalEvents = recentTalkEvents(call).filter((event) =>
          ["tool.result", "tool.error"].includes(event.type),
        );
        expect(terminalEvents.map((event) => event.type)).toEqual(
          callIds.map(() => ("error" in outcome.result ? "tool.error" : "tool.result")),
        );
        expect(sendUserMessage).not.toHaveBeenCalled();
        expect(closeBridge).not.toHaveBeenCalled();
        expect(ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        log.mockRestore();
        warn.mockRestore();
        pending.resolve(undefined);
        ws.terminate();
      }
    },
  );

  it("keeps a different native request separate from a forced consult and preserves its retry", async () => {
    const submitToolResult = vi.fn();
    const sendUserMessage = vi.fn();
    const { handler, start } = makeCallHarness(
      { submitToolResult, sendUserMessage },
      { config: { consultPolicy: "always" } },
    );
    const first = createDeferred<unknown>();
    const consult = vi
      .fn<Parameters<RealtimeCallHandler["registerToolHandler"]>[1]>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ text: "Dataset B answer." });
    handler.registerToolHandler("openclaw_agent_consult", consult);
    const { callbacks } = await start();
    const questionA = "Read the complete annual report for Dataset A.";
    const questionB = "Read the separate quarterly report for Dataset B.";
    vi.useFakeTimers();
    callbacks.onTranscript?.("user", questionA, true);
    await vi.advanceTimersByTimeAsync(200);
    expect(consult).toHaveBeenCalledOnce();

    callbacks.onTranscript?.("user", questionB, true);
    requestConsult(callbacks, "request-b", questionB);
    await vi.advanceTimersByTimeAsync(0);
    const busy = expect.objectContaining({ status: "busy", started: false, retryable: true });
    expect(submitToolResult.mock.calls).toEqual([["request-b", busy, undefined]]);
    expect(consult).toHaveBeenCalledOnce();

    first.resolve({ text: "Dataset A answer." });
    await vi.advanceTimersByTimeAsync(0);
    expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Dataset A answer."));
    expect(submitToolResult.mock.calls).toEqual([["request-b", busy, undefined]]);
    requestConsult(callbacks, "retry-b", "message");
    await vi.advanceTimersByTimeAsync(0);
    expect(consult).toHaveBeenCalledTimes(2);
    expect(consult.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ question: questionB }));
    expect(submitToolResult).toHaveBeenLastCalledWith(
      "retry-b",
      { text: "Dataset B answer." },
      undefined,
    );
    callbacks.onTranscript?.("user", "Check the independent Dataset C report.", true);
    await vi.advanceTimersByTimeAsync(200);
    expect(consult).toHaveBeenCalledTimes(3);
    requestConsult(callbacks, "late-a", questionA);
    await vi.advanceTimersByTimeAsync(0);
    expect(consult).toHaveBeenCalledTimes(3);
    expect(submitToolResult).toHaveBeenLastCalledWith(
      "late-a",
      expect.objectContaining({ status: "already_delivered" }),
      undefined,
    );
  });

  it("resets transcript, playback, Talk turns and cancelled consult dedupe together", async () => {
    const { call, processEvent, ws, submitToolResult, consult, callbacks } = await openConsult(
      async () => ({ text: "fresh answer" }),
    );
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(parseWebSocketMessage(data)));
    callbacks.onTranscript?.("user", "Old caller ", false);
    callbacks.onTranscript?.("assistant", "Old assistant ", false);
    callbacks.onAudio(Buffer.alloc(320, 0xff));
    const turn = sessionFor(call).talk.activeTurnId;
    expect(turn).toBeDefined();
    const coordinator = sessionFor(call).forcedConsults;
    const cancelled = expectDefined(coordinator.prepare("same question"), "cancelled consult");
    coordinator.markStarted(cancelled);
    coordinator.markCancelled(cancelled);
    requestConsult(callbacks, "cancelled", "same question");
    await expectToolResult(submitToolResult, "cancelled", {
      status: "cancelled",
      message: "OpenClaw cancelled this consult before completion. Do not restart it.",
    });
    expect(consult).not.toHaveBeenCalled();
    resetContinuity(callbacks);
    resetContinuity(callbacks);
    await expectFrame(messages, "clear");
    expect(coordinator.handles()).toEqual([]);
    expect(requireCancelledTurn(call).turnId).toBe(turn);
    const events = recentTalkEvents(call);
    expect(talkEvents(call, "turn.cancelled")).toHaveLength(1);
    expect(events.findIndex((event) => event.type === "output.audio.done")).toBeLessThan(
      events.findIndex((event) => event.type === "turn.cancelled"),
    );
    callbacks.onTranscript?.("user", "Fresh caller", true);
    callbacks.onTranscript?.("assistant", "Fresh assistant", true);
    expect(transcripts(processEvent)).toEqual(["Fresh caller"]);
    expect(transcripts(processEvent, "call.assistant-speech")).toEqual(["Fresh assistant"]);
    expect(talkEvents(call, "turn.started")).toHaveLength(2);
    expect(sessionFor(call).talk.activeTurnId).not.toBe(turn);
    requestConsult(callbacks, "fresh", "same question");
    await expectToolResult(submitToolResult, "fresh", { text: "fresh answer" });
    expect(consult).toHaveBeenCalledOnce();
  });

  it.each(["forced", "native"] as const)(
    "isolates replacement sessions from late %s consults",
    async (path) => {
      const forced = path === "forced";
      const oldSubmit = vi.fn(),
        nextSubmit = vi.fn();
      const oldSpeech = vi.fn(),
        nextSpeech = vi.fn(),
        oldClose = vi.fn();
      const nextClose = vi.fn();
      const { call, handler, callbacks, start, endCall, processEvent } = replacementHarness(
        [
          makeBridge({
            close: oldClose,
            sendUserMessage: oldSpeech,
            submitToolResult: oldSubmit,
            supportsToolResultContinuation: true,
          }),
          makeBridge({
            sendUserMessage: nextSpeech,
            submitToolResult: nextSubmit,
            close: nextClose,
            supportsToolResultContinuation: true,
          }),
        ],
        { consultPolicy: forced ? "always" : "auto" },
      );
      const { oldResult, replacementResult, consult } = registerPendingConsult(handler);
      const clearAudio = vi.spyOn(RealtimeAudioPacer.prototype, "clearAudio");
      onTestFinished(() => {
        clearAudio.mockRestore();
      });
      const oldQuestion = "Check the old deployment.",
        nextQuestion = "Check the new deployment.";
      const { ws } = await start("MZ-old", "CA-old");
      if (forced) {
        callbacks[0]?.onTranscript?.("user", oldQuestion, true);
      } else {
        requestConsult(callbacks[0], "old", oldQuestion);
      }
      await waitForCalls(consult);
      const coordinator = sessionFor(call).forcedConsults;
      const active = forced
        ? expectDefined(
            coordinator.handles().find((handle) => handle.question === oldQuestion),
            "active forced consult",
          )
        : undefined;
      const pending = forced
        ? expectDefined(coordinator.prepare("Pending old work"), "pending forced consult")
        : undefined;
      const pendingRun = vi.fn();
      if (pending) {
        coordinator.schedule(pending, 60_000, pendingRun);
      }
      if (forced) {
        requestConsult(callbacks[0], "old-join", oldQuestion);
      } else {
        await waitForCalls(oldSubmit);
      }
      const { ws: nextWs } = await start("MZ-next", "CA-next");
      const messages: Array<Record<string, unknown>> = [];
      nextWs.on("message", (data) => messages.push(parseWebSocketMessage(data)));
      expect(consult.mock.calls[0]?.[2].abortSignal?.aborted).toBe(true);
      if (forced) {
        expect(coordinator.handles()).not.toContainEqual(pending);
        expect(pendingRun).not.toHaveBeenCalled();
        callbacks[1]?.onTranscript?.("user", nextQuestion, true);
      } else {
        requestConsult(callbacks[1], "next", nextQuestion);
      }
      await waitForCalls(consult, 2);
      callbacks[1]?.onTranscript?.("user", "Fresh ", false);
      requestConsult(callbacks[0], "stale", oldQuestion);
      callTool(callbacks[0], "stale-end", "openclaw_end_call");
      const clearCount = clearAudio.mock.calls.length;
      oldResult.resolve({ text: "Old answer" });
      await delay();
      expect(oldSpeech).not.toHaveBeenCalled();
      expect(oldSubmit).toHaveBeenCalledTimes(forced ? 0 : 1);
      expect(consult).toHaveBeenCalledTimes(2);
      if (forced) {
        expect(coordinator.handles()).not.toContainEqual(active);
      }
      callbacks[0]?.onAudio(Buffer.from([1]));
      callbacks[0]?.onTranscript?.("user", "stale partial", false);
      callbacks[0]?.onTranscript?.("user", "stale final", true);
      callbacks[0]?.onTranscript?.("assistant", "stale assistant", true);
      resetContinuity(callbacks[0]);
      resetContinuity(callbacks[0]);
      await delay();
      expect(clearAudio).toHaveBeenCalledTimes(clearCount);
      expect(messages.filter((message) => message.event === "media")).toEqual([]);
      callbacks[1]?.onAudio(Buffer.from([2]));
      await waitFor(() =>
        expect(messages).toContainEqual(
          expect.objectContaining({
            event: "media",
            media: { payload: Buffer.from([2]).toString("base64") },
          }),
        ),
      );
      const closed = waitForClose(ws);
      callbacks[0]?.onClose?.("error");
      await closed;
      await waitForCalls(oldClose);
      expect(nextClose).not.toHaveBeenCalled();
      expect(endCall).not.toHaveBeenCalled();
      expect(nextWs.readyState).toBe(WebSocket.OPEN);
      expect(callEvents(processEvent, "call.ended")).toHaveLength(0);
      callbacks[1]?.onTranscript?.("user", "caller", true);
      expect(transcripts(processEvent)).toEqual(
        forced ? [oldQuestion, nextQuestion, "Fresh caller"] : ["Fresh caller"],
      );
      expect(transcripts(processEvent, "call.assistant-speech")).toEqual([]);
      replacementResult.resolve({ text: "New answer" });
      if (forced) {
        await waitForCalls(nextSpeech);
        expect(nextSpeech).toHaveBeenCalledWith(
          "Internal OpenClaw consult result is ready.\nDo not call tools for this internal result.\nSpeak the following answer to the caller now, briefly and naturally:\nNew answer",
        );
      } else {
        await expectToolResult(nextSubmit, "next", { text: "New answer" }, true);
      }
    },
  );

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

  it.each([false, true])(
    "dedupes native-first consults and gates interim results with fast context=%s",
    async (fastContext) => {
      const result = { text: "Native answer." };
      const { submitToolResult, consult, callbacks } = await openConsult(
        async () => result,
        {
          consultPolicy: "always",
          fastContext: { ...createRealtimeConfig().fastContext, enabled: fastContext },
        },
        { supportsToolResultContinuation: true },
      );
      vi.useFakeTimers();
      callbacks.onTranscript?.("user", "What do you remember?", true);
      requestConsult(callbacks, "native", "What do you remember?");
      await expectToolResult(submitToolResult, "native", result, true);
      expect(submitToolResult).toHaveBeenCalledTimes(fastContext ? 1 : 2);
      await vi.advanceTimersByTimeAsync(250);
      expect(consult).toHaveBeenCalledOnce();
    },
  );

  it("closes realtime streams when paced outbound audio exceeds the internal queue cap", async () => {
    const { start } = makeCallHarness();
    const { callbacks, ws } = await start();
    callbacks.onAudio(Buffer.alloc(8_000 * 121, 0x7f));
    const closed = await waitForClose(ws);

    expect(closed.code).toBe(1013);
  });

  it("rejects oversized pre-start frames before bridge setup", async () => {
    const getCallByProviderCallId = vi.fn();
    const { handler, createBridge, processEvent } = makeCallHarness(
      {},
      {
        deps: { manager: { getCallByProviderCallId } },
      },
    );
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
