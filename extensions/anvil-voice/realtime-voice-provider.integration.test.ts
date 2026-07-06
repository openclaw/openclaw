// Anvil Voice integration tests use a daemonless in-process realtime WebSocket server.
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceBridge,
  type RealtimeVoiceBridgeCallbacks,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import { buildAnvilRealtimeVoiceProvider } from "./realtime-voice-provider.js";

type AnvilTestEvent = {
  type: string;
  audio?: string;
  delta?: string;
  transcript?: string;
  item_id?: string;
  response_id?: string;
  error?: { message?: string; type?: string };
  response?: { id?: string; status?: string };
  session?: {
    audio?: {
      input?: {
        format?: { rate?: number; type?: string };
      };
    };
    model?: string;
  };
};

type BridgeCallbacks = {
  onAudio: ReturnType<typeof vi.fn<RealtimeVoiceBridgeCallbacks["onAudio"]>>;
  onClearAudio: ReturnType<typeof vi.fn<RealtimeVoiceBridgeCallbacks["onClearAudio"]>>;
  onError: ReturnType<typeof vi.fn<NonNullable<RealtimeVoiceBridgeCallbacks["onError"]>>>;
  onEvent: ReturnType<typeof vi.fn<NonNullable<RealtimeVoiceBridgeCallbacks["onEvent"]>>>;
  onReady: ReturnType<typeof vi.fn<NonNullable<RealtimeVoiceBridgeCallbacks["onReady"]>>>;
  onTranscript: ReturnType<typeof vi.fn<NonNullable<RealtimeVoiceBridgeCallbacks["onTranscript"]>>>;
};

const activeServers: FakeAnvilRealtimeServer[] = [];

function rawDataToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForAssertion(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await sleep(10);
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("timed out waiting for assertion");
}

class FakeAnvilRealtimeServer {
  private closed = false;
  private readonly server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  private readonly sockets: WebSocket[] = [];
  private readonly waiters = new Map<string, Array<(event: AnvilTestEvent) => void>>();
  readonly authHeaders: Array<string | undefined> = [];
  readonly messages: AnvilTestEvent[] = [];
  url = "";

  async start(): Promise<this> {
    this.server.on("connection", (socket, request) => {
      this.sockets.push(socket);
      this.authHeaders.push(request.headers.authorization);
      socket.on("message", (data) => this.handleMessage(socket, data));
    });
    await once(this.server, "listening");
    const address = this.server.address() as AddressInfo;
    this.url = `ws://127.0.0.1:${address.port}/v1/realtime`;
    activeServers.push(this);
    return this;
  }

  send(event: AnvilTestEvent): void {
    const socket = this.sockets[0];
    if (!socket) {
      throw new Error("fake Anvil realtime server has no connected socket");
    }
    socket.send(JSON.stringify(event));
  }

  async waitForType(type: string): Promise<AnvilTestEvent> {
    const existing = this.messages.find((event) => event.type === type);
    if (existing) {
      return existing;
    }
    return new Promise((resolve) => {
      const waiters = this.waiters.get(type) ?? [];
      waiters.push(resolve);
      this.waiters.set(type, waiters);
    });
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.close();
    }
    if (this.closed) {
      return;
    }
    this.closed = true;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private handleMessage(socket: WebSocket, data: RawData): void {
    const event = JSON.parse(rawDataToString(data)) as AnvilTestEvent;
    this.messages.push(event);
    for (const resolve of this.waiters.get(event.type) ?? []) {
      resolve(event);
    }
    this.waiters.delete(event.type);

    if (event.type === "session.update") {
      socket.send(JSON.stringify({ type: "session.updated" }));
    }
  }
}

function createBridge(
  server: FakeAnvilRealtimeServer,
  providerConfig: Record<string, unknown> = {},
): {
  bridge: RealtimeVoiceBridge;
  callbacks: BridgeCallbacks;
  connecting: Promise<void>;
} {
  const callbacks: BridgeCallbacks = {
    onAudio: vi.fn<RealtimeVoiceBridgeCallbacks["onAudio"]>(),
    onClearAudio: vi.fn<RealtimeVoiceBridgeCallbacks["onClearAudio"]>(),
    onError: vi.fn<NonNullable<RealtimeVoiceBridgeCallbacks["onError"]>>(),
    onEvent: vi.fn<NonNullable<RealtimeVoiceBridgeCallbacks["onEvent"]>>(),
    onReady: vi.fn<NonNullable<RealtimeVoiceBridgeCallbacks["onReady"]>>(),
    onTranscript: vi.fn<NonNullable<RealtimeVoiceBridgeCallbacks["onTranscript"]>>(),
  };
  const provider = buildAnvilRealtimeVoiceProvider();
  const bridge = provider.createBridge({
    providerConfig: {
      realtimeUrl: server.url,
      silenceDurationMs: 20,
      ...providerConfig,
    },
    instructions: "Route voice turns to the fast local tier.",
    audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    ...callbacks,
  });
  return { bridge, callbacks, connecting: bridge.connect() };
}

