import { describe, expect, it, onTestFinished, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverPendingAudio } from "./realtime-quicksilver-audio-buffer.js";
import { createBridgeCallbacks } from "./realtime-quicksilver-bridge.test-support.js";
import { delegation } from "./realtime-quicksilver-events.test-support.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import { createGatewayHarness } from "./realtime-quicksilver-gateway.test-support.js";
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

function delegate(socket: FakeSocket, id: string, text: string) {
  emitSideband(socket, delegation(id, text));
}

type BridgeConfig = ConstructorParameters<typeof OpenAIQuicksilverGatewayBridge>[0];
function createBridge(overrides: Partial<BridgeConfig> = {}) {
  const observed = createBridgeCallbacks();
  const peer = createPeer();
  const createSocket = vi.fn(() => new FakeSocket());
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    createCallResponse("v=answer\r\n", "rtc_bridge"),
  );
  const { bridge } = createGatewayHarness({
    model: "gpt-live-test-canary",
    voice: "marin",
    audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
    ...observed,
    runAgentConsult: vi.fn(async () => ({ text: "done" })),
    resolveAuth: async () => ({ type: "oauth", token: "oauth-token", accountId: "account-1" }),
    createPeer: vi.fn(async () => peer),
    fetchImpl,
    socketFactory: createSocket,
    ...overrides,
  });
  return { bridge, peer, createSocket, fetchImpl, ...observed };
}

function createPeer() {
  return {
    createOffer: vi.fn(async () => "v=offer\r\n"),
    applyAnswer: vi.fn(async () => undefined),
    adoptPendingAudio: vi.fn(),
    sendAudio: vi.fn(),
    close: vi.fn(),
  } satisfies OpenAIQuicksilverAudioPeerContract;
}

function connectSideband(
  socket: FakeSocket,
  signal: AbortSignal,
  createSocket: OpenAIQuicksilverSocketFactory = () => socket,
) {
  return connectOpenAIQuicksilverSideband(
    {
      auth: { type: "api-key", token: "platform-key" },
      createSocket,
      requestIds: {
        realtimeSessionId: "realtime-session",
        sessionId: "session",
        threadId: "thread",
      },
      signal,
      url: "wss://api.openai.com/v1/live/rtc_test",
    },
    openAIRealtimeHost,
  );
}

