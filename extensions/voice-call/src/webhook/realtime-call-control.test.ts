import type http from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceToolCallEvent,
} from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import type { CallRecord } from "../types.js";
import { connectWs, startUpgradeWsServer, waitForClose } from "../websocket-test-support.js";
import { makeCall, makeBridge, makeHandler } from "./realtime-call-control.test-helpers.js";
import { RealtimeCallHandler } from "./realtime-handler.js";

type RealtimeBridgeRequest = Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0];

async function openCall(params: {
  call: CallRecord;
  handler: RealtimeCallHandler;
  providerCallId: string;
}) {
  const stream = params.handler.issueStreamSession({
    providerName: "twilio",
    callId: params.call.callId,
    direction: params.call.direction,
  });
  const server = await startUpgradeWsServer({
    urlPath: new URL(stream.streamUrl).pathname,
    onUpgrade: (request: http.IncomingMessage, socket, head) => {
      params.handler.handleWebSocketUpgrade(request, socket, head);
    },
  });
  const ws = await connectWs(server.url);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  ws.send(
    JSON.stringify({
      event: "start",
      start: { streamSid: `MZ-${params.providerCallId}`, callSid: params.providerCallId },
    }),
  );
  onTestFinished(async () => {
    vi.useRealTimers();
    await closeCall(params.handler, server, ws);
  });
  return { server, ws };
}

async function connectCall(
  providerCallId: string,
  options: Omit<Parameters<typeof makeHandler>[0], "call" | "createBridge"> & {
    call?: CallRecord;
    bridge?: Partial<RealtimeVoiceBridge>;
  } = {},
) {
  const call = options.call ?? makeCall(providerCallId);
  const created = createDeferred<RealtimeBridgeRequest>();
  const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
    created.resolve(request);
    return makeBridge(options.bridge);
  });
  const fixture = makeHandler({ ...options, call, createBridge });
  const connection = await openCall({ call, handler: fixture.handler, providerCallId });
  await vi.waitFor(() => expect(createBridge).toHaveBeenCalledOnce());
  return { ...fixture, ...connection, call, request: await created.promise };
}

async function closeCall(
  handler: RealtimeCallHandler,
  server: { close: () => Promise<void> },
  ws: WebSocket,
) {
  if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
    const closed = waitForClose(ws);
    ws.close();
    await closed;
  }
  await handler.close();
  await server.close();
}

