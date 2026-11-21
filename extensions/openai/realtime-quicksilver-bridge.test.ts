import { describe, expect, it, vi } from "vitest";
import {
  delegation as delegationEvent,
  publicDelegation as publicDelegationEvent,
  transcript as transcriptEvent,
  turn,
} from "./realtime-quicksilver-events.test-support.js";

const { captureWsEventAsyncMock } = vi.hoisted(() => ({
  captureWsEventAsyncMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("openclaw/plugin-sdk/proxy-capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/proxy-capture")>();
  return { ...actual, captureWsEventAsync: captureWsEventAsyncMock };
});

import {
  createHarness,
  FakeSocket,
  sentEvents,
} from "./realtime-quicksilver-bridge.test-support.js";

type Harness = ReturnType<typeof createHarness>;
type Callback = (...args: never[]) => unknown;

function expectCall<T extends Callback>(callback: T, ...args: Parameters<T>) {
  expect(callback).toHaveBeenCalledWith(...args);
}

function expectLast<T extends Callback>(callback: T, ...args: Parameters<T>) {
  expect(callback).toHaveBeenLastCalledWith(...args);
}

function expectOnce<T extends Callback>(callback: T, ...args: Parameters<T>) {
  expect(callback).toHaveBeenCalledExactlyOnceWith(...args);
}

async function pendingHarness(params?: Parameters<typeof createHarness>[0]) {
  const harness = createHarness({ ...params, autoStart: false });
  const connecting = harness.bridge.connect();
  await vi.waitFor(() => expect(harness.socket.readyState).toBe(1));
  return { ...harness, connecting };
}

const eventsOf = (socket: FakeSocket, type: string) =>
  sentEvents(socket).filter((event) => event.type === type);
const snapshots = (harness: Harness) => harness.onTranscript.mock.calls.filter((call) => call[2]);

function closeOnSnapshot(harness: Harness) {
  harness.onTranscript.mockImplementation((_role, _text, final) => {
    if (final) {
      void harness.bridge.close();
    }
  });
}

function publicDelegation(socket: FakeSocket, id: string, offset_ms: number) {
  socket.serverEvent(publicDelegationEvent(id, offset_ms));
}

function outputAudio(socket: FakeSocket, audio: Buffer) {
  socket.serverEvent({ type: "output_audio.delta", audio: audio.toString("base64") });
}

function turnDone(socket: FakeSocket, role: "user" | "assistant", transcript: string) {
  socket.serverEvent(turn(role, transcript));
}

function expectTransportError(error: unknown) {
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ name: "Error", message: "OpenAI GPT-Live transport failed" });
}

function expectClosed(harness: Harness, reason: "completed" | "error") {
  expectOnce(harness.onClose, reason);
  expect(harness.socket.closeCalls).toBe(1);
}

function expectSilent(harness: Harness) {
  expect(harness.onError).not.toHaveBeenCalled();
  expect(harness.onClose).not.toHaveBeenCalled();
}

const serverEvent = (type: string): Parameters<Harness["onEvent"]>[0] => ({
  direction: "server",
  type,
});

const liveAppend = (type: string, content: string, delegation_id: string | null = null) => ({
  type: `session.${type}.append`,
  delegation_id,
  content,
});

function expectContext(socket: FakeSocket, text: string, speakable = true) {
  expect(sentEvents(socket).at(-1)).toEqual({
    type: "session.context.append",
    ...(speakable ? { channel: "speakable" } : {}),
    content: [{ type: "input_text", text }],
  });
}

async function connectHarness(params?: Parameters<typeof createHarness>[0]) {
  const harness = createHarness(params);
  await harness.bridge.connect();
  return harness;
}

function emitTranscript(
  socket: FakeSocket,
  role: "input" | "output",
  delta: string,
  start_ms: number,
  end_ms: number,
) {
  socket.serverEvent({ type: `session.${role}_transcript.delta`, delta, start_ms, end_ms });
}

function closed(socket: FakeSocket, reason = "close_requested") {
  socket.serverEvent({ type: "session.closed", reason });
}

function started(socket: FakeSocket) {
  socket.serverEvent({ type: "session.started", session: {} });
}

function delegation(socket: FakeSocket, id: string, text: string) {
  socket.serverEvent(delegationEvent(id, text));
}

