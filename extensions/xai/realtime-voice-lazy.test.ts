import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  capabilityHost,
  createLazyVoiceBridge,
  createVoiceRequest,
  loadLazyProviders,
  runtimeMocks as mocks,
} from "./lazy-capability-providers.test-support.js";

function captureVoiceInput() {
  const forwarded: unknown[][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      forwarded.push([name, ...args]);
    };
  mocks.voiceSendAudio.mockImplementation(record("audio"));
  mocks.voiceSetMediaTimestamp.mockImplementation(record("timestamp"));
  mocks.voiceSendUserMessage.mockImplementation(record("user"));
  mocks.voiceSubmitToolResult.mockImplementation(record("tool"));
  mocks.voiceTriggerGreeting.mockImplementation(record("greeting"));
  return forwarded;
}

function expectNoCalls(...callbacks: Array<ReturnType<typeof vi.fn>>) {
  expect(callbacks.map((callback) => callback.mock.calls)).toEqual(callbacks.map(() => []));
}

async function observedVoice(
  name: "onError" | "onClose",
  overrides: Parameters<typeof createLazyVoiceBridge>[0] = {},
) {
  const callback = vi.fn();
  const bridge = await createLazyVoiceBridge({ [name]: callback, ...overrides });
  return { bridge, callback };
}

function defer(mock: ReturnType<typeof vi.fn>) {
  const pending = createDeferred<void>();
  mock.mockReturnValueOnce(pending.promise);
  return pending;
}

function expectToolResult(id: string, result: unknown) {
  expect(mocks.voiceSubmitToolResult).toHaveBeenCalledExactlyOnceWith(id, result, undefined);
}

function expectCalls(expected: Record<string, unknown[][]>) {
  const calls = Object.fromEntries(
    Object.entries(mocks).map(([name, mock]) => [name, mock.mock.calls]),
  );
  expect(calls).toEqual(expect.objectContaining(expected));
}

const overflow = (kind: "user message" | "tool result") =>
  new Error(`xAI realtime voice pending ${kind} overflow during lazy startup`);

