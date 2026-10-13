import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  capabilityHost,
  createLazyVoiceBridge,
  createVoiceRequest,
  loadLazyProviders,
  runtimeMocks,
} from "./lazy-capability-providers.test-support.js";

describe("xAI lazy realtime voice", () => {
  it("preserves voice startup ordering and waits to trigger the greeting", async () => {
    const connecting = createDeferred<void>();
    const forwarded: string[] = [];
    runtimeMocks.voiceConnect.mockReturnValue(connecting.promise);
    runtimeMocks.voiceSendAudio.mockImplementation((audio: Buffer) => {
      forwarded.push(`audio:${audio[0]}`);
    });
    runtimeMocks.voiceSetMediaTimestamp.mockImplementation((timestamp: number) => {
      forwarded.push(`timestamp:${timestamp}`);
    });
    runtimeMocks.voiceSendUserMessage.mockImplementation((text: string) => {
      forwarded.push(`user:${text}`);
    });
    runtimeMocks.voiceSubmitToolResult.mockImplementation((callId: string) => {
      forwarded.push(`tool:${callId}`);
    });
    runtimeMocks.voiceTriggerGreeting.mockImplementation((instructions?: string) => {
      forwarded.push(`greeting:${instructions ?? ""}`);
    });
    const bridge = await createLazyVoiceBridge();
    const first = Buffer.from([0x01]);
    const second = Buffer.from([0x02]);

    bridge.sendAudio(first);
    bridge.setMediaTimestamp(42);
    bridge.sendUserMessage?.("hello");
    await bridge.submitToolResult("call-1", { ok: true });
    bridge.triggerGreeting?.("welcome");
    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(runtimeMocks.voiceConnect).toHaveBeenCalledOnce());
    bridge.sendAudio(second);

    expect(runtimeMocks.voiceSetMediaTimestamp).not.toHaveBeenCalled();
    expect(runtimeMocks.voiceSendAudio).not.toHaveBeenCalled();
    expect(runtimeMocks.voiceSendUserMessage).not.toHaveBeenCalled();
    expect(runtimeMocks.voiceSubmitToolResult).not.toHaveBeenCalled();
    expect(runtimeMocks.voiceTriggerGreeting).not.toHaveBeenCalled();

    connecting.resolve();
    await connectPromise;
    expect(runtimeMocks.voiceSetMediaTimestamp).toHaveBeenCalledWith(42);
    expect(runtimeMocks.voiceSendAudio.mock.calls.map(([audio]) => audio)).toEqual([first, second]);
    expect(runtimeMocks.voiceSendUserMessage).toHaveBeenCalledWith("hello");
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledWith(
      "call-1",
      { ok: true },
      undefined,
    );
    expect(runtimeMocks.voiceTriggerGreeting).toHaveBeenCalledWith("welcome");
    expect(forwarded).toEqual([
      "audio:1",
      "timestamp:42",
      "user:hello",
      "tool:call-1",
      "greeting:welcome",
      "audio:2",
    ]);
  });

  it("moves the latest pending timestamp and greeting to the operation tail", async () => {
    const forwarded: string[] = [];
    runtimeMocks.voiceSetMediaTimestamp.mockImplementation((timestamp: number) => {
      forwarded.push(`timestamp:${timestamp}`);
    });
    runtimeMocks.voiceSendUserMessage.mockImplementation((text: string) => {
      forwarded.push(`user:${text}`);
    });
    runtimeMocks.voiceSendAudio.mockImplementation((audio: Buffer) => {
      forwarded.push(`audio:${audio[0]}`);
    });
    runtimeMocks.voiceTriggerGreeting.mockImplementation((instructions?: string) => {
      forwarded.push(`greeting:${String(instructions)}`);
    });
    const bridge = await createLazyVoiceBridge();

    bridge.setMediaTimestamp(1);
    bridge.sendUserMessage?.("middle");
    bridge.setMediaTimestamp(2);
    bridge.triggerGreeting?.("superseded");
    bridge.sendAudio(Buffer.from([0x03]));
    bridge.triggerGreeting?.();
    await bridge.connect();

    expect(forwarded).toEqual(["user:middle", "timestamp:2", "audio:3", "greeting:undefined"]);

    runtimeMocks.voiceTriggerGreeting.mockClear();
    runtimeMocks.voiceIsConnected.mockReturnValue(false);
    bridge.triggerGreeting?.("provider-owned-reconnect");
    expect(runtimeMocks.voiceTriggerGreeting).toHaveBeenCalledWith("provider-owned-reconnect");
  });

  it.each([
    ["undefined", (): undefined => undefined],
    ["bigint", () => ({ value: 1n })],
  ] as const)(
    "rejects %s voice tool results before lazy queue admission",
    async (_label, create) => {
      const onError = vi.fn();
      const bridge = await createLazyVoiceBridge({ onError });

      expect(() => bridge.submitToolResult("call-1", create())).toThrow(/serializ/i);
      expect(onError).toHaveBeenCalledOnce();

      await bridge.submitToolResult("call-1", { recovered: true });
      await bridge.connect();

      expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledExactlyOnceWith(
        "call-1",
        { recovered: true },
        undefined,
      );
    },
  );

  it("snapshots lazy voice tool results with one canonical serialization", async () => {
    const bridge = await createLazyVoiceBridge();
    const toJSON = vi.fn((key: string) => ({ key, ok: true }));

    await bridge.submitToolResult("call-1", { toJSON });
    await bridge.connect();

    expect(toJSON).toHaveBeenCalledExactlyOnceWith("");
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledExactlyOnceWith(
      "call-1",
      { key: "", ok: true },
      undefined,
    );
  });

  it("ignores unsupported interim voice results before lazy queue admission", async () => {
    const onError = vi.fn();
    const bridge = await createLazyVoiceBridge({ onError });

    expect(() =>
      bridge.submitToolResult("call-1", undefined, { willContinue: true }),
    ).not.toThrow();
    await bridge.connect();

    expect(onError).not.toHaveBeenCalled();
    expect(runtimeMocks.voiceSubmitToolResult).not.toHaveBeenCalled();
  });

  it("keeps voice payloads byte-bounded until the underlying connect resolves", async () => {
    const connecting = createDeferred<void>();
    runtimeMocks.voiceConnect.mockReturnValue(connecting.promise);
    const onError = vi.fn();
    const bridge = await createLazyVoiceBridge({ onError });
    const acceptedMessage = "a".repeat(200 * 1024);
    const acceptedResult = { text: "b".repeat(200 * 1024) };

    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(runtimeMocks.voiceConnect).toHaveBeenCalledOnce());
    bridge.sendUserMessage?.(acceptedMessage);
    bridge.sendUserMessage?.("c".repeat(64 * 1024));
    await bridge.submitToolResult("call-1", acceptedResult);
    expect(() => bridge.submitToolResult("call-2", { text: "d".repeat(64 * 1024) })).toThrow(
      "xAI realtime voice pending tool result overflow during lazy startup",
    );

    expect(runtimeMocks.voiceSendUserMessage).not.toHaveBeenCalled();
    expect(runtimeMocks.voiceSubmitToolResult).not.toHaveBeenCalled();
    expect(onError.mock.calls.map(([error]) => (error as Error).message)).toEqual([
      "xAI realtime voice pending user message overflow during lazy startup",
      "xAI realtime voice pending tool result overflow during lazy startup",
    ]);

    connecting.resolve();
    await connectPromise;

    expect(runtimeMocks.voiceSendUserMessage).toHaveBeenCalledExactlyOnceWith(acceptedMessage);
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledExactlyOnceWith(
      "call-1",
      acceptedResult,
      undefined,
    );
  });

  it("drains voice input queued while an earlier tool result is submitting", async () => {
    const submitting = createDeferred<void>();
    const forwarded: string[] = [];
    runtimeMocks.voiceSubmitToolResult
      .mockImplementationOnce((callId: string) => {
        forwarded.push(`tool:${callId}`);
        return submitting.promise;
      })
      .mockImplementation((callId: string) => {
        forwarded.push(`tool:${callId}`);
      });
    runtimeMocks.voiceSendUserMessage.mockImplementation((text: string) => {
      forwarded.push(`user:${text}`);
    });
    runtimeMocks.voiceSetMediaTimestamp.mockImplementation((timestamp: number) => {
      forwarded.push(`timestamp:${timestamp}`);
    });
    const bridge = await createLazyVoiceBridge();

    await bridge.submitToolResult("call-1", { text: "first" });
    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledOnce());
    bridge.sendUserMessage?.("arrived-during-flush");
    bridge.setMediaTimestamp(84);
    await bridge.submitToolResult("call-2", { text: "second" });
    submitting.resolve();
    await connectPromise;

    expect(runtimeMocks.voiceSendUserMessage).toHaveBeenCalledWith("arrived-during-flush");
    expect(runtimeMocks.voiceSetMediaTimestamp).toHaveBeenLastCalledWith(84);
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenLastCalledWith(
      "call-2",
      { text: "second" },
      undefined,
    );
    expect(forwarded).toEqual([
      "tool:call-1",
      "user:arrived-during-flush",
      "timestamp:84",
      "tool:call-2",
    ]);
  });

  it("keeps an in-flight voice tool result charged against the startup byte cap", async () => {
    const submitting = createDeferred<void>();
    runtimeMocks.voiceSubmitToolResult.mockReturnValueOnce(submitting.promise);
    const onError = vi.fn();
    const bridge = await createLazyVoiceBridge({ onError });

    await bridge.submitToolResult("call-1", { text: "a".repeat(200 * 1024) });
    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledOnce());
    expect(() => bridge.submitToolResult("call-2", { text: "b".repeat(64 * 1024) })).toThrow(
      "xAI realtime voice pending tool result overflow during lazy startup",
    );

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toEqual(
      new Error("xAI realtime voice pending tool result overflow during lazy startup"),
    );
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledOnce();

    submitting.resolve();
    await connectPromise;
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledOnce();
  });

  it("forwards all voice input admitted during the final connect handoff exactly once", async () => {
    const connecting = createDeferred<void>();
    runtimeMocks.voiceConnect.mockReturnValue(connecting.promise);
    runtimeMocks.voiceIsConnected.mockReturnValue(true);
    const bridge = await createLazyVoiceBridge();
    const audio = Buffer.from([0x01]);

    const firstConnect = bridge.connect();
    const secondConnect = bridge.connect();
    await vi.waitFor(() => expect(runtimeMocks.voiceConnect).toHaveBeenCalledOnce());
    connecting.resolve();
    queueMicrotask(() => {
      bridge.sendAudio(audio);
      bridge.setMediaTimestamp(84);
      bridge.sendUserMessage?.("arrived-during-handoff");
      void bridge.submitToolResult("call-1", { text: "tool-result" });
      bridge.triggerGreeting?.("welcome");
    });
    await Promise.all([firstConnect, secondConnect]);

    expect(runtimeMocks.voiceSendAudio).toHaveBeenCalledExactlyOnceWith(audio);
    expect(runtimeMocks.voiceSetMediaTimestamp).toHaveBeenCalledExactlyOnceWith(84);
    expect(runtimeMocks.voiceSendUserMessage).toHaveBeenCalledExactlyOnceWith(
      "arrived-during-handoff",
    );
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledExactlyOnceWith(
      "call-1",
      { text: "tool-result" },
      undefined,
    );
    expect(runtimeMocks.voiceTriggerGreeting).toHaveBeenCalledExactlyOnceWith("welcome");
  });

  it("keeps a replacement voice generation open when a superseded connect rejects", async () => {
    const failure = new Error("superseded voice connect rejected");
    const firstConnect = createDeferred<void>();
    runtimeMocks.voiceConnect
      .mockReturnValueOnce(firstConnect.promise)
      .mockResolvedValueOnce(undefined);
    const onError = vi.fn();
    const onClose = vi.fn();
    const bridge = await createLazyVoiceBridge({ onError, onClose });

    const staleConnect = bridge.connect();
    const staleConnectResult = expect(staleConnect).rejects.toBe(failure);
    await vi.waitFor(() => expect(runtimeMocks.voiceConnect).toHaveBeenCalledOnce());
    const staleRequest = runtimeMocks.createVoiceBridge.mock.calls[0]?.[0];
    void bridge.close();
    const replacementConnect = bridge.connect();
    await replacementConnect;
    staleRequest?.onClose?.("error");
    bridge.sendUserMessage?.("replacement-still-open");
    firstConnect.reject(failure);
    await staleConnectResult;

    expect(runtimeMocks.voiceConnect).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.createVoiceBridge).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.voiceClose).toHaveBeenCalledOnce();
    expect(runtimeMocks.voiceSendUserMessage).toHaveBeenCalledWith("replacement-still-open");
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
    const staleRequest = runtimeMocks.createVoiceBridge.mock.calls[0]?.[0];
    void bridge.close();
    await bridge.connect();
    const currentRequest = runtimeMocks.createVoiceBridge.mock.calls[1]?.[0];
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
    for (const callback of Object.values(callbacks)) {
      expect(callback).not.toHaveBeenCalled();
    }

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
      runtimeMocks.voiceConnect.mockRejectedValueOnce(failure);
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
        const request = runtimeMocks.createVoiceBridge.mock.calls[0]?.[0];
        request?.onTranscript?.("assistant", "partial tail", false);
        request?.onAudio(Buffer.from([0x01]));
        request?.onToolCall?.({ itemId: "item", callId: "call", name: "probe", args: {} });
        request?.onTranscript?.("assistant", "final tail", true);
      };
      runtimeMocks.voiceClose.mockImplementationOnce(() => {
        if (cleanup === "sync") {
          emitTail();
          throw cleanupFailure;
        }
        return disposed.promise;
      });
      const failedConnect = expect(bridge.connect()).rejects.toBe(failure);
      try {
        await vi.waitFor(() => expect(runtimeMocks.voiceClose).toHaveBeenCalledOnce());
        if (cleanup !== "sync") {
          expect(onClose).not.toHaveBeenCalled();
          emitTail();
        }
        expect(callbacks.onAudio).not.toHaveBeenCalled();
        expect(callbacks.onToolCall).not.toHaveBeenCalled();
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
        expect(runtimeMocks.voiceSendAudio).not.toHaveBeenCalled();
      } finally {
        disposed.resolve();
        await failedConnect;
        await Promise.all(observerCloses);
      }
    },
  );

  it("reopens voice only after an explicit connect following provider termination", async () => {
    const onClose = vi.fn();
    const bridge = await createLazyVoiceBridge({ onClose });
    const discarded = Buffer.from([0x01]);
    const accepted = Buffer.from([0x02]);

    await bridge.connect();
    const loadedRequest = runtimeMocks.createVoiceBridge.mock.calls[0]?.[0];
    loadedRequest?.onClose?.("error");
    bridge.sendAudio(discarded);

    const reconnectPromise = bridge.connect();
    bridge.sendAudio(accepted);
    await reconnectPromise;

    expect(runtimeMocks.voiceConnect).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.voiceSendAudio).toHaveBeenCalledExactlyOnceWith(accepted);
    expect(onClose).toHaveBeenCalledExactlyOnceWith("error");
  });

  it("reports explicit voice close once when the provider also reports completion", async () => {
    const onClose = vi.fn();
    const bridge = await createLazyVoiceBridge({ onClose });

    await bridge.connect();
    const loadedRequest = runtimeMocks.createVoiceBridge.mock.calls[0]?.[0];
    runtimeMocks.voiceClose.mockImplementation(() => loadedRequest?.onClose?.("completed"));
    void bridge.close();
    void bridge.close();

    expect(runtimeMocks.voiceClose).toHaveBeenCalledOnce();
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
      const createBridge = runtimeMocks.createVoiceBridge.getMockImplementation();
      if (!createBridge) {
        throw new Error("The voice fixture has no bridge factory");
      }
      const firstConnect = vi.fn(async () => {});
      const firstClose = vi.fn(() => disposed.promise);
      const replacementConnect = vi.fn(() => ready.promise);
      const onClose = vi.fn();
      const onTranscript = vi.fn();
      const bridge = await createLazyVoiceBridge({ onClose, onTranscript });
      const providerTerminated = closeAt === "provider-terminal";
      const constructing = closeAt === "construction" || providerTerminated;
      const earlyReconnect = constructing && reconnect;
      let closing: void | Promise<void> = undefined;
      let reconnecting: Promise<void> | undefined;
      runtimeMocks.createVoiceBridge
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
        const firstRequest = runtimeMocks.createVoiceBridge.mock.calls[0]?.[0];
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
        expect(runtimeMocks.voiceSendAudio).not.toHaveBeenCalled();
        expect(onClose.mock.calls).toEqual(providerTerminated ? [["error"]] : []);

        if (reconnect) {
          reconnecting ??= bridge.connect();
          await vi.waitFor(() => expect(replacementConnect).toHaveBeenCalledOnce());
          const joined = bridge.connect();
          ready.resolve();
          await Promise.all([reconnecting, joined]);
          expect(runtimeMocks.createVoiceBridge).toHaveBeenCalledTimes(2);
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
          expect(runtimeMocks.voiceSendAudio).toHaveBeenCalledExactlyOnceWith(Buffer.from([0x02]));
          expect(runtimeMocks.voiceClose).not.toHaveBeenCalled();
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
    expect(runtimeMocks.buildVoiceProvider).not.toHaveBeenCalled();
  });
});