it("connects directly to /v1/live and completes the Frameless Bidi handshake", async () => {
  const harness = await connectHarness();

  expect(harness.connections).toMatchObject([
    {
      url: "wss://api.openai.com/v1/live?model=gpt-live-test-canary",
      options: {
        headers: { Authorization: "Bearer test-key", "OpenAI-Alpha": "quicksilver=v2" },
      },
    },
  ]);
  expect(sentEvents(harness.socket)[0]).toEqual({
    type: "session.update",
    session: {
      instructions: "Use delegation for real work.",
      audio: { output: { voice: "marin" } },
      delegation: { type: "client" },
    },
  });
  expect(harness.bridge.isConnected()).toBe(true);
  expect(harness.bridge).toMatchObject({
    handlesInputAudioBargeIn: true,
    outputAudioMode: "continuous",
  });
  expect(harness.onReady).toHaveBeenCalledOnce();

  void harness.bridge.close();
  await vi.waitFor(() => expectCall(harness.onClose, "completed"));
});

it("streams the public Live protocol and delegates from user context through graceful close", async () => {
  const harness = await connectHarness({ model: "gpt-live-1" });
  harness.bridge.sendUserMessage("The kitchen lights are on.");
  const speechRequest = sentEvents(harness.socket).at(-1);
  harness.bridge.submitToolResult("quiet-background", "Unspoken background.", {
    suppressResponse: true,
  });
  const suppressedResult = sentEvents(harness.socket).at(-1);
  const audio = Buffer.from([0, 1, 2, 3]);
  harness.bridge.sendAudio(audio);
  await vi.waitFor(() =>
    expect(sentEvents(harness.socket)).toContainEqual({
      type: "session.input_audio.append",
      audio: Buffer.concat([audio, Buffer.alloc(956)]).toString("base64"),
    }),
  );
  harness.socket.serverEvent({
    type: "session.output_audio.delta",
    delta: audio.toString("base64"),
  });
  expectCall(harness.onAudio, audio);
  emitTranscript(harness.socket, "input", "Find a train.", 0, 500);
  emitTranscript(harness.socket, "output", "I can help.", 400, 600);
  publicDelegation(harness.socket, "item_live", 600);
  expectCall(
    harness.onToolCall,
    expect.objectContaining({
      callId: "item_live",
      args: { question: expect.stringContaining("<input>Find a train.</input>") },
    }),
  );
  expectCall(harness.onTranscript, "assistant", "I can help.", false);
  expectCall(harness.onTranscript, "assistant", "I can help.", true);
  expectCall(harness.onTranscript, "user", "Find a train.", true);
  expect(harness.onEvent).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "response.done" }),
  );
  harness.bridge.submitToolResult("item_live", "Still checking.", { willContinue: true });
  harness.bridge.submitToolResult("item_live", "The train leaves at noon.");
  expect(sentEvents(harness.socket)).toEqual(
    expect.arrayContaining([
      liveAppend("thinking", "Still checking.", "item_live"),
      liveAppend("commentary", "The train leaves at noon.", "item_live"),
    ]),
  );
  const longAnswer = "The journey is scenic. ".repeat(800);
  emitTranscript(harness.socket, "output", longAnswer, 600, 700);
  emitTranscript(harness.socket, "output", "Goodbye.", 700, 900);
  const closing = harness.bridge.close();
  expect(closing).toBeInstanceOf(Promise);
  expect(harness.bridge.close()).toBe(closing);
  const finalTranscripts = snapshots(harness);
  expect(finalTranscripts.filter(([role]) => role === "user")).toEqual([
    ["user", "Find a train.", true],
  ]);
  expect(
    finalTranscripts
      .filter(([role]) => role === "assistant")
      .map(([, text]) => text)
      .join(""),
  ).toBe("I can help." + longAnswer + "Goodbye.");
  expect(harness.bridge.isConnected()).toBe(false);
  expect(harness.socket.closeCalls).toBe(0);
  expect(eventsOf(harness.socket, "session.close")).toHaveLength(1);
  const sentBeforeLateResult = harness.socket.sent.length;
  harness.bridge.submitToolResult("item_live", "Late result");
  expect(harness.socket.sent).toHaveLength(sentBeforeLateResult);
  emitTranscript(harness.socket, "output", "Trailing speech.", 900, 1000);
  expect(harness.onClose).not.toHaveBeenCalled();
  closed(harness.socket, "close_requested");
  await closing;
  expectLast(harness.onTranscript, "assistant", "Trailing speech.", true);
  expectClosed(harness, "completed");
  expect(speechRequest).toEqual(liveAppend("commentary", "The kitchen lights are on."));
  expect(suppressedResult).toEqual(liveAppend("thinking", "Unspoken background."));
});