describe("xAI lazy realtime voice", () => {
  it("preserves voice startup ordering and waits to trigger the greeting", async () => {
    const connecting = defer(mocks.voiceConnect);
    const forwarded = captureVoiceInput();
    const bridge = await createLazyVoiceBridge();
    const first = Buffer.from([0x01]);
    const second = Buffer.from([0x02]);

    bridge.sendAudio(first);
    bridge.setMediaTimestamp(42);
    bridge.sendUserMessage?.("hello");
    await bridge.submitToolResult("call-1", { ok: true });
    bridge.triggerGreeting?.("welcome");
    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(mocks.voiceConnect).toHaveBeenCalledOnce());
    bridge.sendAudio(second);

    expect(forwarded).toEqual([]);

    connecting.resolve();
    await connectPromise;
    expect(forwarded).toEqual([
      ["audio", first],
      ["timestamp", 42],
      ["user", "hello"],
      ["tool", "call-1", { ok: true }, undefined],
      ["greeting", "welcome"],
      ["audio", second],
    ]);
  });

  it("moves the latest pending timestamp and greeting to the operation tail", async () => {
    const forwarded = captureVoiceInput();
    const bridge = await createLazyVoiceBridge();

    bridge.setMediaTimestamp(1);
    bridge.sendUserMessage?.("middle");
    bridge.setMediaTimestamp(2);
    bridge.triggerGreeting?.("superseded");
    bridge.sendAudio(Buffer.from([0x03]));
    bridge.triggerGreeting?.();
    await bridge.connect();

    expect(forwarded).toEqual([
      ["user", "middle"],
      ["timestamp", 2],
      ["audio", Buffer.from([3])],
      ["greeting", undefined],
    ]);

    mocks.voiceTriggerGreeting.mockClear();
    mocks.voiceIsConnected.mockReturnValue(false);
    bridge.triggerGreeting?.("provider-owned-reconnect");
    expect(mocks.voiceTriggerGreeting).toHaveBeenCalledWith("provider-owned-reconnect");
  });

  it.each([
    ["undefined", (): undefined => undefined],
    ["bigint", () => ({ value: 1n })],
  ] as const)(
    "rejects %s voice tool results before lazy queue admission",
    async (_label, create) => {
      const { bridge, callback: onError } = await observedVoice("onError");

      expect(() => bridge.submitToolResult("call-1", create())).toThrow(/serializ/i);
      expect(onError).toHaveBeenCalledOnce();

      await bridge.submitToolResult("call-1", { recovered: true });
      await bridge.connect();

      expectToolResult("call-1", { recovered: true });
    },
  );

  it("snapshots lazy voice tool results with one canonical serialization", async () => {
    const bridge = await createLazyVoiceBridge();
    const toJSON = vi.fn((key: string) => ({ key, ok: true }));

    await bridge.submitToolResult("call-1", { toJSON });
    await bridge.connect();

    expect(toJSON).toHaveBeenCalledExactlyOnceWith("");
    expectToolResult("call-1", { key: "", ok: true });
  });

  it("ignores unsupported interim voice results before lazy queue admission", async () => {
    const { bridge, callback: onError } = await observedVoice("onError");

    expect(() =>
      bridge.submitToolResult("call-1", undefined, { willContinue: true }),
    ).not.toThrow();
    await bridge.connect();

    expect(onError).not.toHaveBeenCalled();
    expect(mocks.voiceSubmitToolResult).not.toHaveBeenCalled();
  });

  it.each(["connecting", "submitting"] as const)(
    "keeps pending voice payloads byte-bounded while %s",
    async (phase) => {
      const waitingFor = phase === "connecting" ? mocks.voiceConnect : mocks.voiceSubmitToolResult;
      const blocked = defer(waitingFor);
      const { bridge, callback: onError } = await observedVoice("onError");
      const acceptedMessage = "a".repeat(200 * 1024);
      const acceptedResult = { text: "b".repeat(200 * 1024) };
      if (phase === "submitting") {
        await bridge.submitToolResult("call-1", acceptedResult);
      }
      const connectPromise = bridge.connect();
      await vi.waitFor(() => expect(waitingFor).toHaveBeenCalledOnce());
      if (phase === "connecting") {
        bridge.sendUserMessage?.(acceptedMessage);
        bridge.sendUserMessage?.("c".repeat(64 * 1024));
        await bridge.submitToolResult("call-1", acceptedResult);
        expectNoCalls(mocks.voiceSendUserMessage, mocks.voiceSubmitToolResult);
      } else {
        expect(mocks.voiceSubmitToolResult).toHaveBeenCalledOnce();
      }
      expect(() => bridge.submitToolResult("call-2", { text: "d".repeat(64 * 1024) })).toThrow(
        overflow("tool result"),
      );
      expect(onError.mock.calls).toEqual([
        ...(phase === "connecting" ? [[overflow("user message")]] : []),
        [overflow("tool result")],
      ]);
      blocked.resolve();
      await connectPromise;
      if (phase === "connecting") {
        expect(mocks.voiceSendUserMessage).toHaveBeenCalledExactlyOnceWith(acceptedMessage);
      }
      expectToolResult("call-1", acceptedResult);
    },
  );

  it("drains voice input queued while an earlier tool result is submitting", async () => {
    const submitting = createDeferred<void>();
    const forwarded = captureVoiceInput();
    mocks.voiceSubmitToolResult.mockImplementationOnce((...args: unknown[]) => {
      forwarded.push(["tool", ...args]);
      return submitting.promise;
    });
    const bridge = await createLazyVoiceBridge();

    await bridge.submitToolResult("call-1", { text: "first" });
    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(mocks.voiceSubmitToolResult).toHaveBeenCalledOnce());
    bridge.sendUserMessage?.("arrived-during-flush");
    bridge.setMediaTimestamp(84);
    await bridge.submitToolResult("call-2", { text: "second" });
    submitting.resolve();
    await connectPromise;

    expect(forwarded).toEqual([
      ["tool", "call-1", { text: "first" }, undefined],
      ["user", "arrived-during-flush"],
      ["timestamp", 84],
      ["tool", "call-2", { text: "second" }, undefined],
    ]);
  });

  it("forwards all voice input admitted during the final connect handoff exactly once", async () => {
    const connecting = defer(mocks.voiceConnect);
    mocks.voiceIsConnected.mockReturnValue(true);
    const bridge = await createLazyVoiceBridge();
    const audio = Buffer.from([0x01]);

    const firstConnect = bridge.connect();
    const secondConnect = bridge.connect();
    await vi.waitFor(() => expect(mocks.voiceConnect).toHaveBeenCalledOnce());
    connecting.resolve();
    queueMicrotask(() => {
      bridge.sendAudio(audio);
      bridge.setMediaTimestamp(84);
      bridge.sendUserMessage?.("arrived-during-handoff");
      void bridge.submitToolResult("call-1", { text: "tool-result" });
      bridge.triggerGreeting?.("welcome");
    });
    await Promise.all([firstConnect, secondConnect]);

    expectCalls({
      voiceSendAudio: [[audio]],
      voiceSetMediaTimestamp: [[84]],
      voiceSendUserMessage: [["arrived-during-handoff"]],
      voiceSubmitToolResult: [["call-1", { text: "tool-result" }, undefined]],
      voiceTriggerGreeting: [["welcome"]],
    });
  });

  it("keeps a replacement voice generation open when a superseded connect rejects", async () => {
    const failure = new Error("superseded voice connect rejected");
    const firstConnect = createDeferred<void>();
    mocks.voiceConnect.mockReturnValueOnce(firstConnect.promise).mockResolvedValueOnce(undefined);
    const onError = vi.fn();
    const onClose = vi.fn();
    const bridge = await createLazyVoiceBridge({ onError, onClose });

    const staleConnect = bridge.connect();
    const staleConnectResult = expect(staleConnect).rejects.toBe(failure);
    await vi.waitFor(() => expect(mocks.voiceConnect).toHaveBeenCalledOnce());
    const staleRequest = mocks.createVoiceBridge.mock.calls[0]?.[0];
    void bridge.close();
    await bridge.connect();
    staleRequest?.onClose?.("error");
    bridge.sendUserMessage?.("replacement-still-open");
    firstConnect.reject(failure);
    await staleConnectResult;

    expect(mocks.voiceConnect).toHaveBeenCalledTimes(2);
    expect(mocks.createVoiceBridge).toHaveBeenCalledTimes(2);
    expect(mocks.voiceClose).toHaveBeenCalledOnce();
    expect(mocks.voiceSendUserMessage).toHaveBeenCalledWith("replacement-still-open");
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledExactlyOnceWith("completed");
  });

  it("ignores nonterminal callbacks from a superseded voice generation", async () => {
    const playback = [{ itemId: "current-item", audioEndMs: 320 }];
    const callbacks = {
      onAudio: vi.fn(),
      getPlaybackState: vi.fn(() => playback),
      onClearAudio: vi.fn(),
      onMark: vi.fn(),
      onTranscript: vi.fn(),
      onEvent: vi.fn(),
      onToolCall: vi.fn(),
      onReady: vi.fn(),
      onError: vi.fn(),
    };
    const bridge = await createLazyVoiceBridge(callbacks);

    await bridge.connect();
    const staleRequest = mocks.createVoiceBridge.mock.calls[0]?.[0];
    void bridge.close();
    await bridge.connect();
    const currentRequest = mocks.createVoiceBridge.mock.calls[1]?.[0];
    const audio = Buffer.from([0x02]);
    const error = new Error("callback error");
    const event = { direction: "server" as const, type: "probe" };
    const toolCall = { itemId: "item", callId: "call", name: "tool", args: {} };
    const emit = (request: typeof currentRequest) => {
      request?.onAudio(audio, { itemId: "item" });
      request?.onClearAudio("barge-in");
      request?.onMark?.("mark");
      request?.onTranscript?.("assistant", "text", true);
      request?.onEvent?.(event);
      request?.onToolCall?.(toolCall);
      request?.onReady?.();
      request?.onError?.(error);
      return request?.getPlaybackState?.();
    };
    expect(emit(staleRequest)).toEqual([]);
    expectNoCalls(...Object.values(callbacks));

    expect(emit(currentRequest)).toEqual(playback);
    expect(callbacks.onAudio).toHaveBeenCalledWith(audio, { itemId: "item" });
    expect(callbacks.onClearAudio).toHaveBeenCalledWith("barge-in");
    expect(callbacks.onMark).toHaveBeenCalledWith("mark");
    expect(callbacks.onTranscript).toHaveBeenCalledWith("assistant", "text", true);
    expect(callbacks.onEvent).toHaveBeenCalledWith(event);
    expect(callbacks.onToolCall).toHaveBeenCalledWith(toolCall);
    expect(callbacks.onReady).toHaveBeenCalledOnce();
    expect(callbacks.onError).toHaveBeenCalledWith(error);
  });

  it.each(["sync", "resolve", "reject"])(
    "drains %s connect-failure disposal before reentrant terminal notification",
    async (cleanup) => {
      const failure = new Error("provider connect rejected");
      const cleanupFailure = new Error("provider cleanup rejected");
      const disposed = createDeferred<void>();
      mocks.voiceConnect.mockRejectedValueOnce(failure);
      let collectorSealed = false;
      const callbackOrder: string[] = [];
      const callbacks = {
        onTranscript: vi.fn((_role: unknown, text: string) => {
          if (!collectorSealed) {
            callbackOrder.push(text);
          }
        }),
        onAudio: vi.fn(),
        onToolCall: vi.fn(),
      };
      const observerCloses: Promise<unknown>[] = [];
      const observer = (value: unknown) => {
        callbackOrder.push(value instanceof Error ? "error" : "close");
        observerCloses.push(
          Promise.resolve(bridge.close())
            .catch(() => undefined)
            .then(() => {
              collectorSealed = true;
            }),
        );
        throw new Error("terminal observer rejected");
      };
      const onError = vi.fn(observer);
      const onClose = vi.fn(observer);
      const bridge = await createLazyVoiceBridge({ onError, onClose, ...callbacks });
      const emitTail = () => {
        const request = mocks.createVoiceBridge.mock.calls[0]?.[0];
        request?.onTranscript?.("assistant", "partial tail", false);
        request?.onAudio(Buffer.from([0x01]));
        request?.onToolCall?.({ itemId: "item", callId: "call", name: "probe", args: {} });
        request?.onTranscript?.("assistant", "final tail", true);
      };
      mocks.voiceClose.mockImplementationOnce(() => {
        if (cleanup === "sync") {
          emitTail();
          throw cleanupFailure;
        }
        return disposed.promise;
      });
      const failedConnect = expect(bridge.connect()).rejects.toBe(failure);
      try {
        await vi.waitFor(() => expect(mocks.voiceClose).toHaveBeenCalledOnce());
        if (cleanup !== "sync") {
          expect(onClose).not.toHaveBeenCalled();
          emitTail();
        }
        expectNoCalls(callbacks.onAudio, callbacks.onToolCall);
        if (cleanup === "reject") {
          disposed.reject(cleanupFailure);
        } else {
          disposed.resolve();
        }
        await failedConnect;
        expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
        expect(onClose).toHaveBeenCalledExactlyOnceWith("error");
        expect(callbackOrder).toEqual(["final tail", "error", "close"]);
        bridge.sendAudio(Buffer.from([0x01]));
        expect(mocks.voiceSendAudio).not.toHaveBeenCalled();
      } finally {
        disposed.resolve();
        await failedConnect;
        await Promise.all(observerCloses);
      }
    },
  );

  it("reopens voice only after an explicit connect following provider termination", async () => {
    const { bridge, callback: onClose } = await observedVoice("onClose");
    const discarded = Buffer.from([0x01]);
    const accepted = Buffer.from([0x02]);

    await bridge.connect();
    const loadedRequest = mocks.createVoiceBridge.mock.calls[0]?.[0];
    loadedRequest?.onClose?.("error");
    bridge.sendAudio(discarded);

    const reconnectPromise = bridge.connect();
    bridge.sendAudio(accepted);
    await reconnectPromise;

    expect(mocks.voiceConnect).toHaveBeenCalledTimes(2);
    expect(mocks.voiceSendAudio).toHaveBeenCalledExactlyOnceWith(accepted);
    expect(onClose).toHaveBeenCalledExactlyOnceWith("error");
  });

  it("reports explicit voice close once when the provider also reports completion", async () => {
    const { bridge, callback: onClose } = await observedVoice("onClose");

    await bridge.connect();
    const loadedRequest = mocks.createVoiceBridge.mock.calls[0]?.[0];
    mocks.voiceClose.mockImplementation(() => loadedRequest?.onClose?.("completed"));
    void bridge.close();
    void bridge.close();

    expect(mocks.voiceClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledExactlyOnceWith("completed");
  });

  it.each([
    { reconnect: true, closeAt: "connected" },
    { reconnect: false, closeAt: "loading" },
    { reconnect: true, closeAt: "construction" },
    { reconnect: true, closeAt: "provider-terminal" },
  ] as const)(
    "joins disposal and final transcripts (reconnect=$reconnect, closeAt=$closeAt)",
    async ({ reconnect, closeAt }) => {
      const disposed = createDeferred<void>();
      const ready = createDeferred<void>();
      const createBridge = mocks.createVoiceBridge.getMockImplementation();
      if (!createBridge) {
        throw new Error("The voice fixture has no bridge factory");
      }
      const firstConnect = vi.fn(async () => {});
      const firstClose = vi.fn(() => disposed.promise);
      const replacementConnect = vi.fn(() => ready.promise);
      const onTranscript = vi.fn();
      const { bridge, callback: onClose } = await observedVoice("onClose", { onTranscript });
      const providerTerminated = closeAt === "provider-terminal";
      const constructing = closeAt === "construction" || providerTerminated;
      const earlyReconnect = constructing && reconnect;
      let closing: void | Promise<void> = undefined;
      let reconnecting: Promise<void> | undefined;
      mocks.createVoiceBridge
        .mockImplementationOnce((request) => {
          if (constructing) {
            if (providerTerminated) {
              request.onClose?.("error");
            } else {
              closing = bridge.close();
            }
            expect(firstClose).not.toHaveBeenCalled();
            if (reconnect) {
              reconnecting = bridge.connect();
            }
          }
          return { ...createBridge(request), connect: firstConnect, close: firstClose };
        })
        .mockImplementationOnce((request) => ({
          ...createBridge(request),
          connect: replacementConnect,
        }));
      const connecting = bridge.connect();
      if (closeAt === "connected") {
        await connecting;
      }
      if (!constructing) {
        closing = bridge.close();
      }
      if (providerTerminated) {
        closing = connecting;
      }
      try {
        await vi.waitFor(() => expect(firstClose).toHaveBeenCalledOnce());
        if (!earlyReconnect) {
          expect(bridge.close()).toBe(closing);
        }
        const firstRequest = mocks.createVoiceBridge.mock.calls[0]?.[0];
        if (closeAt !== "connected") {
          expect(firstConnect).not.toHaveBeenCalled();
        }
        firstRequest?.onTranscript?.("assistant", "partial tail", false);
        firstRequest?.onTranscript?.("assistant", "final tail", true);
        expect(onTranscript.mock.calls).toEqual(
          earlyReconnect ? [] : [["assistant", "final tail", true]],
        );
        let settled = false;
        const completion = Promise.resolve(closing).then(() => {
          settled = true;
        });
        if (!earlyReconnect) {
          bridge.sendAudio(Buffer.from([0x01]));
        }
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(mocks.voiceSendAudio).not.toHaveBeenCalled();
        expect(onClose.mock.calls).toEqual(providerTerminated ? [["error"]] : []);

        if (reconnect) {
          reconnecting ??= bridge.connect();
          await vi.waitFor(() => expect(replacementConnect).toHaveBeenCalledOnce());
          const joined = bridge.connect();
          ready.resolve();
          await Promise.all([reconnecting, joined]);
          expect(mocks.createVoiceBridge).toHaveBeenCalledTimes(2);
          firstRequest?.onTranscript?.("assistant", "stale after reconnect", true);
        }
        disposed.resolve();
        await Promise.all([completion, connecting]);
        firstRequest?.onTranscript?.("assistant", "late after disposal", true);
        expect(onTranscript).toHaveBeenCalledTimes(earlyReconnect ? 0 : 1);
        expect(firstClose).toHaveBeenCalledOnce();
        if (reconnect) {
          expect(onClose.mock.calls).toEqual(providerTerminated ? [["error"]] : []);
          bridge.sendAudio(Buffer.from([0x02]));
          expect(mocks.voiceSendAudio).toHaveBeenCalledExactlyOnceWith(Buffer.from([0x02]));
          expect(mocks.voiceClose).not.toHaveBeenCalled();
          await bridge.close();
        }
        expect(onClose.mock.calls).toEqual(
          providerTerminated ? [["error"], ["completed"]] : [["completed"]],
        );
      } finally {
        ready.resolve();
        disposed.resolve();
        await Promise.allSettled([closing, connecting, reconnecting]);
        await bridge.close();
      }
    },
  );

  it("keeps realtime voice request validation synchronous", async () => {
    const lazy = await loadLazyProviders();
    const provider = lazy.createLazyXaiRealtimeVoiceProvider(capabilityHost);

    expect(() => provider.createBridge(createVoiceRequest({ autoRespondToAudio: false }))).toThrow(
      "xAI realtime voice requires automatic server-VAD responses",
    );
    expect(mocks.buildVoiceProvider).not.toHaveBeenCalled();
  });
});
