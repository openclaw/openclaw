import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallManager } from "../manager.js";
import { connectWs, startUpgradeWsServer, waitForClose } from "../websocket-test-support.js";
import type { RealtimeCallHandler, ResolveRealtimeCallRegistration } from "./realtime-handler.js";
import {
  connectCarrierStream,
  sendCarrierStart,
  createBridge,
  createCarrierLifecycleHarness,
  makeRealtimeProvider,
} from "./realtime-handler.lifecycle.test-helpers.js";

async function openBridge(
  close: RealtimeVoiceBridge["close"],
  overrides: Partial<RealtimeVoiceBridge> = {},
  options: Parameters<typeof createCarrierLifecycleHarness>[1] = {},
  delegation: boolean | NonNullable<RealtimeVoiceProviderPlugin["capabilities"]> = false,
) {
  const ready = createDeferred<RealtimeVoiceBridgeCreateRequest>();
  const createBridgeForCall = vi.fn((request: RealtimeVoiceBridgeCreateRequest) => {
    ready.resolve(request);
    return createBridge(close, overrides);
  });
  const provider = makeRealtimeProvider(createBridgeForCall);
  const fixture = createCarrierLifecycleHarness(
    createBridgeForCall,
    delegation
      ? {
          ...options,
          resolveCallRegistration: () => ({
            agentId: "main",
            instructions: "Help the caller.",
            provider,
            providerConfig: {},
            capabilities:
              typeof delegation === "boolean"
                ? {
                    transports: ["gateway-relay"],
                    inputAudioFormats: [],
                    outputAudioFormats: [],
                    handlesAgentConsult: true,
                  }
                : delegation,
          }),
        }
      : options,
  );
  const { ws } = await connectCarrierStream(fixture.handler);
  sendCarrierStart(ws, "MZ-test", fixture.call.providerCallId);
  await vi.waitFor(() => expect(createBridgeForCall).toHaveBeenCalledOnce());
  return { ...fixture, ws, callbacks: await ready.promise };
}

function endedEvents(
  processEvent: ReturnType<typeof createCarrierLifecycleHarness>["processEvent"],
) {
  return processEvent.mock.calls.filter(([event]) => event.type === "call.ended");
}

const nextImmediate = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