it("keeps the public input clock running through silence and stops before transcript drain", async () => {
  const { connecting, ...harness } = await pendingHarness({ model: "gpt-live-1" });
  const capture = Buffer.alloc(960, 1);
  harness.bridge.sendAudio(capture);
  const readAudio = () =>
    eventsOf(harness.socket, "session.input_audio.append").map((event) =>
      Buffer.from(String(event.audio), "base64"),
    );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    harness.socket.serverEvent({ type: "session.started", session: {} });
    await connecting;
    expect(harness.bridge.pacesInputAudio).toBe(true);
    expect(readAudio()).toEqual([capture]);
    await vi.advanceTimersByTimeAsync(40);
    expect(readAudio()).toEqual([capture, Buffer.alloc(960), Buffer.alloc(960)]);
    const closing = harness.bridge.close();
    const sentBeforeClose = harness.socket.sent.length;
    harness.bridge.sendAudio(capture);
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.socket.sent).toHaveLength(sentBeforeClose);
    closed(harness.socket);
    await closing;
  } finally {
    closed(harness.socket);
    await harness.bridge.close();
    vi.useRealTimers();
  }
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
  const harness = await connectHarness({ model: "gpt-live-1", handleDelegationInput });
  harness.onTranscript.mockImplementation((_role, _text, final) => {
    if (final) {
      order.push("snapshot");
    }
  });
  emitTranscript(harness.socket, "input", "status", 0, 100);
  publicDelegation(harness.socket, "item_status", 100);
  expect(order).toEqual(["classify:status"]);
  emitTranscript(harness.socket, "input", "Check my flight.", 0, 100);
  emitTranscript(harness.socket, "output", "Background speech. ".repeat(1_000), 0, 100);
  order.length = 0;
  publicDelegation(harness.socket, "item_flight", 100);
  expect(order[0]).toBe("classify:Check my flight.");
  expect(order.length).toBeGreaterThan(1);
  expect(order.slice(1).every((entry) => entry === "snapshot")).toBe(true);
  expect(harness.onToolCall).not.toHaveBeenCalled();
  closed(harness.socket);
  await harness.bridge.close();
});

it.each(["local-close", "delegation"])(
  "saves the entire %s batch when a snapshot callback closes",
  async (boundary) => {
    const harness = await connectHarness({ model: "gpt-live-1" });
    closeOnSnapshot(harness);
    emitTranscript(harness.socket, "input", "My question.", 0, 100);
    emitTranscript(harness.socket, "output", "The answer.", 100, 200);
    if (boundary === "delegation") {
      publicDelegation(harness.socket, "item_close", 200);
    } else {
      void harness.bridge.close();
    }
    expect(harness.onToolCall).not.toHaveBeenCalled();
    expect(snapshots(harness)).toEqual([
      ["user", "My question.", true],
      ["assistant", "The answer.", true],
    ]);
    await vi.waitFor(() => expect(eventsOf(harness.socket, "session.close")).toHaveLength(1));
    closed(harness.socket, "close_requested");
    await vi.waitFor(() => expectOnce(harness.onClose, "completed"));
    expect(harness.logger.warn).not.toHaveBeenCalled();
  },
);

