import { once } from "node:events";
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
import { makeBridge, makeCall, makeHandler } from "./realtime-call-control.test-helpers.js";
import type { RealtimeCallHandler } from "./realtime-handler.js";
import { sendCarrierStart } from "./realtime-handler.lifecycle.test-helpers.js";

async function openCall(call: CallRecord, handler: RealtimeCallHandler) {
  const stream = handler.issueStreamSession({
    providerName: "twilio",
    callId: call.callId,
    direction: call.direction,
  });
  const server = await startUpgradeWsServer({
    urlPath: new URL(stream.streamUrl).pathname,
    onUpgrade: (request, socket, head) => handler.handleWebSocketUpgrade(request, socket, head),
  });
  const ws = await connectWs(server.url);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  sendCarrierStart(ws, `MZ-${call.providerCallId}`, call.providerCallId);
  onTestFinished(async () => {
    vi.useRealTimers();
    if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
      const closed = waitForClose(ws);
      ws.close();
      await closed;
    }
    await handler.close();
    await server.close();
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
  const created = createDeferred<Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0]>();
  const createBridge = vi.fn(
    (request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0]) => {
      created.resolve(request);
      return makeBridge(options.bridge);
    },
  );
  const fixture = makeHandler({ ...options, call, createBridge });
  const connection = await openCall(call, fixture.handler);
  await vi.waitFor(() => expect(createBridge).toHaveBeenCalledOnce());
  // Admission pauses socket reads; pong also proves its finally block resumed them.
  await flushCarrier(connection.ws);
  vi.useFakeTimers();
  return { ...fixture, ...connection, call, request: await created.promise };
}

function sendAudio(ws: WebSocket, audio: Buffer) {
  ws.send(JSON.stringify({ event: "media", media: { payload: audio.toString("base64") } }));
}

async function flushCarrier(ws: WebSocket) {
  // Media handlers are synchronous after admission; the following pong is a FIFO barrier.
  const pong = once(ws, "pong");
  ws.ping();
  await pong;
}

const opening = "Buenas tardes. ¿A qué hora cierran hoy?";
describe("realtime call control over the Twilio stream", () => {
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
    const { ws } = await openCall(call, handler);
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
    const consultStarted = createDeferred<AbortSignal | undefined>();
    const consultResult = createDeferred<{ text: string }>();
    const handleBargeIn = vi.fn();
    const sendAudioToModel = vi.fn();
    const {
      handler,
      ws,
      request: callbacks,
    } = await connectCall("CA-silent-consult", {
      nativeConsult: true,
      bridge: { handleBargeIn, sendAudio: sendAudioToModel },
    });
    handler.registerToolHandler("openclaw_agent_consult", (_args, _callId, context) => {
      consultStarted.resolve(context?.abortSignal);
      return consultResult.promise;
    });
    try {
      const pending = callbacks?.runAgentConsult?.({ prompt: "Check reservation availability" });
      const signal = await consultStarted.promise;
      callbacks?.onAudio?.(Buffer.alloc(160, 0xff));
      for (let i = 0; i < 4; i += 1) {
        sendAudio(ws, Buffer.alloc(160, 0x00));
      }
      await flushCarrier(ws);
      expect(sendAudioToModel).toHaveBeenCalledTimes(4);
      expect(handleBargeIn).not.toHaveBeenCalled();
      expect(signal?.aborted).toBe(false);
      consultResult.resolve({ text: "Reservations are available" });
      await expect(pending).resolves.toEqual({ text: "Reservations are available" });
    } finally {
      consultResult.resolve({ text: "Finished" });
    }
  });

  it("pauses speech-idle hang-up while an agent consult is in flight", async () => {
    const {
      handler,
      endCall,
      request: callbacks,
    } = await connectCall("CA-idle", {
      idleHangupMs: 1_000,
    });

    const consulted = createDeferred<{ text: string }>();
    handler.registerToolHandler("openclaw_agent_consult", () => consulted.promise);
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
    const { endCall, request: callbacks } = await connectCall("CA-playout", {
      idleHangupMs: 1_000,
    });

    // Three seconds of loud 8 kHz mu-law arrive at once; the pacer plays them out over time.
    callbacks?.onAudio(Buffer.alloc(24_000, Buffer.from([0x00, 0x80])));
    await vi.advanceTimersByTimeAsync(2_500);
    expect(endCall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(endCall).toHaveBeenCalledWith("call-1", { reason: "timeout" });
  });

  it("keeps the call alive during sustained caller speech and ends after silence", async () => {
    const { ws, endCall } = await connectCall("CA-sustained-speech", {
      idleHangupMs: 1_000,
    });

    const loudFrame = Buffer.alloc(160, 0x00);
    for (let index = 0; index < 5; index += 1) {
      sendAudio(ws, loudFrame);
      await flushCarrier(ws);
      await vi.advanceTimersByTimeAsync(600);
      expect(endCall).not.toHaveBeenCalled();
    }

    await vi.advanceTimersByTimeAsync(399);
    expect(endCall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(endCall).toHaveBeenCalledExactlyOnceWith("call-1", { reason: "timeout" });
  });

  it.each([false, true])(
    "preserves outbound greeting timing (native consult=%s)",
    async (nativeConsult) => {
      const triggerGreeting = vi.fn();
      const { request } = await connectCall("CA-opening", {
        call: makeCall("CA-opening", {
          direction: "outbound",
          metadata: { initialMessage: opening },
        }),
        nativeConsult,
        bridge: { triggerGreeting },
      });
      request.onReady?.();
      if (nativeConsult) {
        expect(request.instructions).toContain(`Answer: ${JSON.stringify(opening)}`);
        expect(request.instructions).toContain("Then stop and listen.");
        expect(triggerGreeting).not.toHaveBeenCalled();
        request.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });
        await vi.advanceTimersByTimeAsync(3_000);
        expect(triggerGreeting).not.toHaveBeenCalled();
      } else {
        expect(request.instructions).toBe("Be helpful.");
        expect(triggerGreeting).toHaveBeenCalledExactlyOnceWith(
          `Be helpful.\n\nStart the call by greeting the caller naturally. Include this greeting in your first spoken reply: "${opening}"`,
        );
      }
    },
  );
});