describe("Anvil realtime voice provider against a fake server", () => {
  afterEach(async () => {
    while (activeServers.length > 0) {
      await activeServers.pop()?.close();
    }
  });

  it("completes an audio turn and maps server audio and transcripts", async () => {
    const server = await new FakeAnvilRealtimeServer().start();
    const { bridge, callbacks, connecting } = createBridge(server, { apiKey: "test-token" });
    const sessionUpdate = await server.waitForType("session.update");
    await connecting;

    expect(server.authHeaders).toEqual(["Bearer test-token"]);
    expect(callbacks.onReady).toHaveBeenCalledTimes(1);
    expect(sessionUpdate.session?.model).toBe("fast-local");
    expect(sessionUpdate.session?.audio?.input?.format).toEqual({
      type: "audio/pcm",
      rate: 16000,
    });

    bridge.sendAudio(Buffer.alloc(480, 1));
    bridge.sendAudio(Buffer.alloc(960));

    const append = await server.waitForType("input_audio_buffer.append");
    await server.waitForType("input_audio_buffer.commit");
    expect(Buffer.from(append.audio ?? "", "base64")).toHaveLength(320);

    server.send({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "turn-1",
      response_id: "resp-1",
      transcript: "what is the fast tier status",
    });
    server.send({ type: "response.created", response: { id: "resp-1", status: "in_progress" } });
    server.send({
      type: "response.output_audio_transcript.delta",
      response_id: "resp-1",
      delta: "The fast tier is ready.",
    });
    server.send({
      type: "response.output_audio.delta",
      response_id: "resp-1",
      delta: Buffer.alloc(320, 3).toString("base64"),
    });
    server.send({ type: "response.done", response: { id: "resp-1" } });

    await waitForAssertion(() => {
      expect(callbacks.onTranscript).toHaveBeenCalledWith(
        "user",
        "what is the fast tier status",
        true,
      );
      expect(callbacks.onTranscript).toHaveBeenCalledWith(
        "assistant",
        "The fast tier is ready.",
        false,
      );
      expect(callbacks.onAudio).toHaveBeenCalledTimes(1);
    });
    expect(callbacks.onAudio.mock.calls[0]?.[0]).toHaveLength(480);
    expect(callbacks.onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "response.done",
      itemId: undefined,
      responseId: "resp-1",
    });

    bridge.close();
  });

  it("omits auth for loopback sessions without a configured token and reports server errors", async () => {
    const server = await new FakeAnvilRealtimeServer().start();
    const { bridge, callbacks, connecting } = createBridge(server);
    await server.waitForType("session.update");
    await connecting;

    expect(server.authHeaders).toEqual([undefined]);

    server.send({ type: "error", error: { message: "bad realtime turn" } });
    await waitForAssertion(() => {
      expect(callbacks.onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "bad realtime turn",
        }),
      );
    });

    bridge.close();
  });

  it("cancels active responses and suppresses late audio after barge-in", async () => {
    const server = await new FakeAnvilRealtimeServer().start();
    const { bridge, callbacks, connecting } = createBridge(server);
    await server.waitForType("session.update");
    await connecting;
    server.send({ type: "response.created", response: { id: "resp-cancelled" } });
    await waitForAssertion(() => {
      expect(callbacks.onEvent).toHaveBeenCalledWith({
        direction: "server",
        type: "response.created",
        itemId: undefined,
        responseId: "resp-cancelled",
      });
    });

    bridge.handleBargeIn?.({ audioPlaybackActive: true });

    await server.waitForType("response.cancel");
    await server.waitForType("input_audio_buffer.clear");
    expect(callbacks.onClearAudio).toHaveBeenCalledTimes(1);

    server.send({
      type: "response.output_audio.delta",
      response_id: "resp-cancelled",
      delta: Buffer.alloc(320, 5).toString("base64"),
    });
    await sleep(25);
    expect(callbacks.onAudio).not.toHaveBeenCalled();

    server.send({ type: "response.cancelled", response_id: "resp-cancelled" });
    await waitForAssertion(() => {
      expect(callbacks.onEvent).toHaveBeenCalledWith({
        direction: "server",
        type: "response.cancelled",
        itemId: undefined,
        responseId: "resp-cancelled",
      });
    });

    bridge.close();
  });
});
