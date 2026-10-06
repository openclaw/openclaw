import type { RealtimeVoiceBridgeCreateRequest } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverPendingAudio } from "./realtime-quicksilver-audio-buffer.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import type {
  OpenAIQuicksilverAudioPeerCallbacks,
  OpenAIQuicksilverAudioPeerContract,
} from "./realtime-quicksilver-media.runtime.js";
import {
  releaseOpenAIQuicksilverSession,
  reserveOpenAIQuicksilverSession,
} from "./realtime-quicksilver-session-limit.js";
import { connectOpenAIQuicksilverSideband } from "./realtime-quicksilver-sideband.js";
import type { OpenAIQuicksilverSocketFactory } from "./realtime-quicksilver-socket.shared.js";
import {
  createCallResponse,
  emitSideband,
  FakeSocket,
  parseSent,
} from "./realtime-quicksilver.test-helpers.js";

type TestableGatewayBridge = {
  pendingAudio: OpenAIQuicksilverPendingAudio;
};

function readPendingAudio(pending: OpenAIQuicksilverPendingAudio): Buffer {
  const length = pending.length;
  const audio = Buffer.alloc(length);
  const readBytes = pending.readInto(audio);
  if (readBytes !== length) {
    throw new Error(`Expected to read ${length} pending audio bytes, got ${readBytes}`);
  }
  return audio;
}