describe("realtime call control over the Twilio stream", () => {
  it("retires the realtime producer without ending a call before carrier playback", async () => {
    const close = vi.fn();
    const { call, handler, processEvent } = await connectCall("CA-carrier-playback", {
      bridge: { close },
    });
    await handler.prepareCarrierPlayback(call.callId);
    expect(close).toHaveBeenCalledOnce();
    expect(handler.speak(call.callId, "Too late")).toMatchObject({ success: false });
    expect(processEvent.mock.calls).not.toContainEqual([
      expect.objectContaining({ type: "call.ended" }),
    ]);
  });

  it("abandons a pending realtime admission when carrier voicemail takes ownership", async () => {
    const providerCallId = "CA-pending-playback";
    const call = makeCall(providerCallId);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const createBridge = vi.fn(() => makeBridge());
    const { handler, manager, endCall } = makeHandler({ call, createBridge });
    manager.updateCallMetadata = vi.fn(async (record, update) => {
      entered.resolve();
      await release.promise;
      record.metadata = update(record.metadata);
    });
    const { ws } = await openCall({ call, handler, providerCallId });
    try {
      await entered.promise;
      call.metadata = { ...call.metadata, voicemailStatus: "pending" };
      await handler.prepareCarrierPlayback(call.callId);
      const closed = waitForClose(ws);
      release.resolve();
      await closed;
      expect(createBridge).not.toHaveBeenCalled();
      expect(endCall).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
  });

  it("keeps a native consult running when far-side speech arrives during silent model output", async () => {
    const receivedAudio = createDeferred<void>();
    const consultStarted = createDeferred<AbortSignal | undefined>();
    const consultResult = createDeferred<{ text: string }>();
    const handleBargeIn = vi.fn();
    let inputFrames = 0;
    const {
      handler,
      ws,
      request: callbacks,
    } = await connectCall("CA-silent-consult", {
      nativeConsult: true,
      bridge: {
        handleBargeIn,
        sendAudio: () => {
          if (++inputFrames === 4) {
            receivedAudio.resolve();
          }
        },
      },
    });
    handler.registerToolHandler("openclaw_agent_consult", (_args, _callId, context) => {
      consultStarted.resolve(context?.abortSignal);
      return consultResult.promise;
    });
    try {
      vi.useFakeTimers();
      const pending = callbacks?.runAgentConsult?.({ prompt: "Check reservation availability" });
      const signal = await consultStarted.promise;
      callbacks?.onAudio?.(Buffer.alloc(160, 0xff));
      for (let i = 0; i < 4; i += 1) {
        ws.send(
          JSON.stringify({
            event: "media",
            media: { payload: Buffer.alloc(160, 0x00).toString("base64") },
          }),
        );
      }
      await receivedAudio.promise;
      expect(handleBargeIn).not.toHaveBeenCalled();
      expect(signal?.aborted).toBe(false);
      consultResult.resolve({ text: "Reservations are available" });
      await expect(pending).resolves.toEqual({ text: "Reservations are available" });
    } finally {
      consultResult.resolve({ text: "Finished" });
    }
  });

  it("pauses speech-idle hang-up while an agent consult is in flight", async () => {
    const endCall = vi.fn(async () => ({ success: true }));
    const { handler, request: callbacks } = await connectCall("CA-idle", {
      endCall,
      idleHangupMs: 1_000,
    });

    const consulted = createDeferred<{ text: string }>();
    handler.registerToolHandler("openclaw_agent_consult", () => consulted.promise);
    vi.useFakeTimers();
    callbacks?.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });
    callbacks?.onToolCall?.({
      itemId: "consult-idle",
      callId: "consult-idle",
      name: "openclaw_agent_consult",
      args: { question: "Check it" },
    } satisfies RealtimeVoiceToolCallEvent);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(endCall).not.toHaveBeenCalled();
    consulted.resolve({ text: "Done" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(endCall).toHaveBeenCalledWith("call-1", { reason: "timeout" });
  });

  it("keeps the call alive while buffered assistant audio is still playing out", async () => {
    const endCall = vi.fn(async () => ({ success: true }));
    const { request: callbacks } = await connectCall("CA-playout", {
      endCall,
      idleHangupMs: 1_000,
    });

    vi.useFakeTimers();
    // Three seconds of loud 8 kHz mu-law arrive at once; the pacer plays them out over time.
    const loud = Buffer.alloc(24_000);
    for (let index = 0; index < loud.length; index += 2) {
      loud[index] = 0x00;
      loud[index + 1] = 0x80;
    }
    callbacks?.onAudio(loud);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(endCall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(endCall).toHaveBeenCalledWith("call-1", { reason: "timeout" });
  });

  it("keeps the call alive during sustained caller speech and ends after silence", async () => {
    let receivedFrame = createDeferred<void>();
    const endCall = vi.fn(async () => ({ success: true }));
    const { ws } = await connectCall("CA-sustained-speech", {
      endCall,
      idleHangupMs: 1_000,
      bridge: { sendAudio: () => receivedFrame.resolve() },
    });

    vi.useFakeTimers();
    const loudFrame = Buffer.alloc(160, 0x00).toString("base64");
    for (let index = 0; index < 5; index += 1) {
      receivedFrame = createDeferred<void>();
      ws.send(JSON.stringify({ event: "media", media: { payload: loudFrame } }));
      await receivedFrame.promise;
      await vi.advanceTimersByTimeAsync(600);
      expect(endCall).not.toHaveBeenCalled();
    }

    await vi.advanceTimersByTimeAsync(399);
    expect(endCall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(endCall).toHaveBeenCalledExactlyOnceWith("call-1", { reason: "timeout" });
  });

  it("waits for outbound speech and cancels the independent greeting fallback", async () => {
    const triggerGreeting = vi.fn();
    const opening = "Buenas tardes. ¿A qué hora cierran hoy?";
    const call = makeCall("CA-opening", {
      direction: "outbound",
      metadata: { initialMessage: opening },
    });
    const { request: callbacks } = await connectCall("CA-opening", {
      call,
      nativeConsult: true,
      bridge: { triggerGreeting },
    });

    expect(callbacks.instructions).toContain(`Answer: ${JSON.stringify(opening)}`);
    vi.useFakeTimers();
    callbacks?.onReady?.();
    callbacks?.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(triggerGreeting).not.toHaveBeenCalled();
  });

  it("keeps function-tool outbound greetings immediate with the original instructions", async () => {
    const triggerGreeting = vi.fn();
    const opening = "Buenas tardes. ¿A qué hora cierran hoy?";
    const call = makeCall("CA-function-tool-opening", {
      direction: "outbound",
      metadata: { initialMessage: opening },
    });
    const { request: callbacks } = await connectCall("CA-function-tool-opening", {
      call,
      bridge: { triggerGreeting },
    });

    expect(callbacks.instructions).toBe("Be helpful.");
    callbacks?.onReady?.();
    expect(triggerGreeting).toHaveBeenCalledExactlyOnceWith(
      `Be helpful.\n\nStart the call by greeting the caller naturally. Include this greeting in your first spoken reply: "${opening}"`,
    );
  });
});
