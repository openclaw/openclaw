import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTranscriptionSession,
  emitCommitted,
  emitCompleted,
  emitDelta,
  emitFailed,
  emitJson,
} from "./realtime-transcription-provider.test-support.js";

const { FakeWebSocket } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class MockWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readonly listeners = new Map<string, Listener[]>();
    readyState = 0;
    closed = false;

    constructor() {
      MockWebSocket.instances.push(this);
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    }

    send(): void {}

    close(code?: number, reason?: string): void {
      this.closed = true;
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
    }

    terminate(): void {
      this.closed = true;
      this.readyState = MockWebSocket.CLOSED;
    }
  }

  return { FakeWebSocket: MockWebSocket };
});

vi.mock("ws", () => ({
  default: FakeWebSocket,
}));

type FakeWebSocketInstance = InstanceType<typeof FakeWebSocket>;

async function waitForFakeSocket(index = 0): Promise<FakeWebSocketInstance> {
  await vi.dynamicImportSettled();
  let socket: FakeWebSocketInstance | undefined;
  await vi.waitFor(() => {
    socket = FakeWebSocket.instances[index];
    if (!socket) {
      throw new Error("expected session to create a websocket");
    }
  });
  if (!socket) {
    throw new Error("expected session to create a websocket");
  }
  return socket;
}

async function connectFakeSession(
  session: { connect(): Promise<void> },
  socketIndex = 0,
): Promise<FakeWebSocketInstance> {
  const connecting = session.connect();
  const socket = await waitForFakeSocket(socketIndex);
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");
  emitJson(socket, { type: "session.updated" });
  await connecting;
  return socket;
}

describe("OpenAI realtime transcription terminal history bounds", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubEnv("OPENAI_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { label: "without item identity", itemId: undefined, committed: false },
    { label: "before item commit", itemId: "uncommitted-item", committed: false },
    { label: "after item commit", itemId: "committed-item", committed: true },
  ])("rejects an oversized final transcript $label", async ({ itemId, committed }) => {
    const onError = vi.fn();
    const onTranscript = vi.fn();
    const session = createTranscriptionSession({
      onError,
      onTranscript,
    });
    const socket = await connectFakeSession(session);
    if (committed) {
      emitCommitted(socket, itemId, null);
    }

    const transcript = `${"🙂".repeat((256 * 1024) / 4)}x`;
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      ...(itemId ? { item_id: itemId } : {}),
      transcript,
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      ...(itemId ? { item_id: itemId } : {}),
      transcript: "late transcript",
    });

    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "OpenAI realtime transcription exceeded the 256 KiB retained transcript limit",
      }),
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);
    expect(socket.closed).toBe(true);
    session.close();
  });

  it("accepts an exact-limit UTF-8 final after releasing its own partial", async () => {
    const onError = vi.fn();
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const session = createTranscriptionSession({
      onError,
      onPartial,
      onTranscript,
    });
    const socket = await connectFakeSession(session);
    const transcript = "🙂".repeat((256 * 1024) / 4);
    emitDelta(socket, "uncommitted-item", transcript);
    emitCompleted(socket, "uncommitted-item", transcript);

    expect(onPartial).toHaveBeenCalledExactlyOnceWith(transcript);
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith(transcript);
    expect(onError).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(true);
    session.close();
  });

  it("counts retained sibling text when admitting a final transcript", async () => {
    const onError = vi.fn();
    const onTranscript = vi.fn();
    const session = createTranscriptionSession({
      onError,
      onTranscript,
    });
    const socket = await connectFakeSession(session);
    const partial = "🙂".repeat((128 * 1024) / 4);
    for (const itemId of ["retained-item", "completing-item"]) {
      emitDelta(socket, itemId, partial);
    }
    emitCompleted(socket, "completing-item", `${partial}x`);

    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "OpenAI realtime transcription exceeded the 256 KiB retained transcript limit",
      }),
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);
    session.close();
  });

  it("preserves terminal history at capacity, fails on overflow, and reconnects", async () => {
    const onError = vi.fn();
    const onPartial = vi.fn();
    const transcripts: string[] = [];

    const session = createTranscriptionSession({
      onError,
      onPartial,
      onTranscript: (transcript) => transcripts.push(transcript),
    });
    try {
      const socket = await connectFakeSession(session);

      emitCompleted(socket, "oldest", "first");
      for (let index = 0; index < 4095; index += 1) {
        emitCompleted(socket, `settled-${index}`, "");
      }
      emitCompleted(socket, "oldest", "duplicate");
      emitDelta(socket, "oldest", "late partial");

      expect(transcripts).toEqual(["first"]);
      expect(onPartial).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(session.isConnected()).toBe(true);

      emitCommitted(socket, "overflow-item", null);
      emitFailed(socket, "overflow-item", "provider failure");

      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          message: "OpenAI realtime transcription exceeded the terminal item history limit",
        }),
      );
      expect(transcripts).toEqual(["first"]);
      expect(session.isConnected()).toBe(false);

      const reconnecting = session.connect();
      const replacementSocket = await waitForFakeSocket(1);
      replacementSocket.readyState = FakeWebSocket.OPEN;
      replacementSocket.emit("open");
      emitJson(replacementSocket, { type: "session.updated" });
      await reconnecting;
      emitCompleted(replacementSocket, "replacement-item", "replacement transcript");

      expect(transcripts).toEqual(["first", "replacement transcript"]);
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      session.close();
      // Close the fake peer too so the session releases its graceful-close timer.
      FakeWebSocket.instances.at(-1)?.close();
    }
  });

  it("fails visibly when terminal item identities exceed 256 KiB", async () => {
    const onError = vi.fn();
    const onTranscript = vi.fn();

    const session = createTranscriptionSession({
      onError,
      onTranscript,
    });
    const socket = await connectFakeSession(session);

    for (let index = 0; index < 256; index += 1) {
      emitCompleted(socket, `${index.toString().padStart(4, "0")}${"i".repeat(1020)}`, "");
    }
    emitCompleted(socket, "overflow-item", "must not emit");

    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "OpenAI realtime transcription exceeded the terminal item history limit",
      }),
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);
    session.close();
  });
});