it.each(["close_requested", "content", "transport-error"] as const)(
  "keeps cleanup completion when snapshot publication throws (terminal=%s)",
  async (terminal) => {
    const harness = await connectHarness({ model: "gpt-live-1" });
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
      emitTranscript(harness.socket, "input", "Received speech.", 0, 100);
      let closing: void | Promise<void> = undefined;
      expect(() => {
        closing = harness.bridge.close();
      }).not.toThrow();
      expect(closing).toBeInstanceOf(Promise);
      expect(reentrantCompletion).toBe(closing);
      expect(harness.bridge.close()).toBe(closing);
      let settled = false;
      const markSettled = () => {
        settled = true;
      };
      void Promise.resolve(closing).then(markSettled, markSettled);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(harness.onClose).not.toHaveBeenCalled();
      expect(harness.socket.closeCalls).toBe(0);
      emitTranscript(harness.socket, "output", "Trailing speech.", 100, 200);
      if (terminal === "transport-error") {
        harness.socket.emit("error", new Error("transport ended"));
      } else {
        harness.socket.serverEvent({ type: "session.closed", reason: terminal });
      }
      await expect(closing).rejects.toBe(publicationError);
      expectLast(harness.onTranscript, "assistant", "Trailing speech.", true);
      expectClosed(harness, terminal === "close_requested" ? "completed" : "error");
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
  ["connection_lost", false],
  ["content", true],
] as const)(
  "keeps remote %s outcome through snapshot callbacks (locally closing: %s)",
  async (reason, locallyClosing) => {
    const harness = await connectHarness({ model: "gpt-live-1" });
    closeOnSnapshot(harness);
    emitTranscript(harness.socket, "output", "Received speech.", 0, 100);
    const closing = locallyClosing ? harness.bridge.close() : undefined;
    if (locallyClosing) {
      await vi.waitFor(() =>
        expect(sentEvents(harness.socket)).toContainEqual({ type: "session.close" }),
      );
    }
    closed(harness.socket, reason);
    await closing;
    await Promise.resolve();
    expect(snapshots(harness)).toEqual([["assistant", "Received speech.", true]]);
    expect(eventsOf(harness.socket, "session.close")).toEqual(
      locallyClosing ? [{ type: "session.close" }] : [],
    );
    expectClosed(harness, "error");
    expect(harness.logger.warn).not.toHaveBeenCalled();
  },
);

it("bounds public close finalization and reports missing session.closed", async () => {
  const harness = await connectHarness({ model: "gpt-live-1" });
  vi.useFakeTimers();
  try {
    const closing = harness.bridge.close();
    const rejected = expect(closing).rejects.toThrow("finalization is unconfirmed");
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expectCall(harness.logger.warn, expect.stringContaining("cleanup INCOMPLETE"));
    expect(harness.logger.warn).toHaveBeenCalledOnce();
    expectClosed(harness, "error");
  } finally {
    vi.useRealTimers();
  }
});

it("keeps repeated close idempotent while the transport is still open", async () => {
  const harness = await connectHarness({ deferClose: true });

  void harness.bridge.close();
  void harness.bridge.close();

  expect(eventsOf(harness.socket, "session.close")).toHaveLength(1);
  expectClosed(harness, "completed");

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
  started(harness.socket);

  await Promise.all([firstConnect, secondConnect]);
  expect(harness.onReady).toHaveBeenCalledOnce();
});

it.each([
  ["missing_scope", "temporary provider rejection", true],
  ["authentication_error", "invalid live session", false],
] as const)(
  "handles %s before session readiness: %s (recoverable=%s)",
  async (code, message, recoverable) => {
    const { connecting, ...harness } = await pendingHarness();
    harness.socket.serverEvent({ type: "error", error: { code, message } });
    expect(harness.bridge.isConnected()).toBe(false);
    expectSilent(harness);
    if (recoverable) {
      started(harness.socket);
      await connecting;
      expect(harness.bridge.isConnected()).toBe(true);
      expect(harness.onReady).toHaveBeenCalledOnce();
    } else {
      await expect(connecting).rejects.toThrow("OpenAI GPT-Live transport failed");
      expectSilent(harness);
      expect(harness.bridge.isConnected()).toBe(false);
    }
  },
);

