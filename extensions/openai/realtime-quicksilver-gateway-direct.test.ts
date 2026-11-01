import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { OPENAI_QUICKSILVER_RELAY_FRAME_BYTES } from "./realtime-quicksilver-audio-buffer.js";
import { createBridgeCallbacks } from "./realtime-quicksilver-bridge.test-support.js";
import { delegation } from "./realtime-quicksilver-events.test-support.js";
import {
  createGatewayHarness,
  type GatewayConfig,
} from "./realtime-quicksilver-gateway.test-support.js";
import {
  releaseOpenAIQuicksilverSession,
  reserveOpenAIQuicksilverSession,
} from "./realtime-quicksilver-session-limit.js";
import { fakeQuicksilverMediaSocket } from "./realtime-quicksilver-socket.test-support.js";
import { emitSideband, FakeSocket, parseSent } from "./realtime-quicksilver.test-helpers.js";

const canaryConfig = {
  model: "gpt-live-test-canary",
  voice: "marin",
  audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
  resolveAuth: async () => ({ type: "api-key", token: "platform-key" }),
} satisfies Partial<GatewayConfig>;
function readAudio(socket: FakeSocket) {
  return parseSent(socket)
    .filter((event) => event.type === "session.input_audio.append")
    .map((event) => Buffer.from(String(event.audio), "base64"));
}

function createHarness(overrides: Partial<GatewayConfig> = {}) {
  let socket: FakeSocket | undefined;
  const webSocketFactory = vi.fn(() => (socket = new FakeSocket()));
  const callbacks = {
    ...createBridgeCallbacks(),
    createPeer: vi.fn(),
    fetchImpl: vi.fn<typeof fetch>(),
  };
  const { bridge } = createGatewayHarness({
    ...callbacks,
    mediaSocketFactory: fakeQuicksilverMediaSocket(webSocketFactory),
    ...overrides,
  });
  return {
    ...callbacks,
    bridge,
    webSocketFactory,
    get socket() {
      return socket;
    },
    start: async () => {
      const connection = bridge.connect();
      await vi.waitFor(() => expect(socket?.sent).toHaveLength(1));
      if (!socket) {
        throw new Error("expected direct socket");
      }
      return { socket, connection };
    },
  };
}

function transcript(socket: FakeSocket, delta: string, start_ms: number, end_ms: number) {
  emitSideband(socket, { type: "session.input_transcript.delta", delta, start_ms, end_ms });
}
function closeReceipt(socket: FakeSocket, reason = "close_requested") {
  emitSideband(socket, { type: "session.closed", reason });
}
function frame(value = 0) {
  return Buffer.alloc(OPENAI_QUICKSILVER_RELAY_FRAME_BYTES, value);
}

