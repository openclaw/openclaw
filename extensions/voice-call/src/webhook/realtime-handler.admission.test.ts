import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { CallManager } from "../manager.js";
import { waitForClose } from "../websocket-test-support.js";
import {
  connectCarrierStream,
  createBridge,
  createCarrierLifecycleHarness,
} from "./realtime-handler.lifecycle.test-helpers.js";

describe("RealtimeCallHandler lifecycle", () => {
  it("preserves a concurrently admitted bridge when another creation fails", async () => {
    const firstPersistence = createDeferred<Awaited<ReturnType<CallManager["processEvent"]>>>();
    const secondPersistence = createDeferred<Awaited<ReturnType<CallManager["processEvent"]>>>();
    const greeting = vi.fn();
    const createBridgeForCall = vi
      .fn<RealtimeVoiceProviderPlugin["createBridge"]>()
      .mockImplementationOnce(() => createBridge(vi.fn(), { triggerGreeting: greeting }))
      .mockImplementationOnce(() => {
        throw new Error("concurrent realtime bridge creation failed");
      });
    const { call, handler, endCall, hangupCall, processEvent } =
      createCarrierLifecycleHarness(createBridgeForCall);
    let answered = 0;
    processEvent.mockImplementation(async (event) => {
      if (event.type === "call.answered") {
        return ++answered === 1 ? firstPersistence.promise : secondPersistence.promise;
      }
      return { kind: "processed" };
    });
    const first = await connectCarrierStream(handler);
    let second: Awaited<ReturnType<typeof connectCarrierStream>> | undefined;

    try {
      first.ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-concurrent-first", callSid: call.providerCallId },
        }),
      );
      await vi.waitFor(() => expect(answered).toBe(1));
      second = await connectCarrierStream(handler);
      const secondClosed = waitForClose(second.ws);
      second.ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-concurrent-second", callSid: call.providerCallId },
        }),
      );
      await vi.waitFor(() => expect(answered).toBe(2));
      expect(createBridgeForCall).not.toHaveBeenCalled();

      firstPersistence.resolve({ kind: "processed" });
      await vi.waitFor(() => expect(createBridgeForCall).toHaveBeenCalledOnce());
      expect(handler.speak(call.callId, "first bridge is active")).toEqual({ success: true });
      secondPersistence.resolve({ kind: "processed" });
      expect(await secondClosed).toEqual({
        code: 1011,
        reason: "Failed to create realtime bridge",
      });

      expect(createBridgeForCall).toHaveBeenCalledTimes(2);
      expect(endCall).not.toHaveBeenCalled();
      expect(hangupCall).not.toHaveBeenCalled();
      expect(first.ws.readyState).toBe(WebSocket.OPEN);
      expect(handler.speak(call.callId, "first bridge remains active")).toEqual({ success: true });
      expect(greeting).toHaveBeenLastCalledWith("first bridge remains active");
    } finally {
      firstPersistence.resolve({ kind: "processed" });
      secondPersistence.resolve({ kind: "processed" });
      first.ws.terminate();
      second?.ws.terminate();
      await handler.close();
      await second?.server.close();
      await first.server.close();
    }
  });
});
