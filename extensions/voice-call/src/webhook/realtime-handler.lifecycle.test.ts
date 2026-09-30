import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { CallManager } from "../manager.js";
import { connectWs, startUpgradeWsServer, waitForClose } from "../websocket-test-support.js";
import type { ResolveRealtimeCallRegistration } from "./realtime-handler.js";
import {
  connectCarrierStream,
  sendCarrierStart,
  createBridge,
  createCarrierLifecycleHarness,
  makeRealtimeProvider,
} from "./realtime-handler.lifecycle.test-helpers.js";

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
      expect(processEvent.mock.calls.filter(([event]) => event.type === "call.ended")).toHaveLength(
        0,
      );
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("carrier unavailable"));

      termination.resolve({ success: false, error: "carrier unavailable" });
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("carrier unavailable")),
      );
      expect(processEvent.mock.calls.filter(([event]) => event.type === "call.ended")).toHaveLength(
        0,
      );
      expect(call.state).toBe("ringing");
    } finally {
      termination.resolve({ success: false, error: "carrier unavailable" });
      warn.mockRestore();
    }
  });

  it("waits for provider cleanup and manager shutdown termination", async () => {
    const termination = createDeferred<{ success: boolean }>();
    const barrier = createDeferred<void>();
    const disposed = createDeferred<void>();
    const endCall = vi.fn(() => termination.promise);
    const closeBridge = vi.fn(() => disposed.promise);
    let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
    const { call, handler, processEvent } = createCarrierLifecycleHarness(
      (request) => {
        callbacks = request;
        return createBridge(closeBridge);
      },
      { endCall },
    );
    const { ws } = await connectCarrierStream(handler);
    try {
      sendCarrierStart(ws, "MZ-shutdown", call.providerCallId);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      const closed = waitForClose(ws);
      let settled = false;
      const closing = handler.close(barrier.promise);
      void closing.then(() => {
        settled = true;
      });
      expect(handler.close()).toBe(closing);
      const session = handler.issueStreamSession();
      await closed;
      await vi.waitFor(() => expect(closeBridge).toHaveBeenCalledOnce());
      expect(endCall).not.toHaveBeenCalled();
      callbacks?.onTranscript?.("assistant", "Final received answer", true);
      expect(processEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "call.assistant-speech",
          transcript: "Final received answer",
        }),
      );
      disposed.resolve();
      await vi.waitFor(() =>
        expect(endCall).toHaveBeenCalledExactlyOnceWith(call.callId, { reason: "completed" }),
      );
      const recorded = processEvent.mock.calls.length;
      callbacks?.onTranscript?.("assistant", "Late after disposal", true);
      expect(processEvent).toHaveBeenCalledTimes(recorded);
      expect(settled).toBe(false);
      barrier.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      termination.resolve({ success: true });
      await closing;
      expect(settled).toBe(true);
      const server = await startUpgradeWsServer({
        urlPath: new URL(session.streamUrl).pathname,
        onUpgrade: (request, socket, head) => handler.handleWebSocketUpgrade(request, socket, head),
      });
      try {
        await expect(connectWs(server.url)).rejects.toThrow("Unexpected server response: 401");
      } finally {
        await server.close();
      }
    } finally {
      disposed.resolve();
      barrier.resolve();
      termination.resolve({ success: true });
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
    expect(processEvent.mock.calls.filter(([event]) => event.type === "call.ended")).toHaveLength(
      0,
    );
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
    expect(processEvent.mock.calls.filter(([event]) => event.type === "call.ended")).toHaveLength(
      0,
    );
    expect(replacement.ws.readyState).toBe(WebSocket.OPEN);
    expect(handler.speak(call.callId, "replacement remains connected")).toEqual({
      success: true,
    });
    expect(replacementGreeting).toHaveBeenCalledWith("replacement remains connected");
  });

  it("ends an idle realtime call after the media inactivity grace", async () => {
    const bridgeStarted = createDeferred<void>();
    const closeBridge = vi.fn();
    const { call, handler, endCall, processEvent } = createCarrierLifecycleHarness(() => {
      bridgeStarted.resolve();
      return createBridge(closeBridge);
    });
    const { ws } = await connectCarrierStream(handler);

    try {
      vi.useFakeTimers();
      sendCarrierStart(ws, "MZ-inactivity", call.providerCallId);
      await bridgeStarted.promise;

      await vi.advanceTimersByTimeAsync(30_000);
      expect(processEvent.mock.calls.filter(([event]) => event.type === "call.ended")).toHaveLength(
        0,
      );
      await vi.advanceTimersByTimeAsync(1_999);
      expect(processEvent.mock.calls.filter(([event]) => event.type === "call.ended")).toHaveLength(
        0,
      );
      await vi.advanceTimersByTimeAsync(1);

      expect(closeBridge).toHaveBeenCalledOnce();
      expect(endCall).toHaveBeenCalledExactlyOnceWith(call.callId, { reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a bridge closed during creation and discards late transcripts", async () => {
    const reason = "completed";
    let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
    const bridgeConnect = vi.fn(async () => {});
    const bridgeClose = vi.fn();
    const createBridgeForCall = vi.fn((request: RealtimeVoiceBridgeCreateRequest) => {
      callbacks = request;
      request.onClose?.(reason);
      return createBridge(bridgeClose, { connect: bridgeConnect });
    });
    const { call, handler, endCall, processEvent } =
      createCarrierLifecycleHarness(createBridgeForCall);
    const { ws } = await connectCarrierStream(handler);

    const closed = waitForClose(ws);
    sendCarrierStart(ws, "MZ-synchronous-close", call.providerCallId);
    expect((await closed).code).toBe(1000);
    callbacks?.onTranscript?.("user", "Still listening", true);
    expect(processEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "call.speech" }));
    await vi.waitFor(() =>
      expect(endCall).toHaveBeenCalledExactlyOnceWith(call.callId, { reason }),
    );
    expect(bridgeConnect).not.toHaveBeenCalled();
    expect(bridgeClose).toHaveBeenCalledOnce();
    expect(handler.speak(call.callId, "Do not revive this call")).toEqual({
      success: false,
      error: "No active realtime bridge for call",
    });
  });

  it("does not start a native consult after teardown during transcript settling", async () => {
    let onToolCall: RealtimeVoiceBridgeCreateRequest["onToolCall"];
    let onTranscript: RealtimeVoiceBridgeCreateRequest["onTranscript"];
    const submitToolResult = vi.fn();
    const createBridgeForCall = vi.fn((request: RealtimeVoiceBridgeCreateRequest) => {
      onToolCall = request.onToolCall;
      onTranscript = request.onTranscript;
      return createBridge(vi.fn(), {
        supportsToolResultContinuation: true,
        submitToolResult,
      });
    });
    const { call, handler } = createCarrierLifecycleHarness(createBridgeForCall);
    const consult = vi.fn(async () => ({ text: "This should not run." }));
    handler.registerToolHandler("openclaw_agent_consult", consult);
    const { ws } = await connectCarrierStream(handler);

    sendCarrierStart(ws, "MZ-settling-consult", call.providerCallId);
    await vi.waitFor(() => expect(createBridgeForCall).toHaveBeenCalledTimes(1));

    onTranscript?.("user", "Check the deployment", false);
    onToolCall?.({
      itemId: "item-settling-consult",
      callId: "tool-settling-consult",
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
      expect(submitToolResult).toHaveBeenCalledTimes(1);
      expect(consult).not.toHaveBeenCalled();
    });

    const closed = waitForClose(ws);
    ws.close();
    await closed;
    await vi.waitFor(() => expect(consults.size).toBe(0));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 400);
    });

    expect(consult).not.toHaveBeenCalled();
    expect(submitToolResult).toHaveBeenCalledTimes(1);
  });

  it("aborts a hung native consult during stream teardown", async () => {
    let onToolCall: RealtimeVoiceBridgeCreateRequest["onToolCall"];
    let consultSignal: AbortSignal | undefined;
    const submitToolResult = vi.fn();
    const createBridgeForCall = vi.fn((request: RealtimeVoiceBridgeCreateRequest) => {
      onToolCall = request.onToolCall;
      return createBridge(vi.fn(), {
        supportsToolResultContinuation: true,
        submitToolResult,
      });
    });
    const { call, handler } = createCarrierLifecycleHarness(createBridgeForCall);
    handler.registerToolHandler("openclaw_agent_consult", async (_args, _callId, context) => {
      consultSignal = context.abortSignal;
      return await new Promise<unknown>((_resolve, reject) => {
        context.abortSignal?.addEventListener(
          "abort",
          () => reject(new Error("native consult aborted", { cause: context.abortSignal?.reason })),
          { once: true },
        );
      });
    });
    const { ws } = await connectCarrierStream(handler);

    sendCarrierStart(ws, "MZ-consult", call.providerCallId);
    await vi.waitFor(() => expect(createBridgeForCall).toHaveBeenCalledTimes(1));

    onToolCall?.({
      itemId: "item-consult",
      callId: "tool-consult",
      name: "openclaw_agent_consult",
      args: { question: "Check the deployment." },
    });
    await vi.waitFor(() => expect(consultSignal).toBeDefined());

    const consults = (
      handler as unknown as {
        nativeConsultsInFlightByCallId: Map<string, unknown>;
      }
    ).nativeConsultsInFlightByCallId;
    expect(consults.size).toBe(1);

    const closed = waitForClose(ws);
    ws.close();
    await closed;
    await vi.waitFor(() => expect(consults.size).toBe(0));

    expect(consultSignal?.aborted).toBe(true);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(submitToolResult).toHaveBeenCalledTimes(1);
  });

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
      let request: RealtimeVoiceBridgeCreateRequest | undefined;
      const connect = vi.fn(async () => {});
      const submitToolResult = vi.fn();
      const provider = makeRealtimeProvider((params) => {
        request = params;
        return createBridge(() => {}, {
          connect,
          submitToolResult,
          outputAudioMode: "continuous",
          handlesInputAudioBargeIn: true,
        });
      });
      const capabilities = {
        transports: ["gateway-relay" as const],
        inputAudioFormats: [],
        outputAudioFormats: [],
        handlesAgentConsult: true,
        supportsBargeIn: false,
        handlesInputAudioBargeIn: true,
      };
      const harness = createCarrierLifecycleHarness(provider.createBridge, {
        ...(outcome === "disabled" ? { toolPolicy: "none" as const } : {}),
        resolveCallRegistration: () => ({
          agentId: "main",
          instructions: "Help the caller.",
          provider,
          providerConfig: {},
          capabilities,
        }),
      });
      let admittedSignal: AbortSignal | undefined;
      const pending = createDeferred<void>();
      const effects: string[] = [];
      harness.handler.registerToolHandler(
        "openclaw_agent_consult",
        async (args, callId, context) => {
          expect(args).toEqual({ question: "Read my itinerary" });
          expect(callId).toBe(harness.call.callId);
          admittedSignal = context.abortSignal;
          await pending.promise;
          context.abortSignal?.throwIfAborted();
          effects.push("itinerary-read");
          return { text: "The train leaves at noon." };
        },
      );
      const { ws } = await connectCarrierStream(harness.handler);
      const controller = new AbortController();
      try {
        sendCarrierStart(ws, "MZ-live", "CA-startup");
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
          await harness.handler.close();
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
        await harness.handler.close();
        await expect(request.runAgentConsult({ prompt: "Late work" })).rejects.toThrow(
          /closed|active/,
        );
        expect(effects).toHaveLength(outcome === "complete" ? 1 : 0);
      } finally {
        pending.resolve();
      }
    },
  );

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
      const { ws } = await connectCarrierStream(handler);
      let closing: Promise<void> | undefined;
      try {
        sendCarrierStart(ws, "MZ-early-failure", call.providerCallId);
        await vi.waitFor(() => expect(callbacks).toBeDefined());
        processEvent.mockImplementation(async (event) =>
          event.type === "call.assistant-speech" ? persisted.promise : { kind: "processed" },
        );
        const closed = waitForClose(ws);
        closing = handler.close(barrier.promise);
        let settled = false;
        const completion = closing
          .catch((error: unknown) => error)
          .finally(() => {
            settled = true;
          });
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
      }
    },
  );

  it("assigns unique event IDs to finalized chunks received in the same millisecond", async () => {
    let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
    const { call, handler, processEvent } = createCarrierLifecycleHarness((request) => {
      callbacks = request;
      return createBridge(() => {});
    });
    const { ws } = await connectCarrierStream(handler);
    sendCarrierStart(ws, "MZ-transcript-ids", call.providerCallId);
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
  });

  it("waits for provider transcript durability before ending the call", async () => {
    const disposed = createDeferred<void>();
    const persisted = createDeferred<Awaited<ReturnType<CallManager["processEvent"]>>>();
    const providerClose = vi.fn(() => disposed.promise);
    let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
    const { call, handler, endCall, processEvent } = createCarrierLifecycleHarness((request) => {
      callbacks = request;
      return createBridge(providerClose);
    });
    const { ws } = await connectCarrierStream(handler);
    let closing: Promise<void> | undefined;
    try {
      sendCarrierStart(ws, "MZ-durable-final", call.providerCallId);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      processEvent.mockImplementation(async (event) =>
        event.type === "call.assistant-speech" ? persisted.promise : { kind: "processed" },
      );
      const closed = waitForClose(ws);
      callbacks?.onTranscript?.("assistant", "Final received answer", true);
      callbacks?.onClose?.("completed");
      closing = handler.close();
      let settled = false;
      const completion = closing
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await closed;
      await vi.waitFor(() => expect(providerClose).toHaveBeenCalledOnce());
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
      persisted.resolve({ kind: "processed" });
      expect(await completion).toBeUndefined();
      expect(endCall).toHaveBeenCalledExactlyOnceWith(call.callId, { reason: "completed" });
      expect(providerClose).toHaveBeenCalledOnce();
    } finally {
      disposed.resolve();
      persisted.resolve({ kind: "processed" });
      await closing?.catch(() => undefined);
    }
  });
});