describe("RealtimeCallHandler lifecycle", () => {
  it("abandons pending carrier admission on shutdown", async () => {
    const persistence = createDeferred<Awaited<ReturnType<CallManager["processEvent"]>>>();
    const createBridgeForCall = vi.fn<RealtimeVoiceProviderPlugin["createBridge"]>(() =>
      createBridge(() => {}),
    );
    const { call, handler, processEvent, endCall } =
      createCarrierLifecycleHarness(createBridgeForCall);
    processEvent.mockReturnValueOnce(persistence.promise);
    const { ws } = await connectCarrierStream(handler);
    try {
      sendCarrierStart(ws, "MZ-pending-store", call.providerCallId);
      const audio = Buffer.from([0xff, 0xfe, 0xfd]);
      ws.send(JSON.stringify({ event: "media", media: { payload: audio.toString("base64") } }));
      await vi.waitFor(() => expect(processEvent).toHaveBeenCalledOnce());
      expect(createBridgeForCall).not.toHaveBeenCalled();
      let closed = false;
      const closing = handler.close().then(() => {
        closed = true;
      });
      await waitForClose(ws);
      expect(closed).toBe(false);
      persistence.resolve({ kind: "processed" });
      await closing;
      expect(createBridgeForCall).not.toHaveBeenCalled();
      expect(endCall).toHaveBeenCalledOnce();
    } finally {
      persistence.resolve({ kind: "processed" });
    }
  });

  it("keeps a failed startup nonterminal until manager-owned carrier termination succeeds", async () => {
    const termination = createDeferred<{ success: boolean; error?: string }>();
    const endCall = vi.fn(() => termination.promise);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { call, handler, processEvent } = createCarrierLifecycleHarness(
      () => {
        throw new Error("realtime provider rejected call configuration");
      },
      { endCall },
    );
    const { ws } = await connectCarrierStream(handler);

    try {
      const closed = waitForClose(ws);
      sendCarrierStart(ws, "MZ-provider-first", call.providerCallId);

      expect((await closed).code).toBe(1011);
      expect(endCall).toHaveBeenCalledExactlyOnceWith(call.callId, { reason: "error" });
      expect(endedEvents(processEvent)).toHaveLength(0);
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("carrier unavailable"));

      termination.resolve({ success: false, error: "carrier unavailable" });
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("carrier unavailable")),
      );
      expect(endedEvents(processEvent)).toHaveLength(0);
      expect(call.state).toBe("ringing");
    } finally {
      termination.resolve({ success: false, error: "carrier unavailable" });
      warn.mockRestore();
    }
  });

  it("warns and removes a stream token when the provider never connects", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handler } = createCarrierLifecycleHarness(() => createBridge(vi.fn()));

    try {
      handler.issueStreamSession({
        callId: "call-never-connected",
        from: "+15550001111",
        to: "+15550002222",
      });

      await vi.advanceTimersByTimeAsync(30_000);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("never connected"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("call-never-connected"));
      expect(
        (
          handler as unknown as {
            pendingStreamTokens: Map<string, unknown>;
          }
        ).pendingStreamTokens.size,
      ).toBe(0);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    { closeOutcome: "error" as const, closeReason: "Bridge disconnected" },
    { closeOutcome: "throws" as const, closeReason: "Failed to connect" },
  ])(
    "hangs up a rejected startup exactly once when provider close is $closeOutcome",
    async ({ closeOutcome, closeReason }) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let onProviderClose: ((reason: "completed" | "error") => void) | undefined;
      const closeBridge = vi.fn(() => {
        if (closeOutcome === "throws") {
          throw new Error("realtime provider close failed");
        }
        if (closeOutcome) {
          onProviderClose?.(closeOutcome);
        }
      });
      const { call, handler, endCall } = createCarrierLifecycleHarness((request) => {
        onProviderClose = request.onClose;
        return createBridge(closeBridge, {
          connect: async () => {
            throw new Error("realtime provider rejected startup");
          },
        });
      });
      const { ws } = await connectCarrierStream(handler);

      try {
        const closed = waitForClose(ws);
        sendCarrierStart(ws, "MZ-startup", call.providerCallId);

        expect(await closed).toEqual({ code: 1011, reason: closeReason });
        await handler.close();
        expect(
          warn.mock.calls.filter(([message]) =>
            String(message).includes("realtime provider close failed"),
          ),
        ).toHaveLength(closeOutcome === "throws" ? 1 : 0);
        expect(closeBridge).toHaveBeenCalledTimes(1);
        expect(endCall).toHaveBeenCalledExactlyOnceWith(call.callId, { reason: "error" });
        expect(handler.speak(call.callId, "still connected")).toEqual({
          success: false,
          error: "No active realtime bridge for call",
        });
      } finally {
        warn.mockRestore();
      }
    },
  );

  it("ends an initial call when routed realtime admission fails", async () => {
    const createBridgeForCall = vi.fn<RealtimeVoiceProviderPlugin["createBridge"]>();
    const resolveCallRegistration = vi.fn(() => {
      throw new Error("routed agent realtime is unavailable");
    });
    const { call, handler, endCall, processEvent } = createCarrierLifecycleHarness(
      createBridgeForCall,
      {
        initialMessage: "Hello from the routed agent.",
        resolveCallRegistration,
      },
    );
    const { ws } = await connectCarrierStream(handler);

    const closed = waitForClose(ws);
    sendCarrierStart(ws, "MZ-admission-failure", call.providerCallId);

    expect((await closed).code).toBe(1011);
    expect(resolveCallRegistration).toHaveBeenCalledExactlyOnceWith(call);
    expect(createBridgeForCall).not.toHaveBeenCalled();
    expect(processEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "call.initiated",
      "call.ended",
    ]);
    expect(endCall).toHaveBeenCalledExactlyOnceWith(call.callId, { reason: "error" });
    expect(call.metadata?.initialMessage).toBe("Hello from the routed agent.");
    expect(handler.speak(call.callId, "still connected")).toEqual({
      success: false,
      error: "No active realtime bridge for call",
    });
  });

  it("preserves the active predecessor when replacement admission fails", async () => {
    const predecessorGreeting = vi.fn();
    const realtimeProvider = makeRealtimeProvider(
      vi.fn(() => createBridge(vi.fn(), { triggerGreeting: predecessorGreeting })),
    );
    const resolveCallRegistration = vi
      .fn<ResolveRealtimeCallRegistration>()
      .mockReturnValueOnce({
        agentId: "main",
        instructions: "Be helpful.",
        provider: realtimeProvider,
        providerConfig: { apiKey: "test-key" },
      })
      .mockImplementationOnce(() => {
        throw new Error("replacement agent realtime is unavailable");
      });
    const { call, handler, endCall, processEvent } = createCarrierLifecycleHarness(
      realtimeProvider.createBridge,
      { resolveCallRegistration },
    );
    const predecessor = await connectCarrierStream(handler);

    sendCarrierStart(predecessor.ws, "MZ-predecessor", call.providerCallId);
    await vi.waitFor(() => expect(realtimeProvider.createBridge).toHaveBeenCalledTimes(1));

    const replacement = await connectCarrierStream(handler);
    const replacementClosed = waitForClose(replacement.ws);
    sendCarrierStart(replacement.ws, "MZ-replacement-admission", call.providerCallId);

    expect((await replacementClosed).code).toBe(1011);
    expect(resolveCallRegistration).toHaveBeenCalledTimes(2);
    expect(realtimeProvider.createBridge).toHaveBeenCalledTimes(1);
    expect(
      processEvent.mock.calls.filter(([event]) => event.type === "call.answered"),
    ).toHaveLength(1);
    expect(endedEvents(processEvent)).toHaveLength(0);
    expect(endCall).not.toHaveBeenCalled();
    expect(predecessor.ws.readyState).toBe(WebSocket.OPEN);
    expect(handler.speak(call.callId, "predecessor remains connected")).toEqual({
      success: true,
    });
    expect(predecessorGreeting).toHaveBeenCalledWith("predecessor remains connected");
  });

  it("does not hang up a replacement when its stale predecessor rejects startup", async () => {
    const pendingStartup = createDeferred<void>();
    const replacementGreeting = vi.fn();
    const createBridgeForCall = vi
      .fn<RealtimeVoiceProviderPlugin["createBridge"]>()
      .mockImplementationOnce(() =>
        createBridge(vi.fn(), { connect: () => pendingStartup.promise }),
      )
      .mockImplementationOnce(() =>
        createBridge(vi.fn(), { triggerGreeting: replacementGreeting }),
      );
    const { call, handler, endCall, processEvent } =
      createCarrierLifecycleHarness(createBridgeForCall);
    const previous = await connectCarrierStream(handler);

    sendCarrierStart(previous.ws, "MZ-previous", call.providerCallId);
    await vi.waitFor(() => expect(createBridgeForCall).toHaveBeenCalledTimes(1));

    const replacement = await connectCarrierStream(handler);
    sendCarrierStart(replacement.ws, "MZ-replacement", call.providerCallId);
    await vi.waitFor(() => expect(createBridgeForCall).toHaveBeenCalledTimes(2));

    const previousClosed = waitForClose(previous.ws);
    pendingStartup.reject(new Error("superseded provider rejected startup"));
    expect((await previousClosed).code).toBe(1011);
    expect(endCall).not.toHaveBeenCalled();
    expect(endedEvents(processEvent)).toHaveLength(0);
    expect(replacement.ws.readyState).toBe(WebSocket.OPEN);
    expect(handler.speak(call.callId, "replacement remains connected")).toEqual({
      success: true,
    });
    expect(replacementGreeting).toHaveBeenCalledWith("replacement remains connected");
  });

  it("ends the call after inactivity following media renewal", async () => {
    const bridgeStarted = createDeferred<void>();
    const mediaReceived = createDeferred<void>();
    const sendAudio = vi.fn(() => mediaReceived.resolve());
    const closeBridge = vi.fn();
    const { call, handler, endCall, processEvent } = createCarrierLifecycleHarness(() => {
      bridgeStarted.resolve();
      return createBridge(closeBridge, { sendAudio });
    });
    const { ws } = await connectCarrierStream(handler);

    try {
      vi.useFakeTimers();
      sendCarrierStart(ws, "MZ-inactivity", call.providerCallId);
      await bridgeStarted.promise;

      await vi.advanceTimersByTimeAsync(29_999);
      ws.send(
        JSON.stringify({
          event: "media",
          media: { payload: Buffer.from([0xff]).toString("base64") },
        }),
      );
      await mediaReceived.promise;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sendAudio).toHaveBeenCalledOnce();
      expect(endCall).not.toHaveBeenCalled();
      expect(ws.readyState).toBe(WebSocket.OPEN);
      expect(endedEvents(processEvent)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(endedEvents(processEvent)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);

      expect(closeBridge).toHaveBeenCalledOnce();
      expect(endCall).toHaveBeenCalledExactlyOnceWith(call.callId, { reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["settling", "running"] as const)(
    "retires a native consult during stream teardown (%s)",
    async (phase) => {
      let consultSignal: AbortSignal | undefined;
      const submitToolResult = vi.fn();
      const { handler, ws, callbacks } = await openBridge(vi.fn(), {
        supportsToolResultContinuation: true,
        submitToolResult,
      });
      const consult = vi.fn<ToolHandler>(async (_args, _callId, context) => {
        consultSignal = context.abortSignal;
        return await new Promise<unknown>((_resolve, reject) => {
          context.abortSignal?.addEventListener(
            "abort",
            () =>
              reject(new Error("native consult aborted", { cause: context.abortSignal?.reason })),
            { once: true },
          );
        });
      });
      handler.registerToolHandler("openclaw_agent_consult", consult);
      if (phase === "settling") {
        callbacks.onTranscript?.("user", "Check the deployment", false);
      }
      callbacks.onToolCall?.({
        itemId: "item-consult",
        callId: "tool-consult",
        name: "openclaw_agent_consult",
        args: { question: "Check the deployment." },
      });
      const consults = (
        handler as unknown as {
          nativeConsultsInFlightByCallId: Map<string, unknown>;
        }
      ).nativeConsultsInFlightByCallId;
      await vi.waitFor(() => {
        expect(consults.size).toBe(1);
        expect(submitToolResult).toHaveBeenCalledOnce();
        if (phase === "settling") {
          expect(consult).not.toHaveBeenCalled();
        } else {
          expect(consultSignal).toBeDefined();
        }
      });
      const closed = waitForClose(ws);
      ws.close();
      await closed;
      await vi.waitFor(() => expect(consults.size).toBe(0));
      if (phase === "settling") {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 400);
        });
        expect(consult).not.toHaveBeenCalled();
      } else {
        expect(consultSignal?.aborted).toBe(true);
        await nextImmediate();
      }
      expect(submitToolResult).toHaveBeenCalledOnce();
    },
  );

  it("preserves a concurrently admitted bridge when another creation fails", async () => {
    const firstPersistence = createDeferred<Awaited<ReturnType<CallManager["processEvent"]>>>();
    const secondPersistence = createDeferred<Awaited<ReturnType<CallManager["processEvent"]>>>();
    const greeting = vi.fn();
    const sendAudio = vi.fn();
    const createBridgeForCall = vi
      .fn<RealtimeVoiceProviderPlugin["createBridge"]>()
      .mockImplementationOnce(() => createBridge(vi.fn(), { triggerGreeting: greeting, sendAudio }))
      .mockImplementationOnce(() => {
        throw new Error("concurrent realtime bridge creation failed");
      });
    const { call, handler, endCall, processEvent } =
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
      sendCarrierStart(first.ws, "MZ-concurrent-first", call.providerCallId);
      const audio = Buffer.from([0xff, 0xfe, 0xfd]);
      first.ws.send(
        JSON.stringify({ event: "media", media: { payload: audio.toString("base64") } }),
      );
      await vi.waitFor(() => expect(answered).toBe(1));
      second = await connectCarrierStream(handler);
      const secondClosed = waitForClose(second.ws);
      sendCarrierStart(second.ws, "MZ-concurrent-second", call.providerCallId);
      await vi.waitFor(() => expect(answered).toBe(2));
      expect(createBridgeForCall).not.toHaveBeenCalled();
      expect(sendAudio).not.toHaveBeenCalled();

      firstPersistence.resolve({ kind: "processed" });
      await vi.waitFor(() => expect(sendAudio).toHaveBeenCalledWith(audio));
      expect(createBridgeForCall).toHaveBeenCalledOnce();
      expect(handler.speak(call.callId, "first bridge is active")).toEqual({ success: true });
      secondPersistence.resolve({ kind: "processed" });
      expect((await secondClosed).code).toBe(1011);

      expect(createBridgeForCall).toHaveBeenCalledTimes(2);
      expect(endCall).not.toHaveBeenCalled();
      expect(first.ws.readyState).toBe(WebSocket.OPEN);
      expect(handler.speak(call.callId, "first bridge remains active")).toEqual({ success: true });
      expect(greeting).toHaveBeenLastCalledWith("first bridge remains active");
    } finally {
      firstPersistence.resolve({ kind: "processed" });
      secondPersistence.resolve({ kind: "processed" });
    }
  });

  it.each(["complete", "abort", "close", "disabled"] as const)(
    "uses the call-owned consult handler and preserves its %s outcome",
    async (outcome) => {
      const connect = vi.fn(async () => {});
      const submitToolResult = vi.fn();
      const {
        handler,
        call,
        callbacks: request,
      } = await openBridge(
        vi.fn(),
        {
          connect,
          submitToolResult,
          outputAudioMode: "continuous",
          handlesInputAudioBargeIn: true,
        },
        outcome === "disabled" ? { toolPolicy: "none" } : {},
        {
          transports: ["gateway-relay"],
          inputAudioFormats: [],
          outputAudioFormats: [],
          handlesAgentConsult: true,
          supportsBargeIn: false,
          handlesInputAudioBargeIn: true,
        },
      );
      let admittedSignal: AbortSignal | undefined;
      const pending = createDeferred<void>();
      const effects: string[] = [];
      handler.registerToolHandler("openclaw_agent_consult", async (args, callId, context) => {
        expect(args).toEqual({ question: "Read my itinerary" });
        expect(callId).toBe(call.callId);
        admittedSignal = context.abortSignal;
        await pending.promise;
        context.abortSignal?.throwIfAborted();
        effects.push("itinerary-read");
        return { text: "The train leaves at noon." };
      });
      const controller = new AbortController();
      try {
        await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
        if (!request?.runAgentConsult) {
          throw new Error("Native delegation was not wired to the carrier session");
        }
        expect(request.tools).toEqual([]);
        const result = request.runAgentConsult({
          prompt: "Read my itinerary",
          signal: controller.signal,
        });
        const settled = result.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        if (outcome !== "disabled") {
          await vi.waitFor(() => expect(admittedSignal).toBeDefined());
        }
        if (outcome === "abort") {
          controller.abort(new Error("Caller cancelled"));
        } else if (outcome === "close") {
          await handler.close();
        }
        pending.resolve();
        if (outcome === "complete") {
          expect(await settled).toEqual({ value: { text: "The train leaves at noon." } });
          expect(effects).toEqual(["itinerary-read"]);
        } else {
          expect(await settled).toEqual({ error: expect.any(Error) });
          expect(admittedSignal?.aborted).toBe(outcome === "disabled" ? undefined : true);
          expect(effects).toEqual([]);
        }
        expect(submitToolResult).not.toHaveBeenCalled();
        await handler.close();
        await expect(request.runAgentConsult({ prompt: "Late work" })).rejects.toThrow(
          /closed|active/,
        );
        expect(effects).toHaveLength(outcome === "complete" ? 1 : 0);
      } finally {
        pending.resolve();
      }
    },
  );

  it.each(["provider", "shutdown", "failed transcript", "manager settlement"] as const)(
    "joins provider disposal, transcript durability and %s",
    async (source) => {
      const disposed = createDeferred<void>();
      const persisted = createDeferred<Awaited<ReturnType<CallManager["processEvent"]>>>();
      const barrier = createDeferred<void>();
      const termination = createDeferred<{ success: boolean }>();
      const failure = new Error("transcript cleanup failed");
      const providerClose = vi.fn(() => disposed.promise);
      const managerSettlement = source === "manager settlement";
      const { call, handler, endCall, processEvent, ws, callbacks } = await openBridge(
        providerClose,
        {},
        managerSettlement ? { endCall: () => termination.promise } : {},
      );
      let closing: Promise<void> | undefined;
      try {
        if (!managerSettlement) {
          processEvent.mockImplementation(async (event) =>
            event.type === "call.assistant-speech" ? persisted.promise : { kind: "processed" },
          );
        }
        const closed = waitForClose(ws);
        if (source === "provider") {
          callbacks.onTranscript?.("assistant", "Final received answer", true);
          callbacks.onClose?.("completed");
        }
        const hasBarrier = managerSettlement || source === "failed transcript";
        closing = hasBarrier ? handler.close(barrier.promise) : handler.close();
        if (managerSettlement) {
          expect(handler.close()).toBe(closing);
        }
        const session = managerSettlement ? handler.issueStreamSession() : undefined;
        let settled = false;
        const completion = closing
          .catch((error: unknown) => error)
          .finally(() => {
            settled = true;
          });
        await closed;
        await vi.waitFor(() => expect(providerClose).toHaveBeenCalledOnce());
        expect(endCall).not.toHaveBeenCalled();
        if (source !== "provider") {
          callbacks.onTranscript?.("assistant", "Final received answer", true);
          await vi.waitFor(() =>
            expect(processEvent).toHaveBeenCalledWith(
              expect.objectContaining({ type: "call.assistant-speech" }),
            ),
          );
        }
        expect(processEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "call.assistant-speech",
            transcript: "Final received answer",
          }),
        );
        disposed.resolve();
        if (hasBarrier) {
          if (source === "failed transcript") {
            persisted.reject(failure);
          }
          await vi.waitFor(() =>
            expect(endCall).toHaveBeenCalledExactlyOnceWith(call.callId, { reason: "completed" }),
          );
          if (managerSettlement) {
            const recorded = processEvent.mock.calls.length;
            callbacks.onTranscript?.("assistant", "Late after disposal", true);
            expect(processEvent).toHaveBeenCalledTimes(recorded);
          }
          await nextImmediate();
          expect(settled).toBe(false);
          barrier.resolve();
          if (managerSettlement) {
            await Promise.resolve();
            expect(settled).toBe(false);
            termination.resolve({ success: true });
          }
          expect(await completion).toBe(managerSettlement ? undefined : failure);
          expect(settled).toBe(true);
          if (!managerSettlement) {
            await expect(handler.close()).resolves.toBeUndefined();
          }
        } else {
          await nextImmediate();
          expect(endCall).not.toHaveBeenCalled();
          expect(settled).toBe(false);
          persisted.resolve({ kind: "processed" });
          expect(await completion).toBeUndefined();
        }
        expect(endCall).toHaveBeenCalledExactlyOnceWith(call.callId, { reason: "completed" });
        expect(providerClose).toHaveBeenCalledOnce();
        if (session) {
          const server = await startUpgradeWsServer({
            urlPath: new URL(session.streamUrl).pathname,
            onUpgrade: (request, socket, head) =>
              handler.handleWebSocketUpgrade(request, socket, head),
          });
          try {
            await expect(connectWs(server.url)).rejects.toThrow("Unexpected server response: 401");
          } finally {
            await server.close();
          }
        }
      } finally {
        barrier.resolve();
        disposed.resolve();
        persisted.resolve({ kind: "processed" });
        termination.resolve({ success: true });
        await closing?.catch(() => undefined);
      }
    },
  );
});

