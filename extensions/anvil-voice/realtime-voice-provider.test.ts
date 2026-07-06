// Anvil Voice tests cover realtime provider bridge behavior.
import {
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceAudioFormat,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAnvilRealtimeVoiceProvider,
  resolveAnvilRealtimeUrl,
} from "./realtime-voice-provider.js";

const { FakeWebSocket } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class MockWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readonly listeners = new Map<string, Listener[]>();
    readyState = 0;
    sent: string[] = [];
    closed = false;
    args: unknown[];

    constructor(...args: unknown[]) {
      this.args = args;
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

    send(payload: string): void {
      this.sent.push(payload);
    }

    close(code?: number, reason?: string): void {
      this.closed = true;
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
    }
  }

  return { FakeWebSocket: MockWebSocket };
});

vi.mock("ws", () => ({
  default: FakeWebSocket,
}));

type FakeWebSocketInstance = InstanceType<typeof FakeWebSocket>;
type SentRealtimeEvent = {
  type: string;
  audio?: string;
  event_id?: string;
  item?: {
    content?: Array<{ text?: string; type?: string }>;
    role?: string;
    type?: string;
  };
  session?: {
    audio?: {
      input?: {
        format?: { rate?: number; type?: string };
        turn_detection?: {
          create_response?: boolean;
          interrupt_response?: boolean;
          silence_duration_ms?: number;
          threshold?: number;
        };
      };
      output?: {
        format?: { rate?: number; type?: string };
        voice?: string;
      };
    };
    instructions?: string;
    model?: string;
    output_modalities?: string[];
    type?: string;
  };
};

function parseSent(socket: FakeWebSocketInstance): SentRealtimeEvent[] {
  return socket.sent.map((payload) => JSON.parse(payload) as SentRealtimeEvent);
}

function createOpenBridge(
  overrides: Record<string, unknown> = {},
  requestOverrides: { audioFormat?: RealtimeVoiceAudioFormat | false } = {},
) {
  const provider = buildAnvilRealtimeVoiceProvider();
  const onAudio = vi.fn();
  const onClearAudio = vi.fn();
  const onError = vi.fn();
  const onEvent = vi.fn();
  const onReady = vi.fn();
  const onTranscript = vi.fn();
  const bridge = provider.createBridge({
    providerConfig: {
      realtimeUrl: "ws://127.0.0.1:8765/v1/realtime",
      ...overrides,
    },
    instructions: "Speak briefly.",
    ...(requestOverrides.audioFormat === false
      ? {}
      : { audioFormat: requestOverrides.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ }),
    onAudio,
    onClearAudio,
    onError,
    onEvent,
    onReady,
    onTranscript,
  });
  const connecting = bridge.connect();
  const socket = FakeWebSocket.instances[0];
  if (!socket) {
    throw new Error("expected Anvil websocket");
  }
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");
  return {
    bridge,
    connecting,
    onAudio,
    onClearAudio,
    onError,
    onEvent,
    onReady,
    onTranscript,
    socket,
  };
}

async function finishReady(
  socket: FakeWebSocketInstance,
  connecting: Promise<void>,
): Promise<void> {
  socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
  await connecting;
}