describe("GPT-Live gateway relay bridge", () => {
  function createPendingPeerBridge(
    params?: Partial<
      Pick<
        RealtimeVoiceBridgeCreateRequest,
        | "audioFormat"
        | "onAudio"
        | "onTranscript"
        | "onResponseDone"
        | "onEvent"
        | "onClose"
        | "onError"
        | "runAgentConsult"
        | "handleDelegationInput"
      >
    >,
  ) {
    let resolvePeer: ((peer: OpenAIQuicksilverAudioPeerContract) => void) | undefined;
    let rejectPeer: ((error: Error) => void) | undefined;
    let peerCallbacks: OpenAIQuicksilverAudioPeerCallbacks | undefined;
    let socket: FakeSocket | undefined;
    let markPeerStarted!: () => void;
    const peerStarted = new Promise<void>((resolve) => {
      markPeerStarted = resolve;
    });
    const peerPromise = new Promise<OpenAIQuicksilverAudioPeerContract>((resolve, reject) => {
      resolvePeer = resolve;
      rejectPeer = reject;
    });
    const peer = {
      createOffer: vi.fn(async () => "v=offer\r\n"),
      applyAnswer: vi.fn(async () => undefined),
      adoptPendingAudio: vi.fn(),
      sendAudio: vi.fn(),
      close: vi.fn(),
    } satisfies OpenAIQuicksilverAudioPeerContract;
    const createPeer = vi.fn((callbacks: OpenAIQuicksilverAudioPeerCallbacks) => {
      peerCallbacks = callbacks;
      markPeerStarted();
      return peerPromise;
    });
    const onClose = vi.fn();
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const bridge = new OpenAIQuicksilverGatewayBridge(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
        voice: "marin",
        audioFormat: params?.audioFormat ?? {
          encoding: "pcm16",
          sampleRateHz: 24_000,
          channels: 1,
        },
        onAudio: params?.onAudio ?? vi.fn(),
        onTranscript: params?.onTranscript,
        onResponseDone: params?.onResponseDone,
        onEvent: params?.onEvent,
        onClearAudio: vi.fn(),
        onClose: params?.onClose ?? onClose,
        onError: params?.onError,
        runAgentConsult: params?.runAgentConsult ?? vi.fn(async () => ({ text: "done" })),
        handleDelegationInput: params?.handleDelegationInput,
        logger,
        resolveAuth: vi.fn(async () => ({
          type: "oauth" as const,
          token: "oauth-token",
          accountId: "account-1",
        })),
        createPeer,
        fetchImpl: vi.fn(async () => createCallResponse("v=answer\r\n", "rtc_pending_audio")),
        webSocketFactory: () => (socket = new FakeSocket()),
      },
      openAIRealtimeHost,
    );
    const connection = bridge.connect();
    return {
      bridge,
      connection,
      onClose,
      logger,
      peer,
      getSocket: () => {
        if (!socket) {
          throw new Error("expected sideband socket");
        }
        return socket;
      },
      rejectPeer: (error: Error) => rejectPeer?.(error),
      resolvePeer: () => resolvePeer?.(peer),
      triggerPeerError: (error: Error) => peerCallbacks?.onError(error),
      triggerPeerMediaError: (error: Error) => peerCallbacks?.onMediaError?.(error),
      triggerPeerAudio: (audio: Buffer) => peerCallbacks?.onAudio(audio),
      waitForPeerStart: () => peerStarted,
    };
  }

  it.each(["pcm16", "g711_ulaw"] as const)(
    "keeps WebRTC audio flowing across transcript finals (%s)",
    async (encoding) => {
      const deliveredAudio: Buffer[] = [];
      const onTranscript = vi.fn();
      const onResponseDone = vi.fn();
      const harness = createPendingPeerBridge({
        audioFormat:
          encoding === "pcm16"
            ? { encoding, sampleRateHz: 24_000, channels: 1 }
            : { encoding, sampleRateHz: 8_000, channels: 1 },
        onAudio: (audio) => deliveredAudio.push(audio),
        onTranscript,
        onResponseDone,
      });
      try {
        await harness.waitForPeerStart();
        harness.resolvePeer();
        await harness.connection;
        const pcm = Buffer.alloc(960, 0x12);
        harness.triggerPeerAudio(pcm);
        emitSideband(harness.getSocket(), {
          type: "turn.done",
          turn: { role: "assistant", transcript: "Received reply" },
        });
        harness.triggerPeerAudio(pcm);
        expect(onTranscript).toHaveBeenCalledExactlyOnceWith("assistant", "Received reply", true);
        expect(onResponseDone).not.toHaveBeenCalled();
        expect(Buffer.concat(deliveredAudio)).toHaveLength(encoding === "pcm16" ? 1920 : 315);
        expect(harness.bridge.isConnected()).toBe(true);
      } finally {
        await harness.bridge.close();
      }
    },
  );

  it("does not complete a reply when its final transcript callback closes the bridge", async () => {
    const onResponseDone = vi.fn();
    const onAudio = vi.fn();
    const harness = createPendingPeerBridge({
      onAudio,
      onResponseDone,
      onTranscript: (_role, _text, done) => {
        if (done) {
          void harness.bridge.close();
        }
      },
    });
    try {
      await harness.waitForPeerStart();
      harness.resolvePeer();
      await harness.connection;
      emitSideband(harness.getSocket(), {
        type: "turn.done",
        turn: { role: "assistant", transcript: "Finished" },
      });
      harness.triggerPeerAudio(Buffer.alloc(960));
      expect(onResponseDone).not.toHaveBeenCalled();
      expect(onAudio).not.toHaveBeenCalled();
      expect(harness.bridge.isConnected()).toBe(false);
    } finally {
      await harness.bridge.close();
    }
  });

  it("admits delegation final audio before its first transcript after a spoken receipt", async () => {
    let resolveConsult!: (result: { text: string }) => void;
    const consultResult = new Promise<{ text: string }>((resolve) => {
      resolveConsult = resolve;
    });
    let finalSent!: () => void;
    const finalAppend = new Promise<void>((resolve) => {
      finalSent = resolve;
    });
    const callbacks: string[] = [];
    const onAudio = vi.fn(() => callbacks.push("audio"));
    const onResponseDone = vi.fn();
    const harness = createPendingPeerBridge({
      onAudio,
      onResponseDone,
      handleDelegationInput: () => "consult",
      runAgentConsult: vi.fn(async () => consultResult),
      onEvent: (event) => {
        if (event.direction === "client" && event.type === "response.create") {
          callbacks.push("requested");
        }
      },
    });
    try {
      await harness.waitForPeerStart();
      harness.resolvePeer();
      await harness.connection;
      const socket = harness.getSocket();
      const send = socket.send.bind(socket);
      let deliveredFinalAudio = false;
      socket.send = (payload) => {
        send(payload);
        if ((JSON.parse(payload) as { type?: string }).type === "delegation.context.append") {
          callbacks.push("final-append");
          if (!deliveredFinalAudio) {
            deliveredFinalAudio = true;
            harness.triggerPeerAudio(Buffer.alloc(960, 0x12));
            finalSent();
          }
        }
      };
      emitSideband(socket, {
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id: "delegation-media-first",
          content: [{ type: "input_text", text: "Check this request" }],
        },
      });
      harness.triggerPeerAudio(Buffer.alloc(960, 0x12));
      emitSideband(socket, {
        type: "turn.done",
        turn: { role: "assistant", transcript: "I will check that request." },
      });
      expect(onResponseDone).not.toHaveBeenCalled();

      resolveConsult({ text: "Final ".repeat(100) });
      await finalAppend;

      expect(onAudio).toHaveBeenCalledTimes(2);
      expect(callbacks.filter((callback) => callback === "requested")).toHaveLength(2);
      expect(callbacks.slice(-4)).toEqual(["requested", "final-append", "audio", "final-append"]);
      emitSideband(socket, {
        type: "turn.done",
        turn: { role: "assistant", transcript: "The final answer." },
      });
      expect(onResponseDone).not.toHaveBeenCalled();
      expect(harness.bridge.isConnected()).toBe(true);
    } finally {
      resolveConsult({ text: "Finished" });
      await harness.bridge.close();
    }
  });

  it("does not append requested speech when response admission reentrantly closes the bridge", async () => {
    const harness = createPendingPeerBridge({
      onEvent: (event) => {
        if (event.direction === "client" && event.type === "response.create") {
          void harness.bridge.close();
        }
      },
    });
    try {
      await harness.waitForPeerStart();
      harness.resolvePeer();
      await harness.connection;
      const socket = harness.getSocket();
      const sentBeforeAdmission = [...socket.sent];

      harness.bridge.sendUserMessage("Do not send speech after closure.");

      expect(
        socket.sent.slice(sentBeforeAdmission.length).map((payload) => JSON.parse(payload)),
      ).toEqual([{ type: "session.close" }]);
      expect(harness.onClose).toHaveBeenCalledExactlyOnceWith("completed");
      expect(harness.bridge.isConnected()).toBe(false);
    } finally {
      await harness.bridge.close();
    }
  });

  it("preserves the call on media errors without logging raw error details", async () => {
    const harness = createPendingPeerBridge();
    try {
      await harness.waitForPeerStart();
      harness.resolvePeer();
      await harness.connection;
      harness.triggerPeerMediaError(new Error("synthetic-private-token"));
      expect(harness.bridge.isConnected()).toBe(true);
      expect(harness.onClose).not.toHaveBeenCalled();
      expect(harness.peer.close).not.toHaveBeenCalled();
      expect(harness.logger.debug).toHaveBeenCalledExactlyOnceWith(
        "GPT-Live WebRTC media packet dropped",
      );
      harness.triggerPeerError(new Error("terminal connection failure"));
      expect(harness.onClose).toHaveBeenCalledExactlyOnceWith("error");
      expect(harness.peer.close).toHaveBeenCalledOnce();
    } finally {
      await harness.bridge.close();
    }
  });

  it("preserves caller-owned microphone frames while the media peer is starting", async () => {
    const { bridge, connection, peer, resolvePeer } = createPendingPeerBridge();
    const testBridge = bridge as unknown as TestableGatewayBridge;
    try {
      expect(bridge.connect()).toBe(connection);
      const source = Buffer.from([0x7f, 0x41]);
      bridge.sendAudio(source);
      source.fill(0);
      bridge.sendAudio(Buffer.from([0x22, 0x23]));
      const pendingAudio = testBridge.pendingAudio;

      resolvePeer();
      await connection;

      expect(peer.adoptPendingAudio).toHaveBeenCalledOnce();
      expect(peer.adoptPendingAudio).toHaveBeenCalledWith(pendingAudio);
      expect(testBridge.pendingAudio).not.toBe(pendingAudio);
      expect(testBridge.pendingAudio).toHaveLength(0);
      expect(readPendingAudio(pendingAudio)).toEqual(Buffer.from([0x7f, 0x41, 0x22, 0x23]));
      bridge.sendAudio(Buffer.from([0x30, 0x31]));
      expect(peer.sendAudio).toHaveBeenCalledOnce();
      expect(peer.sendAudio).toHaveBeenCalledWith(Buffer.from([0x30, 0x31]));
    } finally {
      await bridge.close();
    }
  });

  it("discards queued microphone audio when closed before the media peer resolves", async () => {
    const { bridge, connection, onClose, peer, resolvePeer, waitForPeerStart } =
      createPendingPeerBridge();
    const testBridge = bridge as unknown as TestableGatewayBridge;
    await waitForPeerStart();
    bridge.sendAudio(Buffer.from([0x41, 0x42]));
    await bridge.close();
    await bridge.close();

    expect(testBridge.pendingAudio).toHaveLength(0);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("completed");
    resolvePeer();

    await expect(connection).rejects.toThrow("OpenAI GPT-Live gateway relay failed");
    await vi.waitFor(() => expect(peer.close).toHaveBeenCalledOnce());
    expect(peer.sendAudio).not.toHaveBeenCalled();
    bridge.sendAudio(Buffer.from([0x43, 0x44]));
    expect(peer.sendAudio).not.toHaveBeenCalled();
  });

  it("discards queued microphone audio when media peer creation fails", async () => {
    const { bridge, connection, peer, rejectPeer, waitForPeerStart } = createPendingPeerBridge();
    const pendingAudioState = bridge as unknown as {
      pendingAudio: OpenAIQuicksilverPendingAudio;
    };
    await waitForPeerStart();
    bridge.sendAudio(Buffer.from([0x41, 0x42]));
    rejectPeer(new Error("media peer unavailable"));

    await expect(connection).rejects.toThrow("OpenAI GPT-Live gateway relay failed");
    expect(pendingAudioState.pendingAudio).toHaveLength(0);
    bridge.sendAudio(Buffer.from([0x43, 0x44]));
    expect(pendingAudioState.pendingAudio).toHaveLength(0);
    expect(peer.sendAudio).not.toHaveBeenCalled();
  });

  it("keeps error precedence when onError reentrantly closes the bridge", async () => {
    const onClose = vi.fn();
    const bridgeRef: { current?: OpenAIQuicksilverGatewayBridge } = {};
    const harness = createPendingPeerBridge({
      onClose,
      onError: () => {
        void bridgeRef.current?.close();
      },
    });
    bridgeRef.current = harness.bridge;
    await harness.waitForPeerStart();
    const connectionRejected = expect(harness.connection).rejects.toThrow(
      "OpenAI GPT-Live gateway relay failed",
    );

    harness.triggerPeerError(new Error("media peer failed"));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("error");
    await connectionRejected;
  });

  it("releases queued audio and rejects a late peer when onError throws", async () => {
    const callbackError = new Error("error callback failed");
    const onClose = vi.fn();
    const harness = createPendingPeerBridge({
      onClose,
      onError: () => {
        throw callbackError;
      },
    });
    const testBridge = harness.bridge as unknown as TestableGatewayBridge;
    await harness.waitForPeerStart();
    harness.bridge.sendAudio(Buffer.from([0x41, 0x42]));
    const connectionRejected = expect(harness.connection).rejects.toThrow(
      "OpenAI GPT-Live gateway relay failed",
    );

    expect(() => harness.triggerPeerError(new Error("media peer failed"))).toThrow(callbackError);
    const retainedAudioBytes = testBridge.pendingAudio.length;
    const closeReason = onClose.mock.calls[0]?.[0];
    await harness.bridge.close();
    harness.resolvePeer();

    await connectionRejected;
    await vi.waitFor(() => expect(harness.peer.close).toHaveBeenCalledOnce());
    expect(retainedAudioBytes).toBe(0);
    expect(closeReason).toBe("error");
    expect(harness.peer.sendAudio).not.toHaveBeenCalled();
  });

  it("closes a sideband that opens in the abort handoff", async () => {
    const controller = new AbortController();
    const socket = new FakeSocket("manual");
    const connection = connectOpenAIQuicksilverSideband(
      {
        auth: { type: "api-key", token: "platform-key" },
        createSocket: () => socket,
        requestIds: {
          realtimeSessionId: "realtime-session",
          sessionId: "session",
          threadId: "thread",
        },
        signal: controller.signal,
        url: "wss://api.openai.com/v1/live/rtc_test",
      },
      openAIRealtimeHost,
    );
    socket.readyState = 1;
    socket.emit("open");
    controller.abort(new Error("sideband startup stopped"));

    await expect(connection).rejects.toThrow("sideband startup stopped");
    expect(socket.closed).toBe(true);
  });

  it("bounds sideband frames and aggregate pre-open buffering", async () => {
    const controller = new AbortController();
    const socket = new FakeSocket("manual");
    let socketOptions: Parameters<OpenAIQuicksilverSocketFactory>[1] | undefined;
    socket.once("close", () => controller.abort(new Error("sideband overflow observed")));
    const connection = connectOpenAIQuicksilverSideband(
      {
        auth: { type: "api-key", token: "platform-key" },
        createSocket: (_url, options) => {
          socketOptions = options;
          return socket;
        },
        requestIds: {
          realtimeSessionId: "realtime-session",
          sessionId: "session",
          threadId: "thread",
        },
        signal: controller.signal,
        url: "wss://api.openai.com/v1/live/rtc_test",
      },
      openAIRealtimeHost,
    );

    expect(socketOptions?.maxPayload).toBe(16 * 1024 * 1024);
    socket.emit("message", Buffer.alloc(512 * 1024), false);
    socket.emit("message", Buffer.alloc(512 * 1024), false);
    socket.emit("message", Buffer.from([0]), false);

    await expect(connection).rejects.toThrow("sideband overflow observed");
    expect(socket.closeCode).toBe(1009);
    expect(socket.closeReason).toBe("sideband startup buffer exceeded");
  });

  it("bounds peer creation and closes a peer that resolves after the deadline", async () => {
    let resolvePeer: ((peer: OpenAIQuicksilverAudioPeerContract) => void) | undefined;
    const peerPromise = new Promise<OpenAIQuicksilverAudioPeerContract>((resolve) => {
      resolvePeer = resolve;
    });
    const closePeer = vi.fn();
    const bridge = new OpenAIQuicksilverGatewayBridge(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
        voice: "marin",
        audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        runAgentConsult: vi.fn(async () => ({ text: "done" })),
        logger: { debug: vi.fn(), warn: vi.fn() },
        resolveAuth: vi.fn(async () => ({
          type: "oauth" as const,
          token: "oauth-token",
          accountId: "account-1",
        })),
        createPeer: vi.fn(() => peerPromise),
        connectTimeoutMs: 5,
      },
      openAIRealtimeHost,
    );

    await expect(bridge.connect()).rejects.toMatchObject({ name: "TimeoutError" });
    const reservationOwners = Array.from({ length: 8 }, () => ({}));
    try {
      for (const owner of reservationOwners) {
        expect(() => reserveOpenAIQuicksilverSession(owner)).not.toThrow();
      }
    } finally {
      for (const owner of reservationOwners) {
        releaseOpenAIQuicksilverSession(owner);
      }
    }
    resolvePeer?.({
      createOffer: vi.fn(async () => "v=offer\r\n"),
      applyAnswer: vi.fn(async () => undefined),
      adoptPendingAudio: vi.fn(),
      sendAudio: vi.fn(),
      close: closePeer,
    });
    await vi.waitFor(() => expect(closePeer).toHaveBeenCalledOnce());
  });

  it("uses released Platform WebRTC, delegates, drops sideband audio, and tears down", async () => {
    let socket: FakeSocket | undefined;
    const applyAnswer = vi.fn(async () => undefined);
    const closePeer = vi.fn();
    const createOffer = vi.fn(async () => "v=offer\r\n");
    const adoptPendingAudio = vi.fn();
    const peer: OpenAIQuicksilverAudioPeerContract = {
      createOffer,
      applyAnswer,
      adoptPendingAudio,
      sendAudio: vi.fn(),
      close: closePeer,
    };
    const runAgentConsult = Object.assign(
      vi.fn(async () => ({ text: "Delegated result" })),
      { claimAppend: vi.fn(() => true) },
    );
    const handleDelegationInput = vi.fn((text: string): "control" | "consult" =>
      text === "Status?" ? "control" : "consult",
    );
    const onAudio = vi.fn();
    const onClearAudio = vi.fn();
    const onEvent = vi.fn();
    const onReady = vi.fn();
    const onClose = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      createCallResponse("v=answer\r\n", "rtc_bridge"),
    );
    const bridge = new OpenAIQuicksilverGatewayBridge(
      {
        providerConfig: {},
        model: "gpt-live-1-codex",
        voice: "cove",
        instructions: "Speak briefly.",
        audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        onAudio,
        onClearAudio,
        onEvent,
        onReady,
        onClose,
        handleDelegationInput,
        runAgentConsult,
        logger: { debug: vi.fn(), warn: vi.fn() },
        resolveAuth: vi.fn(async () => ({
          type: "api-key" as const,
          token: "test-api-key",
        })),
        createPeer: vi.fn(async () => peer),
        fetchImpl,
        webSocketFactory: () => {
          socket = new FakeSocket();
          return socket;
        },
      },
      openAIRealtimeHost,
    );

    const connection = bridge.connect();
    await vi.waitFor(() => expect(socket).toBeDefined());
    if (!socket) {
      throw new Error("expected sideband socket");
    }
    const connectedSocket = socket;
    emitSideband(connectedSocket, {
      type: "session.started",
      session: { id: "rtc_bridge", expires_at: Math.floor(Date.now() / 1000) + 60 },
    });
    await connection;
    const body = fetchImpl.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error("Expected initial call body");
    }
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      "Content-Type": expect.stringMatching(/^multipart\/form-data; boundary=/),
    });
    expect(body).toContain('"delegation":{"type":"client","ack_filler":false}');
    expect(body).toContain("Wait for the host control result");
    expect(createOffer).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(applyAnswer).toHaveBeenCalledWith("v=answer\r\n");
    expect(adoptPendingAudio).not.toHaveBeenCalled();
    expect(parseSent(connectedSocket).some((event) => event.type === "session.update")).toBe(false);
    expect(onReady).toHaveBeenCalledOnce();
    bridge.sendUserMessage("Ready for the next task");
    expect(parseSent(connectedSocket)).toEqual([
      {
        type: "session.context.append",
        channel: "speakable",
        content: [{ type: "input_text", text: "Ready for the next task" }],
      },
    ]);

    emitSideband(connectedSocket, { type: "output_audio.delta", audio: "ignored-media-copy" });
    expect(onEvent).toHaveBeenCalledWith({ direction: "server", type: "output_audio.delta" });
    expect(onAudio).not.toHaveBeenCalled();

    emitSideband(connectedSocket, { type: "output_audio_buffer.cleared" });
    expect(onClearAudio).toHaveBeenCalledWith("barge-in");

    emitSideband(connectedSocket, {
      type: "delegation.created",
      item: {
        type: "delegation",
        target: "client",
        id: "status-control",
        content: [{ type: "input_text", text: "Status?" }],
      },
    });
    expect(handleDelegationInput).toHaveBeenCalledExactlyOnceWith("Status?", expect.any(Function));
    expect(runAgentConsult).not.toHaveBeenCalled();
    expect(connectedSocket.sent).toHaveLength(1);

    emitSideband(connectedSocket, {
      type: "delegation.created",
      item: {
        type: "delegation",
        target: "client",
        id: "delegation-1",
        content: [{ type: "input_text", text: "Check the lights" }],
      },
    });
    await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(parseSent(connectedSocket)).toContainEqual({
        type: "delegation.context.append",
        delegation_item_id: "delegation-1",
        channel: "speakable",
        content: [{ type: "input_text", text: "Delegated result" }],
      }),
    );
    expect(
      parseSent(connectedSocket).filter((event) => event.type === "session.context.append"),
    ).toHaveLength(2);
    expect(connectedSocket.sent[1]).toContain("I’ll check that request.");

    await bridge.close();
    expect(closePeer).toHaveBeenCalledOnce();
    expect(connectedSocket.closed).toBe(true);
    expect(onClose).toHaveBeenCalledWith("completed");
  });

  it("treats a normal upstream sideband close as completion", async () => {
    let socket: FakeSocket | undefined;
    const onClose = vi.fn();
    const onError = vi.fn();
    const bridge = new OpenAIQuicksilverGatewayBridge(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
        voice: "marin",
        audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        onClose,
        onError,
        runAgentConsult: vi.fn(async () => ({ text: "done" })),
        logger: { debug: vi.fn(), warn: vi.fn() },
        resolveAuth: vi.fn(async () => ({
          type: "oauth" as const,
          token: "oauth-token",
          accountId: "account-1",
        })),
        createPeer: vi.fn(async () => ({
          createOffer: vi.fn(async () => "v=offer\r\n"),
          applyAnswer: vi.fn(async () => undefined),
          adoptPendingAudio: vi.fn(),
          sendAudio: vi.fn(),
          close: vi.fn(),
        })),
        fetchImpl: vi.fn(async () => createCallResponse("v=answer\r\n", "rtc_close")),
        webSocketFactory: () => {
          socket = new FakeSocket();
          return socket;
        },
      },
      openAIRealtimeHost,
    );

    await bridge.connect();
    if (!socket) {
      throw new Error("expected sideband socket");
    }
    socket.close(1000, "complete");
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith("completed");
  });
});
