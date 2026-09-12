import { describe, expect, it, vi } from "vitest";

const { captureWsEventMock, webSocketConstructorMock } = vi.hoisted(() => ({
  captureWsEventMock: vi.fn(),
  webSocketConstructorMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/proxy-capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/proxy-capture")>();
  return { ...actual, captureWsEvent: captureWsEventMock };
});

vi.mock("ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ws")>();
  return { ...actual, default: webSocketConstructorMock };
});

import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverVoiceBridge } from "./realtime-quicksilver-bridge.js";
import {
  createHarness,
  FakeSocket,
  sentEvents,
} from "./realtime-quicksilver-bridge.test-support.js";

describe("OpenAIQuicksilverVoiceBridge", () => {
  it("connects directly to /v1/live and completes the Frameless Bidi handshake", async () => {
    const harness = createHarness();
    await harness.bridge.connect();

    expect(harness.connections).toHaveLength(1);
    expect(harness.connections[0]?.url).toBe(
      "wss://api.openai.com/v1/live?model=gpt-live-test-canary",
    );
    expect(harness.connections[0]?.options.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "OpenAI-Alpha": "quicksilver=v2",
    });
    expect(sentEvents(harness.socket)[0]).toEqual({
      type: "session.update",
      session: {
        instructions: "Use delegation for real work.",
        audio: { output: { voice: "marin" } },
        delegation: { type: "client" },
      },
    });
    expect(harness.bridge.isConnected()).toBe(true);
    expect(harness.bridge.handlesInputAudioBargeIn).toBe(false);
    expect(harness.onReady).toHaveBeenCalledOnce();

    void harness.bridge.close();
    await vi.waitFor(() => expect(harness.onClose).toHaveBeenCalledWith("completed"));
  });

  it("streams the public Live protocol and delegates from user context through graceful close", async () => {
    const harness = createHarness({ model: "gpt-live-1" });
    await harness.bridge.connect();
    harness.bridge.sendUserMessage("The kitchen lights are on.");
    const speechRequest = sentEvents(harness.socket).at(-1);
    harness.bridge.submitToolResult("quiet-background", "Unspoken background.", {
      suppressResponse: true,
    });
    const suppressedResult = sentEvents(harness.socket).at(-1);
    const audio = Buffer.from([0, 1, 2, 3]);
    harness.bridge.sendAudio(audio);
    expect(sentEvents(harness.socket)).toContainEqual({
      type: "session.input_audio.append",
      audio: audio.toString("base64"),
    });
    harness.socket.serverEvent({
      type: "session.output_audio.delta",
      delta: audio.toString("base64"),
    });
    expect(harness.onAudio).toHaveBeenCalledWith(audio);
    harness.socket.serverEvent({
      type: "session.input_transcript.delta",
      delta: "Find a train.",
      start_ms: 0,
      end_ms: 500,
    });
    harness.socket.serverEvent({
      type: "session.output_transcript.delta",
      delta: "I can help.",
      start_ms: 400,
      end_ms: 600,
    });
    harness.socket.serverEvent({
      type: "session.delegation.created",
      offset_ms: 600,
      delegation: { id: "item_live", type: "delegation", target: "client" },
    });
    expect(harness.onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: "item_live",
        args: { question: expect.stringContaining("<input>Find a train.</input>") },
      }),
    );
    expect(harness.onTranscript).toHaveBeenCalledWith("assistant", "I can help.", false);
    expect(harness.onTranscript).toHaveBeenCalledWith("assistant", "I can help.", true);
    expect(harness.onTranscript).toHaveBeenCalledWith("user", "Find a train.", true);
    expect(harness.onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "response.done" }),
    );
    harness.bridge.submitToolResult("item_live", "Still checking.", { willContinue: true });
    harness.bridge.submitToolResult("item_live", "The train leaves at noon.");
    expect(sentEvents(harness.socket)).toContainEqual({
      type: "session.thinking.append",
      delegation_id: "item_live",
      content: "Still checking.",
    });
    expect(sentEvents(harness.socket)).toContainEqual({
      type: "session.commentary.append",
      delegation_id: "item_live",
      content: "The train leaves at noon.",
    });
    const longAnswer = "The journey is scenic. ".repeat(800);
    harness.socket.serverEvent({
      type: "session.output_transcript.delta",
      delta: longAnswer,
      start_ms: 600,
      end_ms: 700,
    });
    harness.socket.serverEvent({
      type: "session.output_transcript.delta",
      delta: "Goodbye.",
      start_ms: 700,
      end_ms: 900,
    });
    const closing = harness.bridge.close();
    expect(closing).toBeInstanceOf(Promise);
    expect(harness.bridge.close()).toBe(closing);
    const snapshots = harness.onTranscript.mock.calls.filter((call) => call[2]);
    expect(snapshots.filter(([role]) => role === "user")).toEqual([
      ["user", "Find a train.", true],
    ]);
    expect(
      snapshots
        .filter(([role]) => role === "assistant")
        .map(([, text]) => text)
        .join(""),
    ).toBe("I can help." + longAnswer + "Goodbye.");
    expect(harness.bridge.isConnected()).toBe(false);
    expect(harness.socket.closeCalls).toBe(0);
    expect(
      sentEvents(harness.socket).filter((event) => event.type === "session.close"),
    ).toHaveLength(1);
    const sentBeforeLateResult = harness.socket.sent.length;
    harness.bridge.submitToolResult("item_live", "Late result");
    expect(harness.socket.sent).toHaveLength(sentBeforeLateResult);
    harness.socket.serverEvent({
      type: "session.output_transcript.delta",
      delta: "Trailing speech.",
      start_ms: 900,
      end_ms: 1000,
    });
    expect(harness.onClose).not.toHaveBeenCalled();
    harness.socket.serverEvent({
      type: "session.closed",
      reason: "close_requested",
      session: { id: "live_1" },
      usage: {},
    });
    await closing;
    expect(harness.socket.closeCalls).toBe(1);
    expect(harness.onTranscript).toHaveBeenLastCalledWith("assistant", "Trailing speech.", true);
    expect(harness.onClose).toHaveBeenCalledExactlyOnceWith("completed");
    expect(speechRequest).toEqual({
      type: "session.commentary.append",
      delegation_id: null,
      content: "The kitchen lights are on.",
    });
    expect(suppressedResult).toEqual({
      type: "session.thinking.append",
      delegation_id: null,
      content: "Unspoken background.",
    });
  });

  it("classifies the retained public user request before consuming snapshots", async () => {
    const order: string[] = [];
    const handleDelegationInput = vi.fn((input: string) => {
      order.push(`classify:${input}`);
      if (input === "status") {
        return "control" as const;
      }
      void harness.bridge.close();
      return "consult" as const;
    });
    const harness = createHarness({ model: "gpt-live-1", handleDelegationInput });
    await harness.bridge.connect();
    harness.onTranscript.mockImplementation((_role, _text, final) => {
      if (final) {
        order.push("snapshot");
      }
    });
    const transcript = (role: "input" | "output", delta: string) =>
      harness.socket.serverEvent({
        type: `session.${role}_transcript.delta`,
        delta,
        start_ms: 0,
        end_ms: 100,
      });
    const delegate = (id: string) =>
      harness.socket.serverEvent({
        type: "session.delegation.created",
        offset_ms: 100,
        delegation: { type: "delegation", target: "client", id },
      });
    transcript("input", "status");
    delegate("item_status");
    expect(order).toEqual(["classify:status"]);
    transcript("input", "Check my flight.");
    transcript("output", "Background speech. ".repeat(1_000));
    order.length = 0;
    delegate("item_flight");
    expect(order[0]).toBe("classify:Check my flight.");
    expect(order.length).toBeGreaterThan(1);
    expect(order.slice(1).every((entry) => entry === "snapshot")).toBe(true);
    expect(harness.onToolCall).not.toHaveBeenCalled();
    harness.socket.serverEvent({ type: "session.closed", reason: "close_requested" });
    await harness.bridge.close();
  });

  it.each(["local-close", "delegation"])(
    "saves the entire %s batch when a snapshot callback closes",
    async (boundary) => {
      const harness = createHarness({ model: "gpt-live-1" });
      await harness.bridge.connect();
      harness.onTranscript.mockImplementation((_role, _text, final) => {
        if (final) {
          void harness.bridge.close();
        }
      });
      harness.socket.serverEvent({
        type: "session.input_transcript.delta",
        delta: "My question.",
        start_ms: 0,
        end_ms: 100,
      });
      harness.socket.serverEvent({
        type: "session.output_transcript.delta",
        delta: "The answer.",
        start_ms: 100,
        end_ms: 200,
      });
      if (boundary === "delegation") {
        harness.socket.serverEvent({
          type: "session.delegation.created",
          offset_ms: 200,
          delegation: { type: "delegation", target: "client", id: "item_close" },
        });
      } else {
        void harness.bridge.close();
      }
      expect(harness.onToolCall).not.toHaveBeenCalled();
      expect(harness.onTranscript.mock.calls.filter((call) => call[2])).toEqual([
        ["user", "My question.", true],
        ["assistant", "The answer.", true],
      ]);
      await vi.waitFor(() =>
        expect(
          sentEvents(harness.socket).filter((event) => event.type === "session.close"),
        ).toHaveLength(1),
      );
      harness.socket.serverEvent({
        type: "session.closed",
        reason: "close_requested",
        session: { id: "live_1" },
        usage: {},
      });
      await vi.waitFor(() => expect(harness.onClose).toHaveBeenCalledExactlyOnceWith("completed"));
      expect(harness.logger.warn).not.toHaveBeenCalled();
    },
  );

  it.each(["close_requested", "content", "transport-error"] as const)(
    "keeps cleanup completion when snapshot publication throws (terminal=%s)",
    async (terminal) => {
      const harness = createHarness({ model: "gpt-live-1" });
      await harness.bridge.connect();
      const publicationError = new Error("snapshot consumer failed");
      let rejectNextFinal = true;
      let reentrantCompletion: void | Promise<void> = undefined;
      harness.onTranscript.mockImplementation((_role, _text, final) => {
        if (final && rejectNextFinal) {
          rejectNextFinal = false;
          reentrantCompletion = harness.bridge.close();
          throw publicationError;
        }
      });
      try {
        harness.socket.serverEvent({
          type: "session.input_transcript.delta",
          delta: "Received speech.",
          start_ms: 0,
          end_ms: 100,
        });
        let closing: void | Promise<void> = undefined;
        expect(() => {
          closing = harness.bridge.close();
        }).not.toThrow();
        expect(closing).toBeInstanceOf(Promise);
        expect(reentrantCompletion).toBe(closing);
        expect(harness.bridge.close()).toBe(closing);
        let settled = false;
        void Promise.resolve(closing).then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(harness.onClose).not.toHaveBeenCalled();
        expect(harness.socket.closeCalls).toBe(0);
        harness.socket.serverEvent({
          type: "session.output_transcript.delta",
          delta: "Trailing speech.",
          start_ms: 100,
          end_ms: 200,
        });
        if (terminal === "transport-error") {
          harness.socket.emit("error", new Error("transport ended"));
        } else {
          harness.socket.serverEvent({ type: "session.closed", reason: terminal });
        }
        await expect(closing).rejects.toBe(publicationError);
        expect(harness.onTranscript).toHaveBeenLastCalledWith(
          "assistant",
          "Trailing speech.",
          true,
        );
        expect(harness.onClose).toHaveBeenCalledExactlyOnceWith(
          terminal === "close_requested" ? "completed" : "error",
        );
        expect(harness.socket.closeCalls).toBe(1);
        expect(harness.logger.warn).toHaveBeenCalledOnce();
      } finally {
        if (harness.socket.readyState !== 3) {
          harness.socket.serverEvent({ type: "session.closed", reason: "close_requested" });
        }
        await Promise.allSettled([harness.bridge.close()]);
      }
    },
  );

  it.each([
    ["content", false],
    ["connection_lost", false],
    ["content", true],
    ["connection_lost", true],
  ] as const)(
    "keeps remote %s outcome through snapshot callbacks (locally closing: %s)",
    async (reason, locallyClosing) => {
      const harness = createHarness({ model: "gpt-live-1" });
      await harness.bridge.connect();
      harness.onTranscript.mockImplementation((_role, _text, final) => {
        if (final) {
          void harness.bridge.close();
        }
      });
      harness.socket.serverEvent({
        type: "session.output_transcript.delta",
        delta: "Received speech.",
        start_ms: 0,
        end_ms: 100,
      });
      const closing = locallyClosing ? harness.bridge.close() : undefined;
      if (locallyClosing) {
        await vi.waitFor(() =>
          expect(sentEvents(harness.socket)).toContainEqual({ type: "session.close" }),
        );
      }
      harness.socket.serverEvent({
        type: "session.closed",
        reason,
        session: { id: "live_1" },
        usage: {},
      });
      await closing;
      await Promise.resolve();
      expect(harness.onTranscript.mock.calls.filter((call) => call[2])).toEqual([
        ["assistant", "Received speech.", true],
      ]);
      expect(harness.onClose).toHaveBeenCalledExactlyOnceWith("error");
      expect(sentEvents(harness.socket).filter((event) => event.type === "session.close")).toEqual(
        locallyClosing ? [{ type: "session.close" }] : [],
      );
      expect(harness.socket.closeCalls).toBe(1);
      expect(harness.logger.warn).not.toHaveBeenCalled();
    },
  );

  it("bounds public close finalization and reports missing session.closed", async () => {
    const harness = createHarness({ model: "gpt-live-1" });
    await harness.bridge.connect();
    vi.useFakeTimers();
    try {
      const closing = harness.bridge.close();
      const rejected = expect(closing).rejects.toThrow("finalization is unconfirmed");
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
      expect(harness.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("cleanup INCOMPLETE"),
      );
      expect(harness.logger.warn).toHaveBeenCalledOnce();
      expect(harness.onClose).toHaveBeenCalledExactlyOnceWith("error");
      expect(harness.socket.closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps repeated close idempotent while the transport is still open", async () => {
    const harness = createHarness({ deferClose: true });
    await harness.bridge.connect();

    void harness.bridge.close();
    void harness.bridge.close();

    expect(
      sentEvents(harness.socket).filter((event) => event.type === "session.close"),
    ).toHaveLength(1);
    expect(harness.socket.closeCalls).toBe(1);
    expect(harness.onClose).toHaveBeenCalledOnce();
    expect(harness.onClose).toHaveBeenCalledWith("completed");

    harness.socket.finishClose();
    await Promise.resolve();
    expect(harness.onClose).toHaveBeenCalledOnce();
  });

  it("shares an in-flight connection until session readiness", async () => {
    const harness = createHarness({ autoStart: false });
    const firstConnect = harness.bridge.connect();
    const secondConnect = harness.bridge.connect();
    await vi.waitFor(() => expect(harness.socket.readyState).toBe(1));

    expect(harness.connections).toHaveLength(1);
    harness.socket.serverEvent({
      type: "session.started",
      session: { id: "live-1", expires_at: Math.floor(Date.now() / 1000) + 60 },
    });

    await Promise.all([firstConnect, secondConnect]);
    expect(harness.onReady).toHaveBeenCalledOnce();
  });

  it.each([
    [1000, "completed"],
    [1006, "error"],
  ] as const)("classifies an established session closing with code %s", async (code, reason) => {
    const harness = createHarness();
    await harness.bridge.connect();

    harness.socket.finishClose(code);
    await Promise.resolve();

    expect(harness.onClose).toHaveBeenCalledExactlyOnceWith(reason);
    expect(harness.bridge.isConnected()).toBe(false);
  });

  it("bounds queued audio by aggregate bytes before session readiness", async () => {
    const harness = createHarness({ autoStart: false });
    const connecting = harness.bridge.connect();
    await vi.waitFor(() => expect(harness.socket.readyState).toBe(1));

    harness.bridge.sendAudio(Buffer.alloc(512 * 1024, 0x01));
    harness.bridge.sendAudio(Buffer.alloc(512 * 1024, 0x02));
    harness.bridge.sendAudio(Buffer.from("overflow"));
    harness.socket.serverEvent({
      type: "session.started",
      session: { id: "live-1", expires_at: Math.floor(Date.now() / 1000) + 60 },
    });
    await connecting;

    const audioEvents = sentEvents(harness.socket).filter(
      (event) => event.type === "input_audio.append",
    );
    expect(audioEvents).toHaveLength(2);
    expect(
      audioEvents.map((event) => Buffer.from(String(event.audio), "base64").byteLength),
    ).toEqual([512 * 1024, Buffer.byteLength("overflow")]);
    expect(harness.logger.warn).toHaveBeenCalledOnce();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      "OpenAI GPT-Live input audio queue overflow; keeping newest audio",
    );
    void harness.bridge.close();
  });

  it("discards audio closed before the first connection and reconnects fresh", async () => {
    const harness = createHarness();

    harness.bridge.sendAudio(Buffer.from("queued-before-connect"));
    void harness.bridge.close();
    void harness.bridge.close();
    harness.bridge.sendAudio(Buffer.from("sent-after-close"));

    expect(harness.connections).toHaveLength(0);
    expect(harness.onClose).not.toHaveBeenCalled();

    await harness.bridge.connect();

    expect(
      sentEvents(harness.socket).filter((event) => event.type === "input_audio.append"),
    ).toHaveLength(0);

    void harness.bridge.close();
    expect(harness.onClose).toHaveBeenCalledOnce();
    expect(harness.onClose).toHaveBeenCalledWith("completed");
  });

  it("does not carry queued audio across terminal close and explicit reconnect", async () => {
    const sockets: FakeSocket[] = [];
    const bridge = new OpenAIQuicksilverVoiceBridge(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
        audioFormat: { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
        resolveAuth: async () => ({ type: "api-key", token: "test-key" }),
        webSocketFactory: (_url, _options) => {
          const socket = new FakeSocket(false);
          sockets.push(socket);
          queueMicrotask(() => socket.open());
          return socket;
        },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
      },
      openAIRealtimeHost,
    );

    const firstConnect = bridge.connect();
    await vi.waitFor(() => expect(sockets[0]?.readyState).toBe(1));
    bridge.sendAudio(Buffer.from("queued-before-close"));
    void bridge.close();
    await firstConnect;
    bridge.sendAudio(Buffer.from("sent-after-close"));

    const reconnecting = bridge.connect();
    await vi.waitFor(() => expect(sockets[1]?.readyState).toBe(1));
    sockets[1]?.serverEvent({
      type: "session.started",
      session: { id: "live-2", expires_at: Math.floor(Date.now() / 1000) + 60 },
    });
    await reconnecting;

    const secondSocket = sockets[1];
    if (!secondSocket) {
      throw new Error("expected bridge to reconnect");
    }
    expect(
      sentEvents(secondSocket).filter((event) => event.type === "input_audio.append"),
    ).toHaveLength(0);
    void bridge.close();
  });

  it("rejects startup failures without emitting terminal callbacks", async () => {
    const harness = createHarness({ autoStart: false });
    const connecting = harness.bridge.connect();
    await vi.waitFor(() => expect(harness.socket.readyState).toBe(1));

    harness.socket.serverEvent({
      type: "error",
      error: { message: "invalid live session" },
    });

    await expect(connecting).rejects.toThrow("OpenAI GPT-Live transport failed");
    expect(harness.onError).not.toHaveBeenCalled();
    expect(harness.onClose).not.toHaveBeenCalled();
    expect(harness.bridge.isConnected()).toBe(false);
  });

  it("does not reject after explicit close while awaiting session readiness", async () => {
    const harness = createHarness({ autoStart: false, deferClose: true });
    const connecting = harness.bridge.connect();
    await vi.waitFor(() => expect(harness.socket.readyState).toBe(1));

    void harness.bridge.close();
    harness.socket.emit("error", new Error("late startup error"));

    await expect(connecting).resolves.toBeUndefined();
    expect(harness.onClose).toHaveBeenCalledOnce();
    expect(harness.onClose).toHaveBeenCalledWith("completed");
    expect(harness.onError).not.toHaveBeenCalled();
    harness.socket.finishClose();
  });

  it("completes once when closed while authentication is pending", async () => {
    let resolveAuth!: (auth: { type: "api-key"; token: string }) => void;
    const harness = createHarness({
      resolveAuth: () =>
        new Promise((resolve) => {
          resolveAuth = resolve;
        }),
    });
    const connecting = harness.bridge.connect();

    void harness.bridge.close();
    void harness.bridge.close();
    expect(harness.onClose).toHaveBeenCalledOnce();
    expect(harness.onClose).toHaveBeenCalledWith("completed");

    resolveAuth({ type: "api-key", token: "test-key" });
    await expect(connecting).resolves.toBeUndefined();
    expect(harness.connections).toHaveLength(0);
    expect(harness.onError).not.toHaveBeenCalled();
  });

  it.each([
    ["gpt-live-test-canary", 1000, "completed"],
    ["gpt-live-test-canary", 1006, "error"],
    ["gpt-live-1", 1000, "error"],
    ["gpt-live-1", 1006, "error"],
  ] as const)(
    "classifies a buffered %s close after readiness with code %s",
    async (model, code, reason) => {
      const harness = createHarness({
        model,
        autoStart: false,
        afterOpen: (socket) => {
          socket.serverEvent({
            type: "session.started",
            session: { id: "live-1", expires_at: Math.floor(Date.now() / 1000) + 60 },
          });
          socket.finishClose(code);
        },
      });

      await harness.bridge.connect();

      expect(harness.onReady).toHaveBeenCalledOnce();
      if (reason === "error") {
        expect(harness.onError).toHaveBeenCalledOnce();
        expect(harness.onError.mock.calls[0]?.[0]).toMatchObject({
          message: "OpenAI GPT-Live transport failed",
          name: "Error",
        });
      } else {
        expect(harness.onError).not.toHaveBeenCalled();
      }
      expect(harness.onClose).toHaveBeenCalledExactlyOnceWith(reason);
      expect(harness.bridge.isConnected()).toBe(false);
    },
  );

  it("maps audio, transcripts, and delegations onto the shared bridge contract", async () => {
    const harness = createHarness();
    await harness.bridge.connect();
    harness.socket.serverEvent({
      type: "output_audio.delta",
      audio: Buffer.from([1, 2, 3, 4]).toString("base64"),
    });
    harness.socket.serverEvent({ type: "output_audio_buffer.cleared" });
    harness.socket.serverEvent({
      type: "input_transcript.added",
      item: { text: "hello" },
    });
    harness.socket.serverEvent({
      type: "turn.done",
      turn: { role: "user", transcript: "hello there" },
    });
    harness.socket.serverEvent({
      type: "delegation.created",
      item: {
        type: "delegation",
        target: "client",
        id: "delegation-1",
        content: [{ type: "input_text", text: "check the repository" }],
      },
    });

    expect(harness.onAudio).toHaveBeenCalledWith(Buffer.from([1, 2, 3, 4]));
    expect(harness.onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "output_audio_buffer.cleared",
    });
    expect(harness.onClearAudio).toHaveBeenCalledExactlyOnceWith("barge-in");
    expect(harness.onTranscript).toHaveBeenNthCalledWith(1, "user", "hello", false);
    expect(harness.onTranscript).toHaveBeenNthCalledWith(2, "user", "hello there", true);
    expect(harness.onToolCall).toHaveBeenCalledWith({
      itemId: "delegation-1",
      callId: "delegation-1",
      name: "openclaw_agent_consult",
      args: { question: "check the repository" },
    });

    harness.bridge.submitToolResult("delegation-1", { text: "The repository is clean." });
    expect(sentEvents(harness.socket).at(-1)).toEqual({
      type: "delegation.context.append",
      delegation_item_id: "delegation-1",
      channel: "speakable",
      content: [{ type: "input_text", text: "The repository is clean." }],
    });
  });

  it("redacts the opaque model from direct provider errors", async () => {
    const model = "gpt-live-test-canary";
    const sensitiveDetails = ["sensitive-route", "sensitive-session", "sensitive-transcript"];
    const harness = createHarness();
    await harness.bridge.connect();
    harness.socket.serverEvent({
      type: "error",
      error: {
        message: `provider rejected ${model} ${sensitiveDetails.join(" ")}`,
        code: "invalid_api_key",
      },
    });

    expect(harness.onError).toHaveBeenCalledOnce();
    const projectedError = harness.onError.mock.calls[0]?.[0];
    expect(projectedError).toBeInstanceOf(Error);
    expect(projectedError?.name).toBe("Error");
    expect(projectedError?.message).toBe("OpenAI GPT-Live transport failed");
    expect(projectedError?.cause).toBeUndefined();
    const projected = JSON.stringify({
      events: harness.onEvent.mock.calls,
    });
    for (const privateValue of [model, ...sensitiveDetails]) {
      expect(projected).not.toContain(privateValue);
    }
  });

  it("redacts raw startup and active transport errors", async () => {
    const model = "sensitive-model-marker";
    const sensitiveDetails = ["sensitive-route", "sensitive-session", "sensitive-transcript"];
    const startup = createHarness({
      autoStart: false,
      model,
      afterOpen: (socket) => {
        const error = new Error(`startup rejected ${model} ${sensitiveDetails.join(" ")}`);
        error.name = `Transport${model}`;
        socket.emit("error", error);
      },
    });

    const startupError = await startup.bridge.connect().catch((error: unknown) => error);
    expect(startupError).toBeInstanceOf(Error);
    expect(startupError).toMatchObject({
      message: "OpenAI GPT-Live transport failed",
      name: "Error",
    });

    const active = createHarness({ model });
    await active.bridge.connect();
    const error = new Error(`active transport failed ${model}`);
    error.name = `Socket${model}`;
    active.socket.emit("error", error);

    expect(active.onError).toHaveBeenCalledOnce();
    const activeError = active.onError.mock.calls[0]?.[0] as Error;
    expect(activeError).toBeInstanceOf(Error);
    expect(activeError).toMatchObject({
      message: "OpenAI GPT-Live transport failed",
      name: "Error",
    });
  });

  it("captures only fixed metadata for private transport activity", async () => {
    captureWsEventMock.mockClear();
    const model = "sensitive-model-marker";
    const transcript = "sensitive-frame-marker";
    const harness = createHarness({ model, mockDefaultSocket: webSocketConstructorMock });

    await harness.bridge.connect();
    harness.bridge.sendUserMessage(transcript);
    harness.socket.serverEvent({
      type: "turn.done",
      turn: { role: "user", transcript },
    });

    expect(harness.connections[0]?.options).not.toHaveProperty("agent");
    expect(captureWsEventMock).toHaveBeenCalled();
    const captureCalls = captureWsEventMock.mock.calls as Array<[Record<string, unknown>]>;
    for (const [event] of captureCalls) {
      expect(event).toEqual({
        url: "wss://realtime.invalid/private",
        direction: expect.stringMatching(/^(inbound|outbound|local)$/),
        kind: expect.stringMatching(/^ws-(frame|open)$/),
        flowId: "private-realtime",
        meta: { provider: "openai", capability: "gpt-live-voice" },
      });
    }
    const captured = JSON.stringify(captureCalls);
    expect(captured).not.toContain(model);
    expect(captured).not.toContain(transcript);
  });

  it("bounds direct tool results before sideband sends", async () => {
    const harness = createHarness();
    await harness.bridge.connect();

    harness.socket.serverEvent({
      type: "delegation.created",
      item: {
        type: "delegation",
        target: "client",
        id: "delegation-large",
        content: [{ type: "input_text", text: "summarize everything" }],
      },
    });
    harness.bridge.submitToolResult("delegation-large", { text: "x".repeat(10_000) });

    const appends = sentEvents(harness.socket).filter(
      (event) => event.type === "delegation.context.append",
    );
    expect(appends.length).toBeGreaterThan(0);
    expect(appends.length).toBeLessThanOrEqual(11);
    expect(
      appends.map((event) => (event.content as Array<{ text: string }>)[0]?.text ?? "").join(""),
    ).toMatch(/^x+ \[truncated\]$/);
  });

  it("normalizes assistant completion to the shared response lifecycle", async () => {
    const harness = createHarness();
    await harness.bridge.connect();

    harness.socket.serverEvent({
      type: "turn.done",
      turn: { role: "user", transcript: "hello" },
    });
    expect(harness.onEvent).toHaveBeenLastCalledWith({
      direction: "server",
      type: "turn.done",
    });

    harness.socket.serverEvent({
      type: "turn.done",
      turn: { role: "assistant", transcript: "hi there" },
    });
    expect(harness.onEvent).toHaveBeenLastCalledWith({
      direction: "server",
      type: "response.done",
    });
  });

  it("converts telephony mu-law audio to and from GPT-Live PCM16", async () => {
    const harness = createHarness({ audioFormat: "g711_ulaw" });
    await harness.bridge.connect();
    harness.bridge.sendAudio(Buffer.alloc(160, 0xff));

    const inputEvent = sentEvents(harness.socket).at(-1);
    expect(inputEvent?.type).toBe("input_audio.append");
    expect(Buffer.from(String(inputEvent?.audio), "base64")).toHaveLength(870);

    harness.socket.serverEvent({
      type: "output_audio.delta",
      audio: Buffer.alloc(960).toString("base64"),
    });
    harness.socket.serverEvent({
      type: "turn.done",
      turn: { role: "assistant", transcript: "first response" },
    });
    harness.socket.serverEvent({
      type: "output_audio.delta",
      audio: Buffer.alloc(960).toString("base64"),
    });
    harness.socket.serverEvent({
      type: "turn.done",
      turn: { role: "assistant", transcript: "second response" },
    });

    expect(harness.onAudio.mock.calls.map(([audio]) => audio)).toEqual([
      Buffer.alloc(155, 0xff),
      Buffer.alloc(5, 0xff),
      Buffer.alloc(155, 0xff),
      Buffer.alloc(5, 0xff),
    ]);
    expect(harness.onAudio.mock.invocationCallOrder.at(-1)).toBeLessThan(
      harness.onEvent.mock.invocationCallOrder.at(-1) ?? 0,
    );
  });

  it("uses session context for forced consult results without a provider delegation", async () => {
    const harness = createHarness();
    await harness.bridge.connect();
    harness.bridge.sendUserMessage("Legacy speech request");
    expect(sentEvents(harness.socket).at(-1)).toEqual({
      type: "session.context.append",
      content: [{ type: "input_text", text: "Legacy speech request" }],
    });
    harness.bridge.submitToolResult("forced-consult", { text: "Forced answer" });

    expect(sentEvents(harness.socket).at(-1)).toEqual({
      type: "session.context.append",
      channel: "speakable",
      content: [{ type: "input_text", text: "Forced answer" }],
    });

    harness.bridge.triggerGreeting();
    expect(sentEvents(harness.socket).at(-1)).toEqual({
      type: "session.context.append",
      channel: "speakable",
      content: [{ type: "input_text", text: "Greet the user briefly." }],
    });
  });
});