describe("GPT-Live gateway relay bridge", () => {
  function createPendingPeerBridge(params?: {
    onClose?: (reason: "completed" | "error") => void;
    onError?: (error: Error) => void;
  }) {
    const pending = Promise.withResolvers<OpenAIQuicksilverAudioPeerContract>();
    const startPeer = vi.fn((_callbacks: OpenAIQuicksilverAudioPeerCallbacks) => pending.promise);
    const { bridge, peer, ...observed } = createBridge({
      ...params,
      createPeer: startPeer,
    });
    onTestFinished(() => bridge.close());
    const connection = bridge.connect();
    return {
      bridge,
      connection,
      ...observed,
      peer,
      rejectPeer: pending.reject,
      resolvePeer: () => pending.resolve(peer),
      triggerPeerError: (error: Error) => startPeer.mock.calls[0]?.[0].onError(error),
      triggerPeerMediaError: (error: Error) => startPeer.mock.calls[0]?.[0].onMediaError?.(error),
      testBridge: bridge as unknown as TestableGatewayBridge,
      waitForPeerStart: async () => {
        await vi.waitFor(() => expect(startPeer).toHaveBeenCalledOnce());
      },
    };
  }

  it("preserves the call on media errors without logging raw error details", async () => {
    const harness = createPendingPeerBridge();
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
  });

  it("discards queued microphone audio when media peer creation fails", async () => {
    const { bridge, connection, peer, rejectPeer, waitForPeerStart, testBridge } =
      createPendingPeerBridge();
    await waitForPeerStart();
    bridge.sendAudio(Buffer.from([0x41, 0x42]));
    rejectPeer(new Error("media peer unavailable"));

    await expect(connection).rejects.toThrow("OpenAI GPT-Live gateway relay failed");
    expect(testBridge.pendingAudio).toHaveLength(0);
    bridge.sendAudio(Buffer.from([0x43, 0x44]));
    expect(testBridge.pendingAudio).toHaveLength(0);
    expect(peer.sendAudio).not.toHaveBeenCalled();
  });

  it.each(["reentrant close", "throw"])(
    "settles the failed peer when onError performs %s",
    async (mode) => {
      const callbackError = new Error("error callback failed");
      const onClose = vi.fn();
      const harness = createPendingPeerBridge({
        onClose,
        onError: () => {
          if (mode === "throw") {
            throw callbackError;
          }
          void harness.bridge.close();
        },
      });
      await harness.waitForPeerStart();
      harness.bridge.sendAudio(Buffer.from([0x41, 0x42]));
      const connectionRejected = expect(harness.connection).rejects.toThrow(
        "OpenAI GPT-Live gateway relay failed",
      );

      const fail = () => harness.triggerPeerError(new Error("media peer failed"));
      if (mode === "throw") {
        expect(fail).toThrow(callbackError);
      } else {
        fail();
      }
      expect(onClose).toHaveBeenCalledExactlyOnceWith("error");
      const retainedAudioBytes = harness.testBridge.pendingAudio.length;
      const closeReason = onClose.mock.calls[0]?.[0];
      await harness.bridge.close();
      harness.resolvePeer();

      await connectionRejected;
      await vi.waitFor(() => expect(harness.peer.close).toHaveBeenCalledOnce());
      expect(retainedAudioBytes).toBe(0);
      expect(closeReason).toBe("error");
      expect(harness.peer.sendAudio).not.toHaveBeenCalled();
    },
  );

  it("closes a sideband that opens in the abort handoff", async () => {
    const controller = new AbortController();
    const socket = new FakeSocket("manual");
    const connection = connectSideband(socket, controller.signal);
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
    const connection = connectSideband(socket, controller.signal, (_url, options) => {
      socketOptions = options;
      return socket;
    });

    expect(socketOptions?.maxPayload).toBe(16 * 1024 * 1024);
    socket.emit("message", Buffer.alloc(512 * 1024), false);
    socket.emit("message", Buffer.alloc(512 * 1024), false);
    socket.emit("message", Buffer.from([0]), false);

    await expect(connection).rejects.toThrow("sideband overflow observed");
    expect(socket).toMatchObject({
      closeCode: 1009,
      closeReason: "sideband startup buffer exceeded",
    });
  });

  it("bounds peer creation and closes a peer that resolves after the deadline", async () => {
    const pending = Promise.withResolvers<OpenAIQuicksilverAudioPeerContract>();
    const closePeer = vi.fn();
    const { bridge } = createBridge({
      createPeer: vi.fn(() => pending.promise),
      connectTimeoutMs: 5,
    });

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
    pending.resolve({ ...createPeer(), close: closePeer });
    await vi.waitFor(() => expect(closePeer).toHaveBeenCalledOnce());
  });

  it("uses released Platform WebRTC, delegates, drops sideband audio, and tears down", async () => {
    const runAgentConsult = Object.assign(
      vi.fn(async () => ({ text: "Delegated result" })),
      { claimAppend: vi.fn(() => true) },
    );
    const handleDelegationInput = vi.fn((text: string): "control" | "consult" =>
      text === "Status?" ? "control" : "consult",
    );
    const { bridge, peer, createSocket, fetchImpl, ...observed } = createBridge({
      model: "gpt-live-1-codex",
      voice: "cove",
      instructions: "Speak briefly.",
      handleDelegationInput,
      runAgentConsult,
      resolveAuth: async () => ({ type: "api-key", token: "test-api-key" }),
    });

    const connection = bridge.connect();
    await vi.waitFor(() => expect(createSocket).toHaveBeenCalledOnce());
    const connectedSocket = createSocket.mock.results[0]!.value;
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
    expect(peer.createOffer).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(peer.applyAnswer).toHaveBeenCalledWith("v=answer\r\n");
    expect(peer.adoptPendingAudio).not.toHaveBeenCalled();
    expect(parseSent(connectedSocket).some((event) => event.type === "session.update")).toBe(false);
    expect(observed.onReady).toHaveBeenCalledOnce();
    bridge.sendUserMessage("Ready for the next task");
    expect(parseSent(connectedSocket)).toEqual([
      {
        type: "session.context.append",
        channel: "speakable",
        content: [{ type: "input_text", text: "Ready for the next task" }],
      },
    ]);

    emitSideband(connectedSocket, { type: "output_audio.delta", audio: "ignored-media-copy" });
    expect(observed.onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "output_audio.delta",
    });
    expect(observed.onAudio).not.toHaveBeenCalled();

    emitSideband(connectedSocket, { type: "output_audio_buffer.cleared" });
    expect(observed.onClearAudio).toHaveBeenCalledWith("barge-in");

    delegate(connectedSocket, "status-control", "Status?");
    expect(handleDelegationInput).toHaveBeenCalledExactlyOnceWith("Status?", expect.any(Function));
    expect(runAgentConsult).not.toHaveBeenCalled();
    expect(connectedSocket.sent).toHaveLength(1);

    delegate(connectedSocket, "delegation-1", "Check the lights");
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
    expect(connectedSocket.sent[1]).toContain("in your own words");

    await bridge.close();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(connectedSocket.closed).toBe(true);
    expect(observed.onClose).toHaveBeenCalledWith("completed");
  });

  it("treats a normal upstream sideband close as completion", async () => {
    const { bridge, createSocket, onClose, onError } = createBridge();

    await bridge.connect();
    const socket = createSocket.mock.results[0]!.value;
    socket.close(1000, "complete");
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith("completed");
  });
});