it("bounds queued audio by aggregate bytes before session readiness", async () => {
  const { connecting, ...harness } = await pendingHarness();

  harness.bridge.sendAudio(Buffer.alloc(512 * 1024, 0x01));
  harness.bridge.sendAudio(Buffer.alloc(512 * 1024, 0x02));
  harness.bridge.sendAudio(Buffer.from("overflow"));
  started(harness.socket);
  await connecting;

  const audioEvents = eventsOf(harness.socket, "input_audio.append");
  expect(audioEvents).toHaveLength(1);
  const retained = Buffer.from(String(audioEvents[0]?.audio), "base64");
  expect(retained).toEqual(
    Buffer.concat([Buffer.alloc(240_000 - 8, 0x02), Buffer.from("overflow")]),
  );
  expect(harness.logger.warn).toHaveBeenCalledOnce();
  expectCall(
    harness.logger.warn,
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

  expect(eventsOf(harness.socket, "input_audio.append")).toHaveLength(0);

  void harness.bridge.close();
  expectOnce(harness.onClose, "completed");
});

it("does not carry queued audio across terminal close and explicit reconnect", async () => {
  const sockets: FakeSocket[] = [];
  const { bridge } = createHarness({
    autoStart: false,
    socketFactory: () => {
      const socket = new FakeSocket(false);
      sockets.push(socket);
      return socket;
    },
  });

  const firstConnect = bridge.connect();
  await vi.waitFor(() => expect(sockets[0]?.readyState).toBe(1));
  bridge.sendAudio(Buffer.from("queued-before-close"));
  void bridge.close();
  await firstConnect;
  bridge.sendAudio(Buffer.from("sent-after-close"));

  const reconnecting = bridge.connect();
  await vi.waitFor(() => expect(sockets[1]?.readyState).toBe(1));
  const secondSocket = sockets[1];
  if (!secondSocket) {
    throw new Error("expected bridge to reconnect");
  }
  started(secondSocket);
  await reconnecting;
  expect(eventsOf(secondSocket, "input_audio.append")).toHaveLength(0);
  void bridge.close();
});

it("does not reject after explicit close while awaiting session readiness", async () => {
  const { connecting, ...harness } = await pendingHarness({ deferClose: true });

  void harness.bridge.close();
  harness.socket.emit("error", new Error("late startup error"));

  await expect(connecting).resolves.toBeUndefined();
  expectOnce(harness.onClose, "completed");
  expect(harness.onError).not.toHaveBeenCalled();
  harness.socket.finishClose();
});

it("completes once when closed while authentication is pending", async () => {
  const auth = Promise.withResolvers<{ type: "api-key"; token: string }>();
  const harness = createHarness({ resolveAuth: () => auth.promise });
  const connecting = harness.bridge.connect();

  void harness.bridge.close();
  void harness.bridge.close();
  expectOnce(harness.onClose, "completed");

  auth.resolve({ type: "api-key", token: "test-key" });
  await expect(connecting).resolves.toBeUndefined();
  expect(harness.connections).toHaveLength(0);
  expect(harness.onError).not.toHaveBeenCalled();
});

it.each([
  ["gpt-live-test-canary", 1000, "completed", true],
  ["gpt-live-test-canary", 1006, "error", true],
  ["gpt-live-1", 1000, "error", true],
  ["gpt-live-1", 1006, "error", true],
  ["gpt-live-test-canary", 1000, "completed", false],
  ["gpt-live-test-canary", 1006, "error", false],
] as const)(
  "classifies %s close code %s as %s (buffered=%s)",
  async (model, code, reason, buffered) => {
    const harness = createHarness({
      model,
      autoStart: !buffered,
      afterOpen: buffered
        ? (socket) => {
            started(socket);
            socket.finishClose(code);
          }
        : undefined,
    });
    await harness.bridge.connect();
    if (buffered) {
      expect(harness.onReady).toHaveBeenCalledOnce();
      if (reason === "error") {
        expect(harness.onError).toHaveBeenCalledOnce();
        expectTransportError(harness.onError.mock.calls[0]?.[0]);
      } else {
        expect(harness.onError).not.toHaveBeenCalled();
      }
    } else {
      harness.socket.finishClose(code);
      await Promise.resolve();
    }
    expectOnce(harness.onClose, reason);
    expect(harness.bridge.isConnected()).toBe(false);
  },
);

it("maps audio, transcripts, and delegations onto the shared bridge contract", async () => {
  const harness = await connectHarness();
  outputAudio(harness.socket, Buffer.from([1, 2, 3, 4]));
  harness.socket.serverEvent({ type: "output_audio_buffer.cleared" });
  harness.socket.serverEvent({
    type: "input_transcript.added",
    item: { text: "hello" },
  });
  turnDone(harness.socket, "user", "hello there");
  expectLast(harness.onEvent, serverEvent("turn.done"));
  delegation(harness.socket, "delegation-1", "check the repository");

  expectCall(harness.onAudio, Buffer.from([1, 2, 3, 4]));
  expectCall(harness.onEvent, serverEvent("output_audio_buffer.cleared"));
  expectOnce(harness.onClearAudio, "barge-in");
  outputAudio(harness.socket, Buffer.from([5, 6, 7, 8]));
  expectLast(harness.onAudio, Buffer.from([5, 6, 7, 8]));
  expect(harness.onTranscript.mock.calls.slice(0, 2)).toEqual([
    ["user", "hello", false],
    ["user", "hello there", true],
  ]);
  expectCall(harness.onToolCall, {
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
  const harness = await connectHarness();
  harness.socket.serverEvent({
    type: "error",
    error: {
      message: `provider rejected ${model} ${sensitiveDetails.join(" ")}`,
      code: "invalid_api_key",
    },
  });

  expect(harness.onError).toHaveBeenCalledOnce();
  const projectedError = harness.onError.mock.calls[0]?.[0];
  expectTransportError(projectedError);
  expect(projectedError?.cause).toBeUndefined();
  const projected = JSON.stringify({ events: harness.onEvent.mock.calls });
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
  expectTransportError(startupError);

  const active = await connectHarness({ model });
  const error = new Error(`active transport failed ${model}`);
  error.name = `Socket${model}`;
  active.socket.emit("error", error);

  expect(active.onError).toHaveBeenCalledOnce();
  expectTransportError(active.onError.mock.calls[0]?.[0]);
});

it("captures only fixed metadata for private transport activity", async () => {
  captureWsEventAsyncMock.mockClear();
  const model = "sensitive-model-marker";
  const transcript = "sensitive-frame-marker";
  const harness = await connectHarness({ model });
  harness.bridge.sendUserMessage(transcript);
  turnDone(harness.socket, "user", transcript);

  expect(harness.connections[0]?.options).not.toHaveProperty("agent");
  expect(captureWsEventAsyncMock).toHaveBeenCalled();
  const captureCalls = captureWsEventAsyncMock.mock.calls as Array<[Record<string, unknown>]>;
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
  const harness = await connectHarness();

  delegation(harness.socket, "delegation-large", "summarize everything");
  harness.bridge.submitToolResult("delegation-large", { text: "x".repeat(10_000) });

  const appends = eventsOf(harness.socket, "delegation.context.append");
  expect(appends.length).toBeGreaterThan(0);
  expect(appends.length).toBeLessThanOrEqual(11);
  expect(
    appends.map((event) => (event.content as Array<{ text: string }>)[0]?.text ?? "").join(""),
  ).toMatch(/^x+ \[truncated\]$/);
});

it("converts telephony mu-law audio to and from GPT-Live PCM16", async () => {
  const harness = await connectHarness({ audioFormat: "g711_ulaw" });
  harness.bridge.sendAudio(Buffer.alloc(160, 0xff));

  const inputEvent = sentEvents(harness.socket).at(-1);
  expect(inputEvent?.type).toBe("input_audio.append");
  expect(Buffer.from(String(inputEvent?.audio), "base64")).toHaveLength(870);

  outputAudio(harness.socket, Buffer.alloc(960));
  turnDone(harness.socket, "assistant", "first response");
  expectLast(harness.onEvent, serverEvent("response.done"));
  outputAudio(harness.socket, Buffer.alloc(960));
  turnDone(harness.socket, "assistant", "second response");

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
  const harness = await connectHarness();
  harness.bridge.sendUserMessage("Legacy speech request");
  expectContext(harness.socket, "Legacy speech request", false);
  harness.bridge.submitToolResult("forced-consult", { text: "Forced answer" });
  expectContext(harness.socket, "Forced answer");
  harness.bridge.triggerGreeting();
  expectContext(harness.socket, "Greet the user briefly.");
});

const noCommentary = ({ socket }: ReturnType<typeof createHarness>) =>
  expect(sentEvents(socket).filter((event) => event.type === "session.commentary.append")).toEqual(
    [],
  );

describe("GPT-Live bridge delegation admission", () => {
  it("claims subscription tasks and controls before callbacks without consuming fresh context", async () => {
    const classify = vi.fn(() => "consult" as const);
    const harness = createHarness({ model: "gpt-live-1-codex", handleDelegationInput: classify });
    const delegate = (id: string) => harness.socket.serverEvent(delegationEvent(id));
    await harness.bridge.connect();
    try {
      harness.onToolCall.mockImplementationOnce(() => delegate("first"));
      delegate("first");
      expect(harness.onToolCall).toHaveBeenCalledOnce();
      harness.bridge.submitToolResult("first", "Done.");
      harness.socket.serverEvent(turn("user", "Fresh context."));
      delegate("first");
      expect(classify).toHaveBeenCalledOnce();
      delegate("second");
      expect(harness.onToolCall).toHaveBeenCalledTimes(2);
      expect(harness.onTranscript).toHaveBeenCalledWith("user", "Fresh context.", true);
      harness.bridge.submitToolResult("second", "Done.");
      expect(harness.onError).not.toHaveBeenCalled();
    } finally {
      await harness.bridge.close();
    }
    delegate("third");
    expect(harness.onToolCall).toHaveBeenCalledTimes(2);

    // Provider IDs belong to a connection, never a process-global replay cache.
    const fresh = createHarness({ model: "gpt-live-1-codex" });
    await fresh.bridge.connect();
    try {
      fresh.socket.serverEvent(delegationEvent("first"));
      expect(fresh.onToolCall).toHaveBeenCalledOnce();
    } finally {
      await fresh.bridge.close();
    }
  });

  it("does not reclassify a completed native control notice against later work", async () => {
    const classify = vi.fn(() => "control" as const);
    const harness = createHarness({ model: "gpt-live-1-codex", handleDelegationInput: classify });
    await harness.bridge.connect();
    const event = delegationEvent("cancel-one", "Cancel it.");
    try {
      harness.socket.serverEvent(event);
      harness.socket.serverEvent(event);
      expect(classify).toHaveBeenCalledOnce();
      expect(harness.onToolCall).not.toHaveBeenCalled();
    } finally {
      await harness.bridge.close();
    }
  });

  it("waits for public transcript input and ignores duplicate notices after tool completion", async () => {
    const harness = createHarness({ model: "gpt-live-1" });
    await harness.bridge.connect();
    const delegate = (id: string) => harness.socket.serverEvent(publicDelegationEvent(id, 100));
    delegate("early");
    delegate("early");
    noCommentary(harness);
    harness.socket.serverEvent(transcriptEvent("Find a train."));
    expect(harness.onToolCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        callId: "early",
        args: { question: expect.stringContaining("Find a train.") },
      }),
    );
    harness.bridge.submitToolResult("early", "Done.");
    harness.socket.serverEvent(transcriptEvent("Check a flight."));
    delegate("early");
    expect(harness.onToolCall).toHaveBeenCalledOnce();
    delegate("next");
    expect(harness.onToolCall).toHaveBeenCalledTimes(2);
    expect(harness.onToolCall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        callId: "next",
        args: { question: expect.stringContaining("Check a flight.") },
      }),
    );
    const closing = harness.bridge.close();
    harness.socket.serverEvent({ type: "session.closed", reason: "close_requested" });
    await closing;
  });

  it("rechecks delayed delegation authority after an event observer closes the call", async () => {
    const harness = createHarness({ model: "gpt-live-1" });
    await harness.bridge.connect();
    harness.onEvent.mockImplementation((event) => {
      if (event.type === "session.delegation.created") {
        void harness.bridge.close();
      }
    });
    harness.socket.serverEvent(publicDelegationEvent());
    harness.socket.serverEvent(transcriptEvent("Check a flight."));
    expect(harness.onToolCall).not.toHaveBeenCalled();
    harness.socket.serverEvent({ type: "session.closed", reason: "close_requested" });
    await harness.bridge.close();
  });

  it.each(["local-close", "remote-close", "error"] as const)(
    "revokes delayed public delegation on %s before late captions or timeout",
    async (boundary) => {
      const harness = createHarness({ model: "gpt-live-1" });
      await harness.bridge.connect();
      vi.useFakeTimers();
      try {
        harness.socket.serverEvent(publicDelegationEvent());
        const closing = boundary === "local-close" ? harness.bridge.close() : undefined;
        if (boundary === "remote-close") {
          harness.socket.serverEvent({ type: "session.closed", reason: "remote_hangup" });
        }
        if (boundary === "error") {
          harness.socket.emit("error", new Error("disconnected"));
        }
        harness.socket.serverEvent(transcriptEvent("Late request."));
        if (boundary === "local-close") {
          harness.socket.serverEvent({ type: "session.closed", reason: "close_requested" });
        }
        await closing;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(harness.onToolCall).not.toHaveBeenCalled();
        noCommentary(harness);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