describe("GPT-Live Gateway direct transport", () => {
  it.each(["open handoff", "after adoption"])(
    "retains capture and binds output only to the adopted retry (%s)",
    async (readiness) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const { port1, port2 } = new MessageChannel();
      const state = new SharedArrayBuffer(4);
      const boundAttempts: number[] = [];
      const sockets: FakeSocket[] = [];
      const capturedByAttempt: Buffer[][] = [];
      const createSocket = fakeQuicksilverMediaSocket(() => {
        const socket = new FakeSocket("manual");
        sockets.push(socket);
        return socket;
      });
      const { bridge, onReady } = createHarness({
        audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        mediaSocketFactory: (...args) => {
          const socket = createSocket(...args);
          const bind = socket.setAudioOutputPort.bind(socket);
          socket.setAudioOutputPort = (output) => {
            boundAttempts.push(sockets.length);
            bind(output);
          };
          const captured: Buffer[] = [];
          capturedByAttempt.push(captured);
          const sendAudio = socket.sendAudio.bind(socket);
          socket.sendAudio = (audio) => {
            captured.push(Buffer.from(audio));
            sendAudio(audio);
          };
          return socket;
        },
      });
      const frames = [1, 2, 3, 4, 5].map(frame);
      const producer = frame();
      const capture = (audio: Buffer) => {
        audio.copy(producer);
        bridge.sendAudio(producer);
        producer.fill(0);
      };
      let connecting: Promise<void> | undefined;
      try {
        bridge.setAudioOutputPort({ port: port1, state });
        capture(frames[0]!);
        connecting = bridge.connect();
        await vi.advanceTimersByTimeAsync(0);
        expect(sockets).toHaveLength(1);
        expect(boundAttempts).toEqual([]);
        capture(frames[1]!);
        expect(capturedByAttempt).toEqual([[]]);

        sockets[0]!.emit("error", new Error("first attempt failed"));
        await vi.advanceTimersByTimeAsync(100);
        expect(sockets[0]!.closed).toBe(true);
        expect(sockets).toHaveLength(1);
        capture(frames[2]!);
        expect(capturedByAttempt).toEqual([[]]);

        await vi.advanceTimersByTimeAsync(100);
        expect(sockets).toHaveLength(2);
        expect(boundAttempts).toEqual([]);
        capture(frames[3]!);
        expect(capturedByAttempt).toEqual([[], []]);
        const adopted = sockets[1]!;
        adopted.readyState = 1;
        adopted.emit("open");
        if (readiness === "after adoption") {
          await vi.advanceTimersByTimeAsync(0);
          expect(adopted.sent).toHaveLength(1);
          expect(boundAttempts).toEqual([2]);
          expect(Atomics.load(new Int32Array(state), 0)).toBe(0);
        }
        // The other row replays readiness buffered in the open handoff.
        emitSideband(adopted, { type: "session.started", session: {} });
        await connecting;
        expect(onReady).toHaveBeenCalledOnce();
        expect(capturedByAttempt).toEqual([[], [Buffer.concat(frames.slice(0, 4))]]);
        capture(frames[4]!);
        await vi.advanceTimersByTimeAsync(100);
        expect(readAudio(adopted)).toEqual([...frames, frame()]);
        expect(capturedByAttempt).toEqual([[], [Buffer.concat(frames.slice(0, 4)), frames[4]]]);
        expect(sockets[0]!.sent).toEqual([]);
        const audio = once(port2, "message");
        emitSideband(adopted, { type: "session.output_audio.delta", delta: "AQE=" });
        expect((await audio)[0]).toEqual({ type: "audio", audio: new Uint8Array([1, 1]) });
        const closing = bridge.close();
        expect(Atomics.load(new Int32Array(state), 0)).toBe(1);
        closeReceipt(adopted);
        await closing;
      } finally {
        const closing = bridge.close();
        for (const socket of sockets) {
          if (!socket.closed) {
            closeReceipt(socket);
          }
        }
        await Promise.allSettled([connecting, closing]);
        port1.close();
        port2.close();
        vi.useRealTimers();
      }
    },
  );

  it("stops public microphone audio on transport error and rejects unconfirmed finalization", async () => {
    const { bridge, start } = createHarness();
    const { socket: connectedSocket, connection } = await start();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      emitSideband(connectedSocket, { type: "session.started", session: {} });
      await connection;
      connectedSocket.emit("error", new Error("synthetic transport failure"));
      const closing = bridge.close();
      const beforeClose = connectedSocket.sent.length;
      bridge.sendAudio(frame(1));
      await vi.advanceTimersByTimeAsync(100);
      expect(connectedSocket.sent).toHaveLength(beforeClose);
      closeReceipt(connectedSocket);
      await expect(closing).rejects.toThrow("finalization is unconfirmed");
    } finally {
      closeReceipt(connectedSocket);
      await Promise.allSettled([bridge.close()]);
      vi.useRealTimers();
    }
  });

  it("keeps a public provider error authoritative through reentrant transcript cleanup", async () => {
    const { bridge, start, webSocketFactory, onClose, logger } = createHarness({
      onTranscript: (_role, _text, final) => {
        if (final) {
          void bridge.close();
        }
      },
    });
    try {
      const { socket, connection } = await start();
      expect(webSocketFactory).toHaveBeenCalledWith(
        "wss://api.openai.com/v1/live/sessions",
        expect.any(Object),
      );
      expect(parseSent(socket!)[0]).toMatchObject({
        type: "session.start",
        session: { model: "gpt-live-1", delegation: { type: "client" } },
      });
      emitSideband(socket!, { type: "session.started", session: {} });
      await connection;
      transcript(socket, "Received before disconnection.", 0, 1_000);
      closeReceipt(socket, "connection_lost");
      expect(onClose).toHaveBeenCalledExactlyOnceWith("error");
      expect(socket?.closed).toBe(true);
      expect(parseSent(socket!).some((event) => event.type === "session.close")).toBe(false);
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
    }
  });

  it("keeps public capacity and transcript ownership until connection-lost finalization", async () => {
    const runAgentConsult = vi.fn(async () => ({ text: "must not start" }));
    const harness = createHarness({ runAgentConsult });
    const { bridge, start, onAudio, onClose, onTranscript, logger } = harness;
    const reservations = Array.from({ length: 7 }, () => ({}));
    const nextReservation = {};
    let closing: void | Promise<void> = undefined;
    try {
      const { socket: connectedSocket, connection } = await start();
      emitSideband(connectedSocket, { type: "session.started", session: {} });
      await connection;
      for (const reservation of reservations) {
        reserveOpenAIQuicksilverSession(reservation);
      }
      transcript(connectedSocket, "Before close. ", 0, 100);
      closing = bridge.close({ disposition: "detach" });
      expect(closing).toBeInstanceOf(Promise);
      expect(bridge.close()).toBe(closing);
      expect(bridge.isConnected()).toBe(false);
      expect(onClose).not.toHaveBeenCalled();
      expect(() => reserveOpenAIQuicksilverSession(nextReservation)).toThrow("Too many concurrent");
      expect(parseSent(connectedSocket)).toContainEqual({ type: "session.close" });
      const sentBeforeLateActions = connectedSocket.sent.length;
      bridge.sendAudio(Buffer.from([0, 1]));
      bridge.sendUserMessage("late action");
      emitSideband(connectedSocket, { type: "session.output_audio.delta", delta: "AAE=" });
      transcript(connectedSocket, "During close.", 100, 200);
      emitSideband(connectedSocket, {
        type: "session.delegation.created",
        offset_ms: 200,
        delegation: { id: "item_late", type: "delegation", target: "client" },
      });
      expect(runAgentConsult).not.toHaveBeenCalled();
      expect(onAudio).not.toHaveBeenCalled();
      expect(connectedSocket.sent).toHaveLength(sentBeforeLateActions);
      expect(onClose).not.toHaveBeenCalled();
      closeReceipt(connectedSocket, "connection_lost");
      await expect(closing).resolves.toBeUndefined();
      expect(onClose).toHaveBeenCalledExactlyOnceWith("error");
      expect(
        onTranscript.mock.calls.flatMap(([, text, final]) => (final ? [text] : [])).join(""),
      ).toBe("Before close. During close.");
      expect(() => reserveOpenAIQuicksilverSession(nextReservation)).not.toThrow();
      const transcriptCount = onTranscript.mock.calls.length;
      transcript(connectedSocket, "after finalization", 200, 300);
      expect(onTranscript).toHaveBeenCalledTimes(transcriptCount);
      expect(logger.warn).toHaveBeenCalledTimes(0);
    } finally {
      vi.useRealTimers();
      const socket = harness.socket;
      if (socket && !socket.closed) {
        closeReceipt(socket);
      }
      await Promise.allSettled([closing, bridge.close()]);
      for (const reservation of [...reservations, nextReservation]) {
        releaseOpenAIQuicksilverSession(reservation);
      }
    }
  });

  it("waits for provider readiness and bypasses WebRTC allocation", async () => {
    const runAgentConsult = Object.assign(
      vi.fn(async () => ({ text: "Delegated result" })),
      { claimAppend: vi.fn(() => true) },
    );
    const { bridge, start, onAudio, onClose, onReady, createPeer, fetchImpl } = createHarness({
      ...canaryConfig,
      instructions: "Speak briefly.",
      runAgentConsult,
      handleDelegationInput: () => "consult",
    });

    try {
      const { socket: connectedSocket, connection } = await start();
      expect(onReady).not.toHaveBeenCalled();
      expect(createPeer).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();

      bridge.sendAudio(Buffer.from([0x01, 0x02]));
      vi.useFakeTimers();
      // Keep the second-granularity expiry a full second away during delegation.
      vi.setSystemTime(new Date("2026-09-12T00:00:00Z"));
      emitSideband(connectedSocket, {
        type: "session.started",
        session: { expires_at: Math.floor(Date.now() / 1000) + 1 },
      });
      await connection;

      expect(onReady).toHaveBeenCalledOnce();
      expect(parseSent(connectedSocket)).toContainEqual({
        type: "input_audio.append",
        audio: Buffer.concat([Buffer.from([0x01, 0x02]), Buffer.alloc(958)]).toString("base64"),
      });
      emitSideband(connectedSocket, { type: "output_audio.delta", audio: "AwQ=" });
      expect(onAudio).toHaveBeenCalledExactlyOnceWith(Buffer.from([0x03, 0x04]));

      emitSideband(connectedSocket, delegation("delegation-direct", "Check the lights"));
      await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(
          parseSent(connectedSocket).filter((event) => event.type === "delegation.context.append"),
        ).toHaveLength(1),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onClose).toHaveBeenCalledExactlyOnceWith("completed");
    } finally {
      vi.useRealTimers();
      await bridge.close();
    }
  });

  it("rejects startup when onReady closes the bridge reentrantly", async () => {
    const { bridge, start } = createHarness({
      ...canaryConfig,
      onReady: () => void bridge.close(),
    });

    const { socket, connection } = await start();
    emitSideband(socket!, { type: "session.started", session: {} });

    await expect(connection).rejects.toThrow("OpenAI GPT-Live gateway relay failed");
    expect(bridge.isConnected()).toBe(false);
  });
});
