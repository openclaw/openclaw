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
  delegation = false,
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
            capabilities: {
              transports: ["gateway-relay"],
              inputAudioFormats: [],
              outputAudioFormats: [],
              handlesAgentConsult: true,
            },
          }),
        }
      : options,
  );
  const { ws } = await connectCarrierStream(fixture.handler);
  sendCarrierStart(ws, "MZ-test", fixture.call.providerCallId);
  await vi.waitFor(() => expect(createBridgeForCall).toHaveBeenCalledOnce());
  return { ...fixture, ws, callbacks: await ready.promise };
}

function invokeConsult(request: RealtimeVoiceBridgeCreateRequest, id: string, args: unknown) {
  request.onToolCall?.({ itemId: `item-${id}`, callId: id, name: "openclaw_agent_consult", args });
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
    const persistence = defer<ProcessResult>({ kind: "processed" });
    const createBridgeForCall = vi.fn<RealtimeVoiceProviderPlugin["createBridge"]>(() =>
      createBridge(() => {}),
    );
    const { call, handler, processEvent, endCall } =
      createCarrierLifecycleHarness(createBridgeForCall);
    processEvent.mockReturnValueOnce(persistence.promise);
    const { ws } = await connectCarrierStream(handler);
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
  });

  it("warns and removes a stream token when the provider never connects", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handler } = createCarrierLifecycleHarness(() => createBridge(vi.fn()));

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
  });

  it.each(["registration", "creation", "close callback", "close throws"] as const)(
    "settles failed startup through the manager (%s)",
    async (stage) => {
      const unavailable = { success: false, error: "carrier unavailable" };
      const termination = defer(unavailable);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const close = vi.fn();
      const create = vi.fn<RealtimeVoiceProviderPlugin["createBridge"]>((request) => {
        if (stage === "creation") {
          throw new Error("provider rejected configuration");
        }
        close.mockImplementation(() => {
          if (stage === "close throws") {
            throw new Error("realtime provider close failed");
          }
          request.onClose?.("error");
        });
        return createBridge(close, {
          connect: async () => {
            throw new Error("provider rejected startup");
          },
        });
      });
      const registration = vi.fn(() => {
        throw new Error("routed agent unavailable");
      });
      const { call, handler, processEvent, endCall } = createCarrierLifecycleHarness(create, {
        initialMessage: "Hello from the routed agent.",
        ...(stage === "creation" ? { endCall: () => termination.promise } : {}),
        ...(stage === "registration" ? { resolveCallRegistration: registration } : {}),
      });
      const { ws } = await connectCarrierStream(handler);
      const closed = waitForClose(ws);
      sendCarrierStart(ws, "MZ-failed-startup", call.providerCallId);
      const outcome = await closed;
      expect(outcome.code).toBe(1011);
      expect(endCall).toHaveBeenCalledExactlyOnceWith(call.callId, { reason: "error" });
      expect(handler.speak(call.callId, "still connected")).toEqual({
        success: false,
        error: "No active realtime bridge for call",
      });
      if (stage === "creation") {
        expect(endedEvents(processEvent)).toHaveLength(0);
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("carrier unavailable"));
        termination.resolve(unavailable);
        await vi.waitFor(() =>
          expect(warn).toHaveBeenCalledWith(expect.stringContaining("carrier unavailable")),
        );
        expect(endedEvents(processEvent)).toHaveLength(0);
        expect(call.state).toBe("ringing");
      } else if (stage === "registration") {
        expect(registration).toHaveBeenCalledExactlyOnceWith(call);
        expect(create).not.toHaveBeenCalled();
        expect(processEvent.mock.calls.map(([event]) => event.type)).toEqual([
          "call.initiated",
          "call.ended",
        ]);
        expect(call.metadata?.initialMessage).toBe("Hello from the routed agent.");
      } else {
        expect(outcome.reason).toBe(
          stage === "close throws" ? "Failed to connect" : "Bridge disconnected",
        );
        await handler.close();
        expect(close).toHaveBeenCalledOnce();
        expect(
          warn.mock.calls.filter(([message]) =>
            String(message).includes("realtime provider close failed"),
          ),
        ).toHaveLength(stage === "close throws" ? 1 : 0);
      }
    },
  );

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
    const { ws: predecessor } = await connectCarrierStream(handler);
    sendCarrierStart(predecessor, "MZ-predecessor", call.providerCallId);
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
    expect(predecessor.readyState).toBe(WebSocket.OPEN);
    expect(handler.speak(call.callId, "predecessor remains connected")).toEqual({
      success: true,
    });
    expect(predecessorGreeting).toHaveBeenCalledWith("predecessor remains connected");
  });

  it("does not hang up a replacement when its stale predecessor rejects startup", async () => {
    const pendingStartup = defer<void>(undefined);
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
    const { ws: previous } = await connectCarrierStream(handler);
    sendCarrierStart(previous, "MZ-previous", call.providerCallId);
    await vi.waitFor(() => expect(createBridgeForCall).toHaveBeenCalledTimes(1));

    const { ws: replacement } = await connectCarrierStream(handler);
    sendCarrierStart(replacement, "MZ-replacement", call.providerCallId);
    await vi.waitFor(() => expect(createBridgeForCall).toHaveBeenCalledTimes(2));

    const previousClosed = waitForClose(previous);
    pendingStartup.reject(new Error("superseded provider rejected startup"));
    expect((await previousClosed).code).toBe(1011);
    expect(endCall).not.toHaveBeenCalled();
    expect(endedEvents(processEvent)).toHaveLength(0);
    expect(replacement.readyState).toBe(WebSocket.OPEN);
    expect(handler.speak(call.callId, "replacement remains connected")).toEqual({
      success: true,
    });
    expect(replacementGreeting).toHaveBeenCalledWith("replacement remains connected");
  });

  it("ends the call after inactivity following media renewal", async () => {
    const bridgeStarted = defer<void>(undefined);
    const mediaReceived = defer<void>(undefined);
    const sendAudio = vi.fn(() => mediaReceived.resolve());
    const closeBridge = vi.fn();
    const { call, handler, endCall, processEvent } = createCarrierLifecycleHarness(() => {
      bridgeStarted.resolve();
      return createBridge(closeBridge, { sendAudio });
    });
    const { ws } = await connectCarrierStream(handler);

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
  });

  it.each(["settling", "running"] as const)(
    "cancels a %s native consult during stream teardown",
    async (phase) => {
      let consultSignal: AbortSignal | undefined;
      const submitToolResult = vi.fn();
      const { handler, ws, callbacks } = await openBridge(vi.fn(), {
        supportsToolResultContinuation: true,
        submitToolResult,
      });
      const consult = vi.fn<ToolHandler>(async (_args, _callId, context) => {
        if (phase === "settling") {
          return { text: "Must not run" };
        }
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
      invokeConsult(callbacks, "tool-consult", { question: "Check the deployment." });
      const consults = (
        handler as unknown as { nativeConsultsInFlightByCallId: Map<string, unknown> }
      ).nativeConsultsInFlightByCallId;
      await vi.waitFor(() => {
        expect(consults.size).toBe(1);
        if (phase === "settling") {
          expect(submitToolResult).toHaveBeenCalledOnce();
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
    const firstPersistence = defer<ProcessResult>({ kind: "processed" });
    const secondPersistence = defer<ProcessResult>({ kind: "processed" });
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

    sendCarrierStart(first.ws, "MZ-concurrent-first", call.providerCallId);
    const audio = Buffer.from([0xff, 0xfe, 0xfd]);
    first.ws.send(JSON.stringify({ event: "media", media: { payload: audio.toString("base64") } }));
    await vi.waitFor(() => expect(answered).toBe(1));
    const second = await connectCarrierStream(handler);
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
        },
        outcome === "disabled" ? { toolPolicy: "none" } : {},
        true,
      );
      let admittedSignal: AbortSignal | undefined;
      const pending = defer<void>(undefined);
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
      await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
      if (!request?.runAgentConsult) {
        throw new Error("Native delegation was not wired to the carrier session");
      }
      expect(request.tools).toEqual([]);
      const result = request.runAgentConsult({
        prompt: "Read my itinerary",
        signal: controller.signal,
      });
      const settled = result.catch((error: unknown) => error);
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
        expect(await settled).toEqual({ text: "The train leaves at noon." });
        expect(effects).toEqual(["itinerary-read"]);
      } else {
        expect(await settled).toBeInstanceOf(Error);
        expect(admittedSignal?.aborted).toBe(outcome === "disabled" ? undefined : true);
        expect(effects).toEqual([]);
      }
      expect(submitToolResult).not.toHaveBeenCalled();
      await handler.close();
      await expect(request.runAgentConsult({ prompt: "Late work" })).rejects.toThrow(
        /closed|active/,
      );
      expect(effects).toHaveLength(outcome === "complete" ? 1 : 0);
    },
  );

  it.each(["provider", "shutdown", "failed transcript", "manager settlement"] as const)(
    "joins provider disposal, transcript durability and %s",
    async (source) => {
      const disposed = defer<void>(undefined),
        barrier = defer<void>(undefined);
      const persisted = defer<ProcessResult>({ kind: "processed" });
      const termination = defer({ success: true });
      const failure = new Error("transcript cleanup failed");
      const providerClose = vi.fn(() => disposed.promise);
      const managerSettlement = source === "manager settlement";
      const hasBarrier = managerSettlement || source === "failed transcript";
      const { call, handler, endCall, processEvent, ws, callbacks } = await openBridge(
        providerClose,
        {},
        managerSettlement ? { endCall: () => termination.promise } : {},
      );
      if (!managerSettlement) {
        processEvent.mockImplementation(async (event) =>
          event.type === "call.assistant-speech" ? persisted.promise : { kind: "processed" },
        );
      }
      const finalTranscript = () =>
        callbacks.onTranscript?.("assistant", "Final received answer", true);
      const closed = waitForClose(ws);
      if (source === "provider") {
        finalTranscript();
        callbacks.onClose?.("completed");
      }
      const closing = handler.close(hasBarrier ? barrier.promise : undefined);
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
        finalTranscript();
      }
      await vi.waitFor(() =>
        expect(processEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "call.assistant-speech",
            transcript: "Final received answer",
          }),
        ),
      );
      disposed.resolve();
      if (hasBarrier) {
        if (!managerSettlement) {
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
  const first = defer({ text: "Cleanup." });
  const consult = vi
    .fn<ToolHandler>()
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValue(responseB);
  handler.registerToolHandler("openclaw_agent_consult", consult);
  vi.useFakeTimers();
  const finalResults = (id: string) =>
    submit.mock.calls.filter(([callId, , options]) => callId === id && !options?.willContinue);
  return {
    first,
    consult,
    processEvent,
    provider: {
      request,
      submit,
      invoke: (id: string, args: unknown) => invokeConsult(request, id, args),
      finalResults,
      expectFinal: (id: string, result: unknown) => {
        expect(finalResults(id)).toEqual([[id, result, undefined]]);
      },
    },
  };
}

const speechA = "Read the latest report for Dataset A.";
const speechB = "Now check the independent report for Dataset B.";
const responseA = { text: "Answer A." };
const responseB = { text: "Answer B." };

type ProcessResult = Awaited<ReturnType<CallManager["processEvent"]>>;
const releases: Array<() => void> = [];
function defer<T>(fallback: T) {
  const deferred = createDeferred<T>();
  releases.push(() => deferred.resolve(fallback));
  return deferred;
}
afterEach(() => {
  // afterEach runs before the harness's onTestFinished socket/provider joins.
  for (const release of releases.splice(0)) {
    release();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("native realtime consult request identity", () => {
  it.each([
    "working partial",
    "completed ASR",
    "same completed ASR",
    "transcript persistence",
    "empty snapshot",
    "independent repeat",
    "independent extension",
  ] as const)("keeps native invocation identity through %s", async (phase) => {
    const { first, consult, provider, processEvent } = await createConsultFixture();
    const working = defer<void>(undefined);
    const persisted = defer<ProcessResult>({ kind: "processed" });
    const independent = phase.startsWith("independent");
    const empty = phase === "empty snapshot";
    const persistence = phase === "transcript persistence";
    const completedASR = phase.includes("completed ASR");
    if (!independent && !persistence) {
      provider.submit.mockImplementationOnce(() => working.promise);
    }
    if (persistence) {
      processEvent.mockReturnValueOnce(persisted.promise);
    }
    if (!empty) {
      provider.request.onTranscript?.(
        "user",
        completedASR ? "Read the latest report" : speechA,
        independent || persistence,
      );
    }
    provider.invoke("first", { question: empty ? "Dataset A" : "message" });
    await vi.advanceTimersByTimeAsync(0);
    if (completedASR || phase === "working partial") {
      provider.request.onTranscript?.("user", speechA, true);
    }
    const later = independent
      ? phase === "independent repeat"
        ? speechA
        : `${speechA} Include this year's totals.`
      : speechB;
    if (phase !== "same completed ASR") {
      provider.request.onTranscript?.(
        "user",
        later,
        independent || completedASR || phase === "working partial",
      );
    }
    provider.invoke("different", { question: empty ? "Dataset B" : "message" });
    await vi.advanceTimersByTimeAsync(0);
    if (!independent) {
      expect(consult).not.toHaveBeenCalled();
    }
    persisted.resolve({ kind: "processed" });
    await vi.advanceTimersByTimeAsync(0);
    provider.expectFinal(
      "different",
      expect.objectContaining({
        status: "busy",
        started: false,
        retryable: true,
        error: expect.stringMatching(/different request.*not started.*retry/i),
      }),
    );
    expect(provider.submit.mock.calls.filter(([id]) => id === "different")).toHaveLength(1);
    working.resolve();
    await vi.advanceTimersByTimeAsync(350);
    expect(consult).toHaveBeenCalledOnce();
    expect(consult.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ question: empty ? "Dataset A" : speechA }),
    );
    expect(consult.mock.calls[0]?.[2].partialUserTranscript).toBe(empty ? undefined : speechA);
    first.resolve(responseA);
    await vi.advanceTimersByTimeAsync(0);
    provider.expectFinal("first", responseA);
    expect(provider.finalResults("different")).toHaveLength(1);
    provider.invoke("retry", { question: phase === "same completed ASR" ? speechB : "message" });
    await vi.advanceTimersByTimeAsync(350);
    expect(consult).toHaveBeenCalledTimes(2);
    expect(consult.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ question: later }));
    expect(consult.mock.calls[1]?.[2].partialUserTranscript).toBe(
      phase === "same completed ASR" ? undefined : later,
    );
    provider.expectFinal("retry", responseB);
  });

  it("captures native delegation context before transcript persistence yields", async () => {
    const { first, consult, provider, processEvent } = await createConsultFixture(true);
    const delegate = expectDefined(provider.request.runAgentConsult, "native delegation");
    const persisted = defer<ProcessResult>({ kind: "processed" });
    processEvent.mockReturnValueOnce(persisted.promise);
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
    await expect(answerA).resolves.toEqual(responseA);
    const answerB = delegate({ prompt: "message" });
    await vi.advanceTimersByTimeAsync(350);
    await expect(answerB).resolves.toEqual(responseB);
    expect(consult.mock.calls[1]?.[2].partialUserTranscript).toBe(speechB);
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it("lets exact replays keep collecting their own transcript before dispatch", async () => {
    const { consult, provider } = await createConsultFixture();
    consult.mockReset().mockResolvedValue(responseA);
    provider.request.onTranscript?.("user", "Read the latest report", false);
    provider.invoke("first", { question: "message" });
    await vi.advanceTimersByTimeAsync(50);
    provider.request.onTranscript?.("user", "for Dataset A.", false);
    provider.invoke("first", { question: "message" });
    await vi.advanceTimersByTimeAsync(350);
    expect(consult).toHaveBeenCalledOnce();
    expect(consult.mock.calls[0]).toEqual([
      {
        question: speechA,
        context: "Realtime provider supplied a shorter consult question: message",
      },
      "call-startup",
      { partialUserTranscript: speechA, abortSignal: expect.any(AbortSignal) },
    ]);
    expect(provider.finalResults("first")).toHaveLength(2);
  });
});
