import type { RealtimeVoiceBridgeCreateRequest } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { realtimeVoiceSessionTesting } from "./realtime-voice-session.test-support.js";

type TestAudioPeerCallbacks = Parameters<
  NonNullable<Parameters<typeof realtimeVoiceSessionTesting.createBridge>[4]>
>[0];

const CODEX_WEBSOCKET_RESET_ERROR =
  "stream disconnected before completion: failed to read websocket message: WebSocket protocol error: Connection reset without closing handshake";

describe("Codex app-server realtime voice bridge", () => {
  it("uses Realtime V3 on the bound thread and projects native media events", async () => {
    const requestRpc = vi.fn(async (_method: string) => ({}));
    const client = { request: requestRpc } as unknown as CodexAppServerClient;
    let peerCallbacks: TestAudioPeerCallbacks | undefined;
    const peer = {
      createOffer: vi.fn(async () => "v=offer\r\n"),
      applyAnswer: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      close: vi.fn(),
    };
    const createAudioPeer = vi.fn(async (callbacks: NonNullable<typeof peerCallbacks>) => {
      peerCallbacks = callbacks;
      return peer;
    });
    const onAudio = vi.fn();
    const onClearAudio = vi.fn();
    const onTranscript = vi.fn();
    const onEvent = vi.fn();
    const onReady = vi.fn();
    const onClose = vi.fn();
    const request: RealtimeVoiceBridgeCreateRequest = {
      providerConfig: { voice: "verse" },
      audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
      instructions: "Keep replies brief.",
      onAudio,
      onClearAudio,
      onTranscript,
      onEvent,
      onReady,
      onClose,
    };
    const bridge = realtimeVoiceSessionTesting.createBridge(
      client,
      "thread-1",
      request,
      new AbortController().signal,
      createAudioPeer,
    );

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(requestRpc).toHaveBeenCalledOnce());
    bridge.handleNotification({
      method: "thread/realtime/sdp",
      params: { threadId: "thread-1", sdp: "v=answer\r\n" },
    });
    await connecting;
    bridge.sendAudio(Buffer.from([1, 0, 2, 0]));
    bridge.handleNotification({
      method: "thread/realtime/started",
      params: { threadId: "thread-1", version: "v3" },
    });
    bridge.handleNotification({
      method: "thread/realtime/transcript/delta",
      params: { threadId: "thread-1", role: "assistant", delta: "Hi" },
    });
    bridge.handleNotification({
      method: "thread/realtime/transcript/done",
      params: { threadId: "thread-1", role: "assistant", text: "Hi there" },
    });
    peerCallbacks?.onAudio(Buffer.from([3, 4]));
    bridge.handleNotification({
      method: "thread/realtime/itemAdded",
      params: { threadId: "thread-1", item: { type: "input_audio_buffer.speech_started" } },
    });

    expect(requestRpc).toHaveBeenNthCalledWith(
      1,
      "thread/realtime/start",
      {
        threadId: "thread-1",
        outputModality: "audio",
        transport: { type: "webrtc", sdp: "v=offer\r\n" },
        version: "v3",
        includeStartupContext: true,
        initialItems: [{ role: "developer", text: "Keep replies brief." }],
        model: "gpt-live-1-codex",
        voice: "verse",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(createAudioPeer).toHaveBeenCalledOnce();
    expect(peer.applyAnswer).toHaveBeenCalledWith("v=answer\r\n");
    expect(peer.sendAudio).toHaveBeenCalledWith(Buffer.from([1, 0, 2, 0]));
    expect(requestRpc).not.toHaveBeenCalledWith("thread/realtime/appendAudio", expect.anything());
    expect(onReady).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenNthCalledWith(1, "assistant", "Hi", false);
    expect(onTranscript).toHaveBeenNthCalledWith(2, "assistant", "Hi there", true);
    expect(onEvent).toHaveBeenCalledWith({ direction: "server", type: "response.done" });
    expect(onAudio).toHaveBeenCalledWith(Buffer.from([3, 4]));
    expect(onClearAudio).toHaveBeenCalledWith("barge-in");

    bridge.handleNotification({
      method: "thread/realtime/closed",
      params: { threadId: "thread-1", reason: "remote" },
    });
    expect(await bridge.completion.promise).toBe("completed");
    expect(onClose).toHaveBeenCalledWith("completed");
  });

  it("renegotiates V3 media after consuming a connected websocket reset", async () => {
    const requestRpc = vi.fn(async (_method: string) => ({}));
    const client = { request: requestRpc } as unknown as CodexAppServerClient;
    const peerCallbacks: TestAudioPeerCallbacks[] = [];
    const peers = Array.from({ length: 2 }, (_, index) => ({
      createOffer: vi.fn(async () => `v=offer-${index + 1}\r\n`),
      applyAnswer: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      close: vi.fn(),
    }));
    const createAudioPeer = vi.fn(async (callbacks: TestAudioPeerCallbacks) => {
      peerCallbacks.push(callbacks);
      return peers[peerCallbacks.length - 1]!;
    });
    const onAudio = vi.fn();
    const onError = vi.fn();
    const onEvent = vi.fn();
    const onReady = vi.fn();
    const onClose = vi.fn();
    const bridge = realtimeVoiceSessionTesting.createBridge(
      client,
      "thread-1",
      {
        providerConfig: {},
        onAudio,
        onClearAudio: vi.fn(),
        onError,
        onEvent,
        onReady,
        onClose,
      },
      new AbortController().signal,
      createAudioPeer,
    );

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(requestRpc).toHaveBeenCalledOnce());
    bridge.handleNotification({
      method: "thread/realtime/sdp",
      params: { threadId: "thread-1", sdp: "v=answer-1\r\n" },
    });
    await connecting;

    const transportError = new Error(CODEX_WEBSOCKET_RESET_ERROR);
    bridge.handleNotification({
      method: "thread/realtime/error",
      params: { threadId: "thread-1", message: transportError.message },
    });
    expect(requestRpc).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();

    bridge.handleNotification({
      method: "thread/realtime/closed",
      params: { threadId: "thread-1", reason: "error" },
    });
    peerCallbacks[0]?.onAudio(Buffer.from([7, 8]));
    peerCallbacks[0]?.onError(new Error("late retired peer error"));

    await vi.waitFor(() => expect(requestRpc).toHaveBeenCalledTimes(2));
    expect(requestRpc).toHaveBeenNthCalledWith(
      2,
      "thread/realtime/start",
      expect.objectContaining({ transport: { type: "webrtc", sdp: "v=offer-2\r\n" } }),
      { signal: expect.any(AbortSignal) },
    );
    bridge.handleNotification({
      method: "thread/realtime/sdp",
      params: { threadId: "thread-1", sdp: "v=answer-2\r\n" },
    });
    await vi.waitFor(() => expect(bridge.isConnected()).toBe(true));

    expect(peers[0]?.close).toHaveBeenCalledOnce();
    expect(peers[1]?.applyAnswer).toHaveBeenCalledWith("v=answer-2\r\n");
    expect(onAudio).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "session.continuity.reset",
      detail: "codex-transport-recovery",
    });
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();

    const liveAudio = Buffer.from([9, 10]);
    bridge.sendAudio(liveAudio);
    expect(peers[0]?.sendAudio).not.toHaveBeenCalledWith(liveAudio);
    expect(peers[1]?.sendAudio).toHaveBeenCalledWith(liveAudio);

    bridge.close();
    await expect(bridge.completion.promise).resolves.toBe("completed");
  });

  it("keeps arbitrary V3 provider errors terminal", async () => {
    const requestRpc = vi.fn(async (_method: string) => ({}));
    const client = { request: requestRpc } as unknown as CodexAppServerClient;
    const peer = {
      createOffer: vi.fn(async () => "v=offer\r\n"),
      applyAnswer: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      close: vi.fn(),
    };
    const onClose = vi.fn();
    const bridge = realtimeVoiceSessionTesting.createBridge(
      client,
      "thread-1",
      {
        providerConfig: {},
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        onClose,
      },
      new AbortController().signal,
      vi.fn(async () => peer),
    );

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(requestRpc).toHaveBeenCalledOnce());
    bridge.handleNotification({
      method: "thread/realtime/sdp",
      params: { threadId: "thread-1", sdp: "v=answer\r\n" },
    });
    await connecting;
    bridge.handleNotification({
      method: "thread/realtime/error",
      params: { threadId: "thread-1", message: "invalid realtime model" },
    });

    await expect(bridge.completion.promise).resolves.toBe("error");
    expect(onClose).toHaveBeenCalledOnce();
    expect(
      requestRpc.mock.calls.filter(([method]) => method === "thread/realtime/start"),
    ).toHaveLength(1);
  });

  it("does not restart after local close wins a pending reset", async () => {
    const requestRpc = vi.fn(async (_method: string) => ({}));
    const client = { request: requestRpc } as unknown as CodexAppServerClient;
    const peer = {
      createOffer: vi.fn(async () => "v=offer\r\n"),
      applyAnswer: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      close: vi.fn(),
    };
    const bridge = realtimeVoiceSessionTesting.createBridge(
      client,
      "thread-1",
      {
        providerConfig: {},
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
      },
      new AbortController().signal,
      vi.fn(async () => peer),
    );

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(requestRpc).toHaveBeenCalledOnce());
    bridge.handleNotification({
      method: "thread/realtime/sdp",
      params: { threadId: "thread-1", sdp: "v=answer\r\n" },
    });
    await connecting;
    bridge.handleNotification({
      method: "thread/realtime/error",
      params: { threadId: "thread-1", message: CODEX_WEBSOCKET_RESET_ERROR },
    });
    bridge.handleNotification({
      method: "thread/realtime/closed",
      params: { threadId: "thread-1", reason: "error" },
    });
    bridge.close();

    await expect(bridge.completion.promise).resolves.toBe("completed");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(
      requestRpc.mock.calls.filter(([method]) => method === "thread/realtime/start"),
    ).toHaveLength(1);
  });

  it("fails once when the V3 replacement peer cannot start", async () => {
    const requestRpc = vi.fn(async () => ({}));
    const client = { request: requestRpc } as unknown as CodexAppServerClient;
    const peer = {
      createOffer: vi.fn(async () => "v=offer\r\n"),
      applyAnswer: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      close: vi.fn(),
    };
    const createAudioPeer = vi.fn(async () => {
      if (createAudioPeer.mock.calls.length > 1) {
        throw new Error("replacement peer failed");
      }
      return peer;
    });
    const onError = vi.fn();
    const onClose = vi.fn();
    const bridge = realtimeVoiceSessionTesting.createBridge(
      client,
      "thread-1",
      {
        providerConfig: {},
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        onError,
        onClose,
      },
      new AbortController().signal,
      createAudioPeer,
    );

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(requestRpc).toHaveBeenCalledOnce());
    bridge.handleNotification({
      method: "thread/realtime/sdp",
      params: { threadId: "thread-1", sdp: "v=answer\r\n" },
    });
    await connecting;
    bridge.handleNotification({
      method: "thread/realtime/error",
      params: { threadId: "thread-1", message: CODEX_WEBSOCKET_RESET_ERROR },
    });
    bridge.handleNotification({
      method: "thread/realtime/closed",
      params: { threadId: "thread-1", reason: "error" },
    });

    await expect(bridge.completion.promise).resolves.toBe("error");
    expect(createAudioPeer).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "replacement peer failed" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("error");
  });

  it("settles completion when the close callback throws", async () => {
    const client = { request: vi.fn(async () => ({})) } as unknown as CodexAppServerClient;
    const bridge = realtimeVoiceSessionTesting.createBridge(
      client,
      "thread-1",
      {
        providerConfig: { version: "v2" },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        onClose: () => {
          throw new Error("host teardown failed");
        },
      },
      new AbortController().signal,
    );
    await bridge.connect();

    expect(() =>
      bridge.handleNotification({
        method: "thread/realtime/closed",
        params: { threadId: "thread-1", reason: "remote" },
      }),
    ).toThrow("host teardown failed");
    await expect(bridge.completion.promise).resolves.toBe("completed");
  });

  it("supports Codex Realtime V2 on the bound thread for public API models", async () => {
    const requestRpc = vi.fn(async () => ({}));
    const client = { request: requestRpc } as unknown as CodexAppServerClient;
    const bridge = realtimeVoiceSessionTesting.createBridge(
      client,
      "thread-1",
      {
        providerConfig: {
          model: "gpt-realtime-1.5",
          version: "v2",
          voice: "cedar",
        },
        instructions: "Keep replies brief.",
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
      },
      new AbortController().signal,
    );

    await bridge.connect();

    expect(requestRpc).toHaveBeenCalledWith(
      "thread/realtime/start",
      {
        threadId: "thread-1",
        outputModality: "audio",
        transport: { type: "websocket" },
        version: "v2",
        includeStartupContext: true,
        prompt: "Keep replies brief.",
        model: "gpt-realtime-1.5",
        voice: "cedar",
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("rejects unsupported Codex realtime protocol versions", async () => {
    const requestRpc = vi.fn(async () => ({}));
    const client = { request: requestRpc } as unknown as CodexAppServerClient;
    const bridge = realtimeVoiceSessionTesting.createBridge(
      client,
      "thread-1",
      {
        providerConfig: { version: "v4" },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
      },
      new AbortController().signal,
    );

    await expect(bridge.connect()).rejects.toThrow(
      'Codex realtime version must be "v1", "v2", or "v3"',
    );
    expect(requestRpc).not.toHaveBeenCalled();
  });

  it("emits one portable response terminal for each completed native turn", async () => {
    const client = { request: vi.fn(async () => ({})) } as unknown as CodexAppServerClient;
    const onEvent = vi.fn();
    const bridge = realtimeVoiceSessionTesting.createBridge(
      client,
      "thread-1",
      {
        providerConfig: { version: "v2" },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        onEvent,
      },
      new AbortController().signal,
    );
    await bridge.connect();

    for (const [user, assistant] of [
      ["first question", "first answer"],
      ["second question", "second answer"],
    ] as const) {
      bridge.handleNotification({
        method: "thread/realtime/transcript/done",
        params: { threadId: "thread-1", role: "user", text: user },
      });
      bridge.handleNotification({
        method: "thread/realtime/transcript/done",
        params: { threadId: "thread-1", role: "assistant", text: assistant },
      });
    }
    bridge.handleNotification({
      method: "thread/realtime/transcript/done",
      params: { threadId: "thread-1", role: "user", text: "third question" },
    });
    bridge.handleNotification({
      method: "thread/realtime/transcript/done",
      params: { threadId: "thread-1", role: "assistant", text: "" },
    });

    expect(onEvent.mock.calls.filter(([event]) => event.type === "response.done")).toHaveLength(3);
  });

  it("keeps only one audio RPC in flight and fails closed when the bounded queue fills", async () => {
    let releaseAudio!: () => void;
    const stalledAudio = new Promise<void>((resolve) => {
      releaseAudio = resolve;
    });
    const requestRpc = vi.fn((method: string) =>
      method === "thread/realtime/appendAudio" ? stalledAudio : Promise.resolve({}),
    );
    const onError = vi.fn();
    const onClose = vi.fn();
    const client = { request: requestRpc } as unknown as CodexAppServerClient;
    const bridge = realtimeVoiceSessionTesting.createBridge(
      client,
      "thread-1",
      {
        providerConfig: { version: "v2" },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        onError,
        onClose,
      },
      new AbortController().signal,
    );
    await bridge.connect();

    bridge.sendAudio(Buffer.alloc(4_800));
    for (let index = 0; index < 19; index += 1) {
      bridge.sendAudio(Buffer.alloc(4_800));
    }
    expect(
      requestRpc.mock.calls.filter(([method]) => method === "thread/realtime/appendAudio"),
    ).toHaveLength(1);

    bridge.sendAudio(Buffer.alloc(1));
    expect(await bridge.completion.promise).toBe("error");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Codex realtime voice input audio queue exceeded two seconds",
      }),
    );
    expect(requestRpc).toHaveBeenCalledWith(
      "thread/realtime/stop",
      { threadId: "thread-1" },
      { signal: expect.any(AbortSignal), timeoutMs: 5_000 },
    );
    const stopCallOrder = requestRpc.mock.invocationCallOrder.find(
      (_, index) => requestRpc.mock.calls[index]?.[0] === "thread/realtime/stop",
    );
    const errorCallOrder = onError.mock.invocationCallOrder[0];
    expect(stopCallOrder).toBeDefined();
    expect(errorCallOrder).toBeDefined();
    expect(stopCallOrder!).toBeLessThan(errorCallOrder!);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("error");
    expect(bridge.getFailure()).toEqual(
      expect.objectContaining({
        message: "Codex realtime voice input audio queue exceeded two seconds",
      }),
    );
    releaseAudio();
  });
});
