import { describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OPENAI_QUICKSILVER_RELAY_FRAME_BYTES } from "./realtime-quicksilver-audio-buffer.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import {
  releaseOpenAIQuicksilverSession,
  reserveOpenAIQuicksilverSession,
} from "./realtime-quicksilver-session-limit.js";
import { fakeQuicksilverMediaSocket } from "./realtime-quicksilver-socket.test-support.js";
import { emitSideband, FakeSocket, parseSent } from "./realtime-quicksilver.test-helpers.js";

type BridgeConfig = ConstructorParameters<typeof OpenAIQuicksilverGatewayBridge>[0];
const canaryConfig = {
  model: "gpt-live-test-canary",
  voice: "marin",
  audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
  resolveAuth: async () => ({ type: "api-key", token: "platform-key" }),
} satisfies Partial<BridgeConfig>;
function readAudio(socket: FakeSocket) {
  return parseSent(socket)
    .filter((event) => event.type === "session.input_audio.append")
    .map((event) => Buffer.from(String(event.audio), "base64"));
}

function createHarness(overrides: Partial<BridgeConfig> = {}) {
  let socket: FakeSocket | undefined;
  const webSocketFactory = vi.fn(() => (socket = new FakeSocket()));
  const callbacks = {
    onAudio: vi.fn(),
    onClose: vi.fn(),
    onReady: vi.fn(),
    onTranscript: vi.fn(),
    logger: { debug: vi.fn(), warn: vi.fn() },
    createPeer: vi.fn(),
    fetchImpl: vi.fn<typeof fetch>(),
  };
  const bridge = new OpenAIQuicksilverGatewayBridge(
    {
      providerConfig: {},
      model: "gpt-live-1",
      onClearAudio: vi.fn(),
      runAgentConsult: vi.fn(async () => ({ text: "Done" })),
      resolveAuth: async () => ({ type: "api-key", token: "test-api-key" }),
      ...callbacks,
      mediaSocketFactory: fakeQuicksilverMediaSocket(webSocketFactory),
      ...overrides,
    },
    openAIRealtimeHost,
  );
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
  it("retains opening and backoff capture until the retry is adopted exactly once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
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
      capture(frames[0]!);
      connecting = bridge.connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(1);
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
      capture(frames[3]!);
      expect(capturedByAttempt).toEqual([[], []]);
      const adopted = sockets[1]!;
      adopted.readyState = 1;
      adopted.emit("open");
      // Readiness can arrive in the open handoff, before the bridge adopts it.
      emitSideband(adopted, { type: "session.started", session: {} });
      await connecting;
      expect(onReady).toHaveBeenCalledOnce();
      expect(capturedByAttempt).toEqual([[], [Buffer.concat(frames.slice(0, 4))]]);
      capture(frames[4]!);
      await vi.advanceTimersByTimeAsync(100);
      expect(readAudio(adopted)).toEqual([...frames, frame()]);
      expect(capturedByAttempt).toEqual([[], [Buffer.concat(frames.slice(0, 4)), frames[4]]]);
      expect(sockets[0]!.sent).toEqual([]);
    } finally {
      const closing = bridge.close();
      for (const socket of sockets) {
        if (!socket.closed) {
          closeReceipt(socket);
        }
      }
      await Promise.allSettled([connecting, closing]);
      vi.useRealTimers();
    }
  });

  it("paces buffered public microphone audio and silence until transport error", async () => {
    const { bridge, start, onReady } = createHarness();
    const { socket: connectedSocket, connection } = await start();
    const frames = [1, 2].map(frame);
    const capture = Buffer.concat([...frames, Buffer.from([3, 4])]);
    bridge.sendAudio(capture);
    capture.fill(0);
    const audio = () => readAudio(connectedSocket);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const timerNow = performance.now.bind(performance);
    let suspensionMs = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => timerNow() + suspensionMs);
    try {
      expect(audio()).toEqual([]);
      emitSideband(connectedSocket, { type: "session.started", session: {} });
      await connection;
      expect(bridge.pacesInputAudio).toBe(true);
      expect(onReady).toHaveBeenCalledOnce();
      expect(audio()).toEqual([frames[0]]);
      suspensionMs = 5_000;
      await vi.advanceTimersByTimeAsync(20);
      expect(audio()).toEqual(frames);
      await vi.advanceTimersByTimeAsync(20);
      const partial = frame();
      partial.set([3, 4]);
      expect(audio()).toEqual([...frames, partial]);
      await vi.advanceTimersByTimeAsync(40);
      expect(audio()).toEqual([...frames, partial, frame(), frame()]);
      connectedSocket.emit("error", new Error("synthetic transport failure"));
      const closing = bridge.close();
      const beforeClose = connectedSocket.sent.length;
      bridge.sendAudio(frames[0]!);
      await vi.advanceTimersByTimeAsync(100);
      expect(connectedSocket.sent).toHaveLength(beforeClose);
      closeReceipt(connectedSocket);
      await expect(closing).rejects.toThrow("finalization is unconfirmed");
    } finally {
      closeReceipt(connectedSocket);
      await Promise.allSettled([bridge.close()]);
      now.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps a public provider error authoritative through reentrant transcript cleanup", async () => {
    const { bridge, start, webSocketFactory, onClose, logger, createPeer } = createHarness({
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
      expect(createPeer).not.toHaveBeenCalled();
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
      expect(parseSent(connectedSocket)[0]).toMatchObject({
        type: "session.update",
        session: {
          audio: { output: { voice: "marin" } },
          delegation: { type: "client", ack_filler: false },
        },
      });
      expect(JSON.stringify(parseSent(connectedSocket)[0])).toContain(
        "Wait for the host control result",
      );
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

      emitSideband(connectedSocket, {
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id: "delegation-direct",
          content: [{ type: "input_text", text: "Check the lights" }],
        },
      });
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
