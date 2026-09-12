import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeVoiceBridgeCreateRequest } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import type { CallManager } from "../manager.js";
import { waitForClose } from "../websocket-test-support.js";
import {
  connectCarrierStream,
  createBridge,
  createCarrierLifecycleHarness,
} from "./realtime-handler.lifecycle.test-helpers.js";

describe("RealtimeCallHandler transcript disposal", () => {
  it.each(["provider", "transcript"] as const)(
    "retains early %s failure until the shutdown barrier settles",
    async (failureSource) => {
      const disposed = createDeferred<void>();
      const persisted = createDeferred<Awaited<ReturnType<CallManager["processEvent"]>>>();
      const barrier = createDeferred<void>();
      const failure = new Error(`${failureSource} cleanup failed`);
      const providerClose = vi.fn(() => disposed.promise);
      let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
      const { call, handler, processEvent, endCall } = createCarrierLifecycleHarness((request) => {
        callbacks = request;
        return createBridge(providerClose);
      });
      const { server, ws } = await connectCarrierStream(handler);
      let closing: Promise<void> | undefined;
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-early-failure", callSid: call.providerCallId },
          }),
        );
        await vi.waitFor(() => expect(callbacks).toBeDefined());
        processEvent.mockImplementation(async (event) =>
          event.type === "call.assistant-speech" ? persisted.promise : { kind: "processed" },
        );
        const closed = waitForClose(ws);
        closing = handler.close(barrier.promise);
        let settled = false;
        const completion = closing.then(
          () => {
            settled = true;
            return undefined;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
        await closed;
        await vi.waitFor(() => expect(providerClose).toHaveBeenCalledOnce());
        callbacks?.onTranscript?.("assistant", "Received final answer", true);
        if (failureSource === "provider") {
          disposed.reject(failure);
          persisted.resolve({ kind: "processed" });
        } else {
          disposed.resolve();
          persisted.reject(failure);
        }
        await vi.waitFor(() => expect(endCall).toHaveBeenCalledOnce());
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled).toBe(false);
        barrier.resolve();
        expect(await completion).toBe(failure);
        await expect(handler.close()).resolves.toBeUndefined();
        expect(endCall).toHaveBeenCalledOnce();
        expect(providerClose).toHaveBeenCalledOnce();
      } finally {
        barrier.resolve();
        disposed.resolve();
        persisted.resolve({ kind: "processed" });
        await closing?.catch(() => undefined);
        ws.terminate();
        await handler.close();
        await server.close();
      }
    },
  );

  it("assigns unique event IDs to finalized chunks received in the same millisecond", async () => {
    let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
    const { call, handler, processEvent } = createCarrierLifecycleHarness((request) => {
      callbacks = request;
      return createBridge(() => {});
    });
    const { server, ws } = await connectCarrierStream(handler);
    try {
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-transcript-ids", callSid: call.providerCallId },
        }),
      );
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      const timestamp = 1_720_000_000_123;
      const clock = vi.spyOn(Date, "now").mockReturnValue(timestamp);
      try {
        callbacks?.onTranscript?.("user", "First user chunk", true);
        callbacks?.onTranscript?.("user", "Second user chunk", true);
        callbacks?.onTranscript?.("assistant", "First assistant chunk", true);
        callbacks?.onTranscript?.("assistant", "Second assistant chunk", true);
      } finally {
        clock.mockRestore();
      }
      const events = processEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.type === "call.speech" || event.type === "call.assistant-speech");
      expect(events.map((event) => event.transcript)).toEqual([
        "First user chunk",
        "Second user chunk",
        "First assistant chunk",
        "Second assistant chunk",
      ]);
      expect(events.every((event) => event.timestamp === timestamp)).toBe(true);
      expect(new Set(events.map((event) => event.id)).size).toBe(4);
    } finally {
      ws.terminate();
      await handler.close();
      await server.close();
    }
  });

  it.each([
    { source: "shutdown", failure: false },
    { source: "shutdown", failure: true },
    { source: "provider", failure: false },
    { source: "provider", failure: true },
  ])("waits for $source transcript durability (failure=$failure)", async ({ source, failure }) => {
    const disposed = createDeferred<void>();
    const persisted = createDeferred<Awaited<ReturnType<CallManager["processEvent"]>>>();
    const persistenceError = new Error("final transcript persistence failed");
    const providerClose = vi.fn(() => disposed.promise);
    let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
    const { call, handler, endCall, processEvent } = createCarrierLifecycleHarness((request) => {
      callbacks = request;
      return createBridge(providerClose);
    });
    const { server, ws } = await connectCarrierStream(handler);
    let closing: Promise<void> | undefined;
    try {
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-durable-final", callSid: call.providerCallId },
        }),
      );
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      processEvent.mockImplementation(async (event) =>
        event.type === "call.assistant-speech" ? persisted.promise : { kind: "processed" },
      );
      const closed = waitForClose(ws);
      if (source === "provider") {
        callbacks?.onTranscript?.("assistant", "Final received answer", true);
        callbacks?.onClose?.("completed");
      }
      closing = handler.close();
      let settled = false;
      const completion = closing.then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await closed;
      await vi.waitFor(() => expect(providerClose).toHaveBeenCalledOnce());
      if (source === "shutdown") {
        callbacks?.onTranscript?.("assistant", "Final received answer", true);
      }
      expect(processEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "call.assistant-speech",
          transcript: "Final received answer",
        }),
      );
      disposed.resolve();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(endCall).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      if (failure) {
        persisted.reject(persistenceError);
      } else {
        persisted.resolve({ kind: "processed" });
      }
      expect(await completion).toBe(failure ? persistenceError : undefined);
      expect(endCall).toHaveBeenCalledExactlyOnceWith(call.callId, { reason: "completed" });
      expect(providerClose).toHaveBeenCalledOnce();
    } finally {
      disposed.resolve();
      persisted.resolve({ kind: "processed" });
      await closing?.catch(() => undefined);
      ws.terminate();
      await handler.close();
      await server.close();
    }
  });
});