describe("realtime playback through carrier frames", () => {
  it("acknowledges sustained speech once during AMD while holding the opening", async () => {
    const call = makeCall("CA-chatty", {
      direction: "outbound",
      metadata: {
        initialMessage: "The opening",
        voicemailManagedByHost: true,
        brief: { language: "Spanish" },
      },
    });
    const triggerGreeting = vi.fn<(instructions?: string) => void>();
    const forwardAudio = vi.fn();
    const { ws, request } = await connectCall("CA-chatty", {
      call,
      bridge: { triggerGreeting, sendAudio: forwardAudio },
    });
    request.onReady?.();
    for (let i = 0; i < 200; i++) {
      sendAudio(ws, Buffer.alloc(160, 0x00));
    }
    await flushCarrier(ws);
    await vi.advanceTimersByTimeAsync(3100);
    expect(triggerGreeting).toHaveBeenCalledTimes(1);
    expect(triggerGreeting.mock.calls[0]?.[0]).toContain("Sí, un momento");
    expect(forwardAudio).not.toHaveBeenCalled();
    request.onAudio(Buffer.alloc(160, 0x00));
    await vi.advanceTimersByTimeAsync(1500);
    expect(triggerGreeting).toHaveBeenCalledTimes(1);
    call.metadata = { ...call.metadata, answeredBy: "human" };
    sendAudio(ws, Buffer.alloc(160, 0xff));
    await flushCarrier(ws);
    await vi.advanceTimersByTimeAsync(1);
    expect(triggerGreeting).toHaveBeenCalledTimes(2);
    expect(triggerGreeting.mock.calls[1]?.[0]).toContain("The opening");
  });

  it("retires realtime playback without ending the call and rejects speech during closure", async () => {
    const call = makeCall("CA-closing");
    const closed = createDeferred<void>();
    const close = vi.fn(() => closed.promise);
    const { handler, processEvent } = await connectCall("CA-closing", {
      call,
      bridge: { close },
    });
    try {
      const closing = handler.prepareCarrierPlayback(call.callId);
      const settled = vi.fn();
      const late = handler.playVoicemail(call.callId, "too late")?.then(
        () => settled("done"),
        () => settled("closed"),
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledWith("closed");
      await late;
      closed.resolve();
      await closing;
      expect(close).toHaveBeenCalledOnce();
      expect(handler.speak(call.callId, "Too late")).toMatchObject({ success: false });
      expect(processEvent.mock.calls).not.toContainEqual([
        expect.objectContaining({ type: "call.ended" }),
      ]);
    } finally {
      closed.resolve();
    }
  });

  it.each(["audible", "silent", "continuous", "closed"] as const)(
    "settles realtime voicemail after audible silence or bounded failure (%s)",
    async (mode) => {
      const call = makeCall("CA-voicemail", {
        direction: "outbound",
        metadata: {
          voicemailManagedByHost: true,
          answeredBy: "machine_end_beep",
        },
      });
      const triggerGreeting = vi.fn();
      const { handler, ws, request } = await connectCall("CA-voicemail", {
        call,
        bridge: { triggerGreeting },
      });
      request.onReady?.();
      const playback = handler.playVoicemail(call.callId, "Speak the voicemail");
      expect(playback).toBeDefined();
      const settled = vi.fn();
      const result = playback?.then(
        () => settled("done"),
        () => settled("failed"),
      );
      expect(triggerGreeting).toHaveBeenCalledWith("Speak the voicemail");
      await vi.advanceTimersByTimeAsync(2000);
      expect(settled).not.toHaveBeenCalled();
      if (mode === "closed") {
        await handler.prepareCarrierPlayback(call.callId);
      } else if (mode === "audible") {
        request.onAudio(Buffer.alloc(160, 0x00));
        await vi.advanceTimersByTimeAsync(1400);
        request.onAudio(Buffer.alloc(160, 0x00));
        await vi.advanceTimersByTimeAsync(1400);
        request.onAudio(Buffer.alloc(160, 0xff));
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(100);
      } else {
        for (let i = 0; i < 43; i++) {
          sendAudio(ws, Buffer.alloc(160, 0xff));
          await flushCarrier(ws);
          request.onAudio(Buffer.alloc(160, mode === "silent" ? 0xff : 0x00));
          await vi.advanceTimersByTimeAsync(1000);
        }
      }
      await result;
      expect(settled).toHaveBeenCalledWith(mode === "audible" ? "done" : "failed");
    },
  );
});