describe("buildAnvilRealtimeVoiceProvider", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("declares gateway-relay realtime Talk capabilities for catalog selection", () => {
    const provider = buildAnvilRealtimeVoiceProvider();

    expect(provider.id).toBe("anvil");
    expect(provider.label).toBe("Anvil Voice");
    expect(provider.defaultModel).toBe("fast-local");
    expect(provider.capabilities).toEqual({
      transports: ["gateway-relay"],
      inputAudioFormats: [
        REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      outputAudioFormats: [
        REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      supportsBrowserSession: false,
      supportsBargeIn: true,
      supportsToolCalls: false,
    });
  });

  it("normalizes base URLs into the Anvil realtime WebSocket endpoint", () => {
    expect(resolveAnvilRealtimeUrl({ baseUrl: "http://127.0.0.1:8765" })).toBe(
      "ws://127.0.0.1:8765/v1/realtime",
    );
    expect(resolveAnvilRealtimeUrl({ baseUrl: "https://anvil.example.test/voice/v1" })).toBe(
      "wss://anvil.example.test/voice/v1/realtime",
    );
  });

  it("rejects loopback hostname aliases and cleartext public WebSocket URLs", () => {
    const loopbackHostnameAlias = ["local", "host"].join("");
    expect(() =>
      resolveAnvilRealtimeUrl({
        realtimeUrl: `ws://${loopbackHostnameAlias}:8765/v1/realtime`,
      }),
    ).toThrow("127.0.0.1");
    expect(() => resolveAnvilRealtimeUrl({ realtimeUrl: "ws://example.test/v1/realtime" })).toThrow(
      "use wss://",
    );
  });

  it("rejects realtime URLs with credentials, query strings, or fragments", () => {
    for (const realtimeUrl of [
      "ws://user:pass@127.0.0.1:8765/v1/realtime",
      "ws://127.0.0.1:8765/v1/realtime?token=secret",
      "ws://127.0.0.1:8765/v1/realtime#token",
    ]) {
      expect(() => resolveAnvilRealtimeUrl({ realtimeUrl })).toThrow(
        "must not include credentials",
      );
    }
  });

  it("requires an explicit Anvil realtime URL before provider selection", () => {
    const provider = buildAnvilRealtimeVoiceProvider();

    expect(provider.isConfigured({ providerConfig: {} })).toBe(false);
    expect(
      provider.isConfigured({
        providerConfig: { baseUrl: "http://127.0.0.1:8765" },
      }),
    ).toBe(true);
  });

  it("connects with bearer auth and sends an Anvil session update", async () => {
    const { connecting, onReady, socket } = createOpenBridge({
      apiKey: "anvil-token",
      model: "fast-local",
      voice: "alloy",
      vadThreshold: 0.4,
      silenceDurationMs: 180,
    });

    await finishReady(socket, connecting);

    const options = socket.args[1] as { headers?: Record<string, string>; maxPayload?: number };
    expect(options.headers?.Authorization).toBe("Bearer anvil-token");
    expect(options.maxPayload).toBe(16 * 1024 * 1024);
    expect(onReady).toHaveBeenCalledTimes(1);
    const sessionUpdate = parseSent(socket)[0];
    expect(sessionUpdate).toEqual({
      type: "session.update",
      session: {
        type: "realtime",
        model: "fast-local",
        instructions: "Speak briefly.",
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 16000 },
            turn_detection: {
              type: "server_vad",
              threshold: 0.4,
              prefix_padding_ms: 0,
              silence_duration_ms: 180,
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: "audio/pcm", rate: 16000 },
            voice: "alloy",
          },
        },
      },
    });
  });

  it("rejects connect when Anvil never acknowledges the session update", async () => {
    vi.useFakeTimers();
    const { connecting, onError } = createOpenBridge();
    const rejected = expect(connecting).rejects.toThrow("session.updated timed out");

    await vi.advanceTimersByTimeAsync(10_000);

    await rejected;
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Anvil Voice realtime session.updated timed out",
      }),
    );
  });

  it("resamples relay audio to Anvil PCM16 and commits after sustained silence", async () => {
    const { bridge, connecting, socket } = createOpenBridge({ silenceDurationMs: 20 });
    await finishReady(socket, connecting);

    bridge.sendAudio(Buffer.alloc(480, 1));
    bridge.sendAudio(Buffer.alloc(960));

    const events = parseSent(socket);
    expect(events.map((event) => event.type)).toEqual([
      "session.update",
      "input_audio_buffer.append",
      "input_audio_buffer.append",
      "input_audio_buffer.commit",
    ]);
    const speechAudio = Buffer.from(events[1]?.audio ?? "", "base64");
    const silenceAudio = Buffer.from(events[2]?.audio ?? "", "base64");
    expect(speechAudio).toHaveLength(320);
    expect(silenceAudio).toHaveLength(640);
  });

  it("treats low-amplitude nonzero PCM as silence for turn commit", async () => {
    const { bridge, connecting, socket } = createOpenBridge({ silenceDurationMs: 20 });
    await finishReady(socket, connecting);
    const lowNoise = Buffer.alloc(960);
    for (let offset = 0; offset < lowNoise.length; offset += 2) {
      lowNoise.writeInt16LE(4, offset);
    }

    bridge.sendAudio(Buffer.alloc(480, 1));
    bridge.sendAudio(lowNoise);

    expect(parseSent(socket).map((event) => event.type)).toEqual([
      "session.update",
      "input_audio_buffer.append",
      "input_audio_buffer.append",
      "input_audio_buffer.commit",
    ]);
  });

  it("defaults to telephony mulaw audio when no relay audio format is supplied", async () => {
    const { bridge, connecting, onAudio, socket } = createOpenBridge({}, { audioFormat: false });
    await finishReady(socket, connecting);

    bridge.sendAudio(Buffer.alloc(160, 0x00));
    const events = parseSent(socket);
    expect(Buffer.from(events[1]?.audio ?? "", "base64")).toHaveLength(640);

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.output_audio.delta",
          delta: Buffer.alloc(640, 3).toString("base64"),
        }),
      ),
    );

    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(onAudio.mock.calls[0]?.[0]).toHaveLength(160);
  });

  it("queues audio before readiness and flushes it after session.updated", async () => {
    const { bridge, connecting, socket } = createOpenBridge({ silenceDurationMs: 20 });

    bridge.sendAudio(Buffer.alloc(480, 1));
    expect(parseSent(socket)).toHaveLength(1);

    await finishReady(socket, connecting);

    expect(parseSent(socket).map((event) => event.type)).toEqual([
      "session.update",
      "input_audio_buffer.append",
    ]);
  });

  it("maps Anvil audio and transcript server events into bridge callbacks", async () => {
    const { connecting, onAudio, onEvent, onTranscript, socket } = createOpenBridge();
    await finishReady(socket, connecting);
    const anvilPcm16k = Buffer.alloc(320, 2);

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.created",
          response: { id: "resp_1", status: "in_progress" },
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "turn-1",
          transcript: "what is the status",
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.output_audio_transcript.delta",
          response_id: "resp_1",
          delta: "The fast tier is ready.",
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.output_audio.delta",
          response_id: "resp_1",
          item_id: "item_1",
          delta: anvilPcm16k.toString("base64"),
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response.done", response: { id: "resp_1" } })),
    );

    expect(onTranscript).toHaveBeenCalledWith("user", "what is the status", true);
    expect(onTranscript).toHaveBeenCalledWith("assistant", "The fast tier is ready.", false);
    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(onAudio.mock.calls[0]?.[0]).toHaveLength(480);
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "response.output_audio.delta",
      itemId: "item_1",
      responseId: "resp_1",
    });
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "response.done",
      itemId: undefined,
      responseId: "resp_1",
    });
  });

  it("deduplicates final user transcripts emitted through both Anvil item events", async () => {
    const { connecting, onTranscript, socket } = createOpenBridge();
    await finishReady(socket, connecting);

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "turn-1",
          transcript: "what is the status",
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.created",
          item: {
            id: "turn-1",
            role: "user",
            content: [{ type: "input_text", text: "what is the status" }],
          },
        }),
      ),
    );

    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("user", "what is the status", true);
  });

  it("sends text turns through conversation.item.create and response.create", async () => {
    const { bridge, connecting, socket } = createOpenBridge();
    await finishReady(socket, connecting);

    bridge.sendUserMessage?.("  Say hello.  ");

    expect(parseSent(socket).slice(-2)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Say hello." }],
        },
      },
      {
        type: "response.create",
        event_id: expect.stringMatching(/^openclaw-anvil-response-create-/),
      },
    ]);
  });

  it("cancels Anvil output and clears relay audio on barge-in", async () => {
    const { bridge, connecting, onClearAudio, onEvent, socket } = createOpenBridge();
    await finishReady(socket, connecting);
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response.created", response: { id: "resp_1" } })),
    );

    bridge.handleBargeIn?.({ audioPlaybackActive: true });

    expect(parseSent(socket).slice(-2)).toEqual([
      {
        type: "response.cancel",
        event_id: expect.stringMatching(/^openclaw-anvil-response-cancel-/),
      },
      { type: "input_audio_buffer.clear" },
    ]);
    expect(onClearAudio).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "response.cancel",
      detail: "reason=barge-in",
      responseId: "resp_1",
    });
  });
});
