import { describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OPENAI_QUICKSILVER_RELAY_FRAME_BYTES } from "./realtime-quicksilver-audio-buffer.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import {
  releaseOpenAIQuicksilverSession,
  reserveOpenAIQuicksilverSession,
} from "./realtime-quicksilver-session-limit.js";
import { emitSideband, FakeSocket, parseSent } from "./realtime-quicksilver.test-helpers.js";

describe("GPT-Live Gateway direct transport", () => {
  it.each(["close", "transport-error"] as const)(
    "paces buffered public microphone audio and silence until %s",
    async (terminal) => {
      let socket: FakeSocket | undefined;
      const onReady = vi.fn();
      const bridge = new OpenAIQuicksilverGatewayBridge(
        {
          providerConfig: {},
          model: "gpt-live-1",
          onAudio: vi.fn(),
          onClearAudio: vi.fn(),
          onReady,
          runAgentConsult: vi.fn(async () => ({ text: "Done" })),
          logger: { debug: vi.fn(), warn: vi.fn() },
          resolveAuth: async () => ({ type: "api-key", token: "test-api-key" }),
          webSocketFactory: () => {
            socket = new FakeSocket();
            return socket;
          },
        },
        openAIRealtimeHost,
      );
      const connection = bridge.connect();
      await vi.waitFor(() => expect(socket?.sent).toHaveLength(1));
      const connectedSocket = socket!;
      const frames = [1, 2].map((value) =>
        Buffer.alloc(OPENAI_QUICKSILVER_RELAY_FRAME_BYTES, value),
      );
      const capture = Buffer.concat([...frames, Buffer.from([3, 4])]);
      bridge.sendAudio(capture);
      capture.fill(0);
      const readAudio = () =>
        parseSent(connectedSocket)
          .filter((event) => event.type === "session.input_audio.append")
          .map((event) => Buffer.from(String(event.audio), "base64"));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const timerNow = performance.now.bind(performance);
      let suspensionMs = 0;
      const now = vi.spyOn(performance, "now").mockImplementation(() => timerNow() + suspensionMs);
      try {
        expect(readAudio()).toEqual([]);
        emitSideband(connectedSocket, { type: "session.started", session: {} });
        await connection;
        expect(bridge.pacesInputAudio).toBe(true);
        expect(onReady).toHaveBeenCalledOnce();
        expect(readAudio()).toEqual([frames[0]]);
        suspensionMs = 5_000;
        await vi.advanceTimersByTimeAsync(20);
        expect(readAudio()).toEqual(frames);
        await vi.advanceTimersByTimeAsync(20);
        const partial = Buffer.alloc(OPENAI_QUICKSILVER_RELAY_FRAME_BYTES);
        partial.set([3, 4]);
        expect(readAudio()).toEqual([...frames, partial]);
        await vi.advanceTimersByTimeAsync(40);
        expect(readAudio()).toEqual([
          ...frames,
          partial,
          Buffer.alloc(OPENAI_QUICKSILVER_RELAY_FRAME_BYTES),
          Buffer.alloc(OPENAI_QUICKSILVER_RELAY_FRAME_BYTES),
        ]);
        if (terminal === "transport-error") {
          connectedSocket.emit("error", new Error("synthetic transport failure"));
        }
        const closing = bridge.close();
        const beforeClose = connectedSocket.sent.length;
        bridge.sendAudio(frames[0]!);
        await vi.advanceTimersByTimeAsync(100);
        expect(connectedSocket.sent).toHaveLength(beforeClose);
        emitSideband(connectedSocket, { type: "session.closed", reason: "close_requested" });
        await closing;
      } finally {
        emitSideband(connectedSocket, { type: "session.closed", reason: "close_requested" });
        await bridge.close();
        now.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("keeps a public provider error authoritative through reentrant transcript cleanup", async () => {
    let socket: FakeSocket | undefined;
    const onClose = vi.fn();
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const createPeer = vi.fn();
    const webSocketFactory = vi.fn(() => {
      socket = new FakeSocket();
      return socket;
    });
    const bridge = new OpenAIQuicksilverGatewayBridge(
      {
        providerConfig: {},
        model: "gpt-live-1",
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        onClose,
        onTranscript: (_role, _text, final) => {
          if (final) {
            void bridge.close();
          }
        },
        runAgentConsult: vi.fn(async () => ({ text: "Done" })),
        logger,
        resolveAuth: async () => ({ type: "api-key", token: "test-api-key" }),
        createPeer,
        webSocketFactory,
      },
      openAIRealtimeHost,
    );
    try {
      const connection = bridge.connect();
      await vi.waitFor(() => expect(socket?.sent).toHaveLength(1));
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
      emitSideband(socket!, {
        type: "session.input_transcript.delta",
        delta: "Received before disconnection.",
        start_ms: 0,
        end_ms: 1_000,
      });
      emitSideband(socket!, { type: "session.closed", reason: "connection_lost" });
      expect(onClose).toHaveBeenCalledExactlyOnceWith("error");
      expect(createPeer).not.toHaveBeenCalled();
      expect(socket?.closed).toBe(true);
      expect(parseSent(socket!).some((event) => event.type === "session.close")).toBe(false);
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
    }
  });

  it.each(["close_requested", "connection_lost", "transport-error"] as const)(
    "keeps public capacity and transcript ownership until finalization: %s",
    async (terminal) => {
      let socket: FakeSocket | undefined;
      const onClose = vi.fn();
      const onTranscript = vi.fn();
      const onAudio = vi.fn();
      const runAgentConsult = vi.fn(async () => ({ text: "must not start" }));
      const logger = { debug: vi.fn(), warn: vi.fn() };
      const bridge = new OpenAIQuicksilverGatewayBridge(
        {
          providerConfig: {},
          model: "gpt-live-1",
          onAudio,
          onClearAudio: vi.fn(),
          onClose,
          onTranscript,
          runAgentConsult,
          logger,
          resolveAuth: async () => ({ type: "api-key", token: "test-api-key" }),
          webSocketFactory: () => {
            socket = new FakeSocket();
            return socket;
          },
        },
        openAIRealtimeHost,
      );
      const reservations = Array.from({ length: 7 }, () => ({}));
      const nextReservation = {};
      let closing: void | Promise<void> = undefined;
      try {
        const connection = bridge.connect();
        await vi.waitFor(() => expect(socket?.sent).toHaveLength(1));
        if (!socket) {
          throw new Error("expected public socket");
        }
        const connectedSocket = socket;
        emitSideband(connectedSocket, { type: "session.started", session: {} });
        await connection;
        for (const reservation of reservations) {
          reserveOpenAIQuicksilverSession(reservation);
        }
        emitSideband(connectedSocket, {
          type: "session.input_transcript.delta",
          delta: "Before close. ",
          start_ms: 0,
          end_ms: 100,
        });
        closing = bridge.close({ disposition: "detach" });
        expect(closing).toBeInstanceOf(Promise);
        expect(bridge.close()).toBe(closing);
        expect(bridge.isConnected()).toBe(false);
        expect(onClose).not.toHaveBeenCalled();
        expect(() => reserveOpenAIQuicksilverSession(nextReservation)).toThrow(
          "Too many concurrent",
        );
        expect(parseSent(connectedSocket)).toContainEqual({ type: "session.close" });
        const sentBeforeLateActions = connectedSocket.sent.length;
        bridge.sendAudio(Buffer.from([0, 1]));
        bridge.sendUserMessage("late action");
        emitSideband(connectedSocket, { type: "session.output_audio.delta", delta: "AAE=" });
        emitSideband(connectedSocket, {
          type: "session.input_transcript.delta",
          delta: "During close.",
          start_ms: 100,
          end_ms: 200,
        });
        emitSideband(connectedSocket, {
          type: "session.delegation.created",
          offset_ms: 200,
          delegation: { id: "item_late", type: "delegation", target: "client" },
        });
        expect(runAgentConsult).not.toHaveBeenCalled();
        expect(onAudio).not.toHaveBeenCalled();
        expect(connectedSocket.sent).toHaveLength(sentBeforeLateActions);
        expect(onClose).not.toHaveBeenCalled();
        if (terminal === "transport-error") {
          connectedSocket.emit("error", new Error("transport finalization failed"));
        } else {
          emitSideband(connectedSocket, { type: "session.closed", reason: terminal });
        }
        if (terminal === "transport-error") {
          await expect(closing).rejects.toThrow("finalization is unconfirmed");
        } else {
          await expect(closing).resolves.toBeUndefined();
        }
        expect(onClose).toHaveBeenCalledExactlyOnceWith(
          terminal === "close_requested" ? "completed" : "error",
        );
        expect(
          onTranscript.mock.calls
            .filter((call) => call[2])
            .map((call) => call[1])
            .join(""),
        ).toBe("Before close. During close.");
        expect(() => reserveOpenAIQuicksilverSession(nextReservation)).not.toThrow();
        const transcriptCount = onTranscript.mock.calls.length;
        emitSideband(connectedSocket, {
          type: "session.input_transcript.delta",
          delta: "after finalization",
          start_ms: 200,
          end_ms: 300,
        });
        expect(onTranscript).toHaveBeenCalledTimes(transcriptCount);
        expect(logger.warn).toHaveBeenCalledTimes(terminal === "transport-error" ? 1 : 0);
      } finally {
        vi.useRealTimers();
        if (socket && !socket.closed) {
          emitSideband(socket, { type: "session.closed", reason: "close_requested" });
        }
        await Promise.allSettled([closing, bridge.close()]);
        for (const reservation of [...reservations, nextReservation]) {
          releaseOpenAIQuicksilverSession(reservation);
        }
      }
    },
  );

  it("waits for provider readiness and bypasses WebRTC allocation", async () => {
    let socket: FakeSocket | undefined;
    const createPeer = vi.fn();
    const fetchImpl = vi.fn();
    const onAudio = vi.fn();
    const onClose = vi.fn();
    const onReady = vi.fn();
    const runAgentConsult = Object.assign(
      vi.fn(async () => ({ text: "Delegated result" })),
      { claimAppend: vi.fn(() => true) },
    );
    const bridge = new OpenAIQuicksilverGatewayBridge(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
        voice: "marin",
        instructions: "Speak briefly.",
        audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        onAudio,
        onClearAudio: vi.fn(),
        onClose,
        onReady,
        runAgentConsult,
        handleDelegationInput: () => "consult",
        logger: { debug: vi.fn(), warn: vi.fn() },
        resolveAuth: vi.fn(async () => ({
          type: "api-key" as const,
          token: "platform-key",
        })),
        createPeer,
        fetchImpl: fetchImpl as typeof fetch,
        webSocketFactory: () => {
          socket = new FakeSocket();
          return socket;
        },
      },
      openAIRealtimeHost,
    );

    try {
      const connection = bridge.connect();
      await vi.waitFor(() => expect(socket?.sent).toHaveLength(1));
      if (!socket) {
        throw new Error("expected direct socket");
      }
      const connectedSocket = socket;
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
      emitSideband(connectedSocket, {
        type: "output_audio.delta",
        audio: "AwQ=",
      });
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
    let socket: FakeSocket | undefined;
    const bridgeRef: { current?: OpenAIQuicksilverGatewayBridge } = {};
    const bridge = new OpenAIQuicksilverGatewayBridge(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
        voice: "marin",
        audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        onReady: () => {
          void bridgeRef.current?.close();
        },
        runAgentConsult: vi.fn(async () => ({ text: "Done" })),
        logger: { debug: vi.fn(), warn: vi.fn() },
        resolveAuth: vi.fn(async () => ({
          type: "api-key" as const,
          token: "platform-key",
        })),
        webSocketFactory: () => {
          socket = new FakeSocket();
          return socket;
        },
      },
      openAIRealtimeHost,
    );
    bridgeRef.current = bridge;

    const connection = bridge.connect();
    await vi.waitFor(() => expect(socket).toBeDefined());
    emitSideband(socket!, { type: "session.started", session: {} });

    await expect(connection).rejects.toThrow("OpenAI GPT-Live gateway relay failed");
    expect(bridge.isConnected()).toBe(false);
  });
});
