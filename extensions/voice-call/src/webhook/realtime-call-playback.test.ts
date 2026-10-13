import { EventEmitter } from "node:events";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallRecord } from "../types.js";
import { makeCall, makeBridge, makeHandler } from "./realtime-call-control.test-helpers.js";
import type { RealtimeCallHandler } from "./realtime-handler.js";

type RealtimeBridgeRequest = Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0];

// Replace only the socket transport; admission, carrier frames, bridge, pacing and controls stay real.
vi.mock("openclaw/plugin-sdk/websocket-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/websocket-runtime")>();
  return {
    ...actual,
    WebSocket: { OPEN: 1 },
    WebSocketServer: class {
      handleUpgrade(
        _request: unknown,
        socket: FakeCarrierSocket,
        _head: unknown,
        ready: (ws: FakeCarrierSocket) => void,
      ) {
        ready(socket);
      }
    },
  };
});

class FakeCarrierSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  readonly ready = createDeferred<void>();
  pause() {}
  resume() {
    this.ready.resolve();
  }
  send(message: string) {
    this.emit("outbound", Buffer.from(message));
  }
  receive(message: string) {
    this.emit("message", Buffer.from(message));
  }
  close() {
    if (this.readyState === 1) {
      this.readyState = 3;
      this.emit("close");
    }
  }
  terminate() {
    this.close();
  }
  destroy() {
    this.close();
  }
}

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
  const ws = new FakeCarrierSocket();
  params.handler.handleWebSocketUpgrade(
    { url: new URL(stream.streamUrl).pathname } as http.IncomingMessage,
    ws as unknown as Duplex,
    Buffer.alloc(0),
  );
  ws.receive(
    JSON.stringify({
      event: "start",
      start: { streamSid: "MZ-test", callSid: params.providerCallId },
    }),
  );
  await ws.ready.promise;
  return { ws };
}
async function closeCall(handler: RealtimeCallHandler, ws: FakeCarrierSocket) {
  ws.close();
  await handler.close();
}
afterEach(() => vi.useRealTimers());

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
    const created = createDeferred<RealtimeBridgeRequest>();
    const acknowledged = createDeferred<string>();
    const triggerGreeting = vi.fn((instructions?: string) =>
      acknowledged.resolve(instructions ?? ""),
    );
    const sendAudio = vi.fn();
    const { handler } = makeHandler({
      call,
      createBridge: (request) => {
        created.resolve(request);
        return makeBridge({ triggerGreeting, sendAudio });
      },
    });
    const { ws } = await openCall({ call, handler, providerCallId: call.providerCallId! });
    try {
      const request = await created.promise;
      vi.useFakeTimers();
      request.onReady?.();
      for (let i = 0; i < 200; i++) {
        ws.receive(
          JSON.stringify({
            event: "media",
            media: { payload: Buffer.alloc(160, 0x00).toString("base64") },
          }),
        );
      }
      await vi.advanceTimersByTimeAsync(3100);
      expect(triggerGreeting).toHaveBeenCalledTimes(1);
      expect(await acknowledged.promise).toContain("Sí, un momento");
      expect(sendAudio).not.toHaveBeenCalled();
      request.onAudio(Buffer.alloc(160, 0x00));
      await vi.advanceTimersByTimeAsync(1500);
      expect(triggerGreeting).toHaveBeenCalledTimes(1);
      call.metadata = { ...call.metadata, answeredBy: "human" };
      ws.receive(
        JSON.stringify({
          event: "media",
          media: { payload: Buffer.alloc(160, 0xff).toString("base64") },
        }),
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(triggerGreeting).toHaveBeenCalledTimes(2);
      expect(triggerGreeting.mock.calls[1]?.[0]).toContain("The opening");
    } finally {
      vi.useRealTimers();
      await closeCall(handler, ws);
    }
  });

  it("rejects host speech immediately while the provider is still closing", async () => {
    const call = makeCall("CA-closing");
    const closed = createDeferred<void>();
    const { handler } = makeHandler({
      call,
      createBridge: () => makeBridge({ close: () => closed.promise }),
    });
    const { ws } = await openCall({ call, handler, providerCallId: call.providerCallId! });
    try {
      vi.useFakeTimers();
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
    } finally {
      closed.resolve();
      vi.useRealTimers();
      await closeCall(handler, ws);
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
      const created = createDeferred<RealtimeBridgeRequest>();
      const triggerGreeting = vi.fn();
      const { handler } = makeHandler({
        call,
        createBridge: (request) => {
          created.resolve(request);
          return makeBridge({ triggerGreeting });
        },
      });
      const { ws } = await openCall({ call, handler, providerCallId: call.providerCallId! });
      try {
        const request = await created.promise;
        vi.useFakeTimers();
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
            ws.receive(
              JSON.stringify({
                event: "media",
                media: { payload: Buffer.alloc(160, 0xff).toString("base64") },
              }),
            );
            request.onAudio(Buffer.alloc(160, mode === "silent" ? 0xff : 0x00));
            await vi.advanceTimersByTimeAsync(1000);
          }
        }
        await result;
        expect(settled).toHaveBeenCalledWith(mode === "audible" ? "done" : "failed");
      } finally {
        vi.useRealTimers();
        await closeCall(handler, ws);
      }
    },
  );
});