type ToolHandler = Parameters<RealtimeCallHandler["registerToolHandler"]>[1];
async function createConsultFixture(delegation = false) {
  const submit = vi.fn<RealtimeVoiceBridge["submitToolResult"]>();
  const {
    handler,
    processEvent,
    callbacks: request,
  } = await openBridge(
    vi.fn(),
    {
      supportsToolResultContinuation: true,
      submitToolResult: submit,
    },
    {},
    delegation,
  );
  const consult = vi.fn<ToolHandler>();
  handler.registerToolHandler("openclaw_agent_consult", consult);
  return {
    consult,
    processEvent,
    provider: {
      request,
      submit,
      invoke: (id: string, args: unknown) => {
        request.onToolCall?.({
          itemId: `item-${id}`,
          callId: id,
          name: "openclaw_agent_consult",
          args,
        });
      },
      finalResults: (id: string) =>
        submit.mock.calls.filter(([callId, , options]) => callId === id && !options?.willContinue),
    },
  };
}

const speechA = "Read the latest report for Dataset A.";
const speechB = "Now check the independent report for Dataset B.";
const responseA = { text: "Answer A." };
const responseB = { text: "Answer B." };

afterEach(() => vi.useRealTimers());

describe("native realtime consult request identity", () => {
  it.each([
    {
      label: "invocation ID with identical arguments",
      args: { question: "Check Dataset A.", context: "2025" },
    },
    { label: "question", args: { question: "Check Dataset B.", context: "2025" } },
  ])("rejects an overlapping different $label and accepts its later retry", async ({ args }) => {
    const { consult, provider } = await createConsultFixture();
    vi.useFakeTimers();
    const first = createDeferred<unknown>();
    consult.mockImplementationOnce(() => first.promise).mockResolvedValue(responseB);
    provider.invoke("first", { question: "Check Dataset A.", context: "2025" });
    await vi.advanceTimersByTimeAsync(0);
    expect(consult).toHaveBeenCalledOnce();
    provider.invoke("different", args);
    await vi.advanceTimersByTimeAsync(0);
    const overlappingSubmissions = provider.submit.mock.calls.filter(([id]) => id === "different");
    expect(consult).toHaveBeenCalledOnce();

    first.resolve(responseA);
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.finalResults("first")).toEqual([["first", { text: "Answer A." }, undefined]]);
    const busy = {
      status: "busy",
      started: false,
      retryable: true,
      error: expect.stringMatching(/different request.*not started.*retry/i),
    };
    expect(provider.finalResults("different")).toEqual([["different", busy, undefined]]);
    expect(overlappingSubmissions).toEqual([["different", busy, undefined]]);

    provider.invoke("retry", args);
    await vi.advanceTimersByTimeAsync(0);
    expect(consult).toHaveBeenCalledTimes(2);
    expect(consult.mock.calls[1]?.[0]).toEqual(args);
    expect(provider.finalResults("retry")).toEqual([["retry", { text: "Answer B." }, undefined]]);
  });

  it.each([
    { phase: "working response", final: true },
    { phase: "completed ASR", final: true },
    { phase: "same completed ASR", final: true },
    { phase: "transcript persistence", final: false },
  ])("isolates rejected speech during $phase (final=$final)", async ({ phase, final }) => {
    const { consult, provider, processEvent } = await createConsultFixture();
    const first = createDeferred<unknown>();
    const working = createDeferred<void>();
    const persistence = createDeferred<Awaited<ReturnType<typeof processEvent>>>();
    consult.mockImplementationOnce(() => first.promise).mockResolvedValue(responseB);
    if (phase === "working response" || phase.includes("completed ASR")) {
      provider.submit.mockImplementationOnce(() => working.promise);
    }
    if (phase === "transcript persistence") {
      processEvent.mockReturnValueOnce(persistence.promise);
    }
    vi.useFakeTimers();
    try {
      provider.request.onTranscript?.(
        "user",
        phase.includes("completed ASR") ? "Read the latest report" : speechA,
        phase === "transcript persistence",
      );
      provider.invoke("first", { question: "message" });
      await vi.advanceTimersByTimeAsync(0);
      if (final) {
        provider.request.onTranscript?.("user", speechA, true);
      }
      if (phase !== "same completed ASR") {
        provider.request.onTranscript?.("user", speechB, final);
      }
      provider.invoke("different", { question: "message" });
      await vi.advanceTimersByTimeAsync(0);
      expect(consult).not.toHaveBeenCalled();
      persistence.resolve({ kind: "processed" });
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.finalResults("different")).toEqual([
        [
          "different",
          expect.objectContaining({ status: "busy", started: false, retryable: true }),
          undefined,
        ],
      ]);
      expect(provider.submit.mock.calls.filter(([id]) => id === "different")).toHaveLength(1);
      working.resolve();
      await vi.advanceTimersByTimeAsync(350);
      expect(consult).toHaveBeenCalledOnce();
      expect(consult.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ question: speechA }));
      expect(consult.mock.calls[0]?.[2].partialUserTranscript).toBe(speechA);

      first.resolve(responseA);
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.finalResults("different")).toHaveLength(1);
      provider.invoke("retry", { question: phase === "same completed ASR" ? speechB : "message" });
      await vi.advanceTimersByTimeAsync(350);
      expect(consult).toHaveBeenCalledTimes(2);
      expect(consult.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ question: speechB }));
      expect(consult.mock.calls[1]?.[2].partialUserTranscript).toBe(
        phase === "same completed ASR" ? undefined : speechB,
      );
      expect(provider.finalResults("retry")).toEqual([["retry", { text: "Answer B." }, undefined]]);
    } finally {
      working.resolve();
      persistence.resolve({ kind: "processed" });
      first.resolve({ text: "Cleanup." });
    }
  });

  it("captures native delegation context before transcript persistence yields", async () => {
    const { consult, provider, processEvent } = await createConsultFixture(true);
    const delegate = expectDefined(provider.request.runAgentConsult, "native delegation");
    const persisted = createDeferred<Awaited<ReturnType<typeof processEvent>>>();
    const first = createDeferred<unknown>();
    processEvent.mockReturnValueOnce(persisted.promise);
    consult.mockImplementationOnce(() => first.promise).mockResolvedValue(responseB);
    vi.useFakeTimers();
    try {
      provider.request.onTranscript?.("user", speechA, true);
      const answerA = delegate({ prompt: "message" });
      provider.request.onTranscript?.("user", speechB, false);
      const busy = delegate({ prompt: "message" }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(consult).not.toHaveBeenCalled();
      persisted.resolve({ kind: "processed" });
      await vi.advanceTimersByTimeAsync(350);
      expect(await busy).toBeInstanceOf(Error);
      expect(consult).toHaveBeenCalledOnce();
      expect(consult.mock.calls[0]?.[2].partialUserTranscript).toBe(speechA);
      first.resolve(responseA);
      await expect(answerA).resolves.toEqual({ text: "Answer A." });
      const answerB = delegate({ prompt: "message" });
      await vi.advanceTimersByTimeAsync(350);
      await expect(answerB).resolves.toEqual({ text: "Answer B." });
      expect(consult.mock.calls[1]?.[2].partialUserTranscript).toBe(speechB);
      expect(provider.submit).not.toHaveBeenCalled();
    } finally {
      persisted.resolve({ kind: "processed" });
      first.resolve({ text: "Cleanup." });
    }
  });

  it("keeps an empty admission snapshot separate from later speech", async () => {
    const { consult, provider } = await createConsultFixture();
    const working = createDeferred<void>();
    const first = createDeferred<unknown>();
    consult.mockImplementationOnce(() => first.promise).mockResolvedValue(responseB);
    provider.submit.mockImplementationOnce(() => working.promise);
    vi.useFakeTimers();
    try {
      provider.invoke("first", { question: "Dataset A" });
      await vi.advanceTimersByTimeAsync(0);
      const laterSpeech = "Read the independent report for Dataset B.";
      provider.request.onTranscript?.("user", laterSpeech, false);
      provider.invoke("different", { question: "Dataset B" });
      await vi.advanceTimersByTimeAsync(0);
      working.resolve();
      await vi.advanceTimersByTimeAsync(350);
      expect(consult.mock.calls[0]?.[0]).toEqual({ question: "Dataset A" });
      expect(consult.mock.calls[0]?.[2].partialUserTranscript).toBeUndefined();
      first.resolve(responseA);
      await vi.advanceTimersByTimeAsync(0);
      provider.invoke("retry", { question: "message" });
      await vi.advanceTimersByTimeAsync(350);
      expect(consult.mock.calls[1]?.[2].partialUserTranscript).toBe(laterSpeech);
    } finally {
      working.resolve();
      first.resolve({ text: "Cleanup." });
    }
  });

  it.each(["repeats", "extends"])(
    "preserves an independent final that %s the active question",
    async (kind) => {
      const { consult, provider } = await createConsultFixture();
      const first = createDeferred<unknown>();
      consult.mockImplementationOnce(() => first.promise).mockResolvedValue(responseB);
      const laterSpeech = kind === "repeats" ? speechA : `${speechA} Include this year's totals.`;
      vi.useFakeTimers();
      try {
        provider.request.onTranscript?.("user", speechA, true);
        provider.invoke("first", { question: "message" });
        await vi.advanceTimersByTimeAsync(0);
        expect(consult).toHaveBeenCalledOnce();
        provider.request.onTranscript?.("user", laterSpeech, true);
        provider.invoke("different", { question: "message" });
        await vi.advanceTimersByTimeAsync(0);
        expect(provider.finalResults("different")).toEqual([
          ["different", expect.objectContaining({ status: "busy" }), undefined],
        ]);
        first.resolve(responseA);
        await vi.advanceTimersByTimeAsync(0);
        provider.invoke("retry", { question: "message" });
        await vi.advanceTimersByTimeAsync(0);
        expect(consult).toHaveBeenCalledTimes(2);
        expect(consult.mock.calls[1]?.[2].partialUserTranscript).toBe(laterSpeech);
      } finally {
        first.resolve({ text: "Cleanup." });
      }
    },
  );

  it("lets exact replays keep collecting their own transcript before dispatch", async () => {
    const { consult, provider } = await createConsultFixture();
    consult.mockResolvedValue(responseA);
    vi.useFakeTimers();
    provider.request.onTranscript?.("user", "Read the latest report", false);
    provider.invoke("first", { question: "message" });
    await vi.advanceTimersByTimeAsync(50);
    provider.request.onTranscript?.("user", "for Dataset A.", false);
    provider.invoke("first", { question: "message" });
    await vi.advanceTimersByTimeAsync(350);
    expect(consult).toHaveBeenCalledOnce();
    expect(consult.mock.calls[0]?.[2].partialUserTranscript).toBe(speechA);
    expect(provider.finalResults("first")).toHaveLength(2);
  });
});
