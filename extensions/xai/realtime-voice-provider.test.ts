// Xai tests cover realtime voice provider plugin behavior.
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import type { RealtimeVoiceBridge } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildXaiRealtimeVoiceProvider,
  xaiRealtimeVoiceProviderInternalsForTest,
} from "./realtime-voice-provider.js";

const { FakeWebSocket, isProviderAuthProfileConfiguredMock, resolveApiKeyForProviderMock } =
  vi.hoisted(() => {
    type Listener = (...args: unknown[]) => void;

    class MockWebSocket {
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static instances: MockWebSocket[] = [];

      readonly listeners = new Map<string, Listener[]>();
      readyState = 0;
      sent: string[] = [];
      closed = false;
      terminated = false;
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

      terminate(): void {
        this.terminated = true;
        this.close(1006, "terminated");
      }
    }

    return {
      FakeWebSocket: MockWebSocket,
      isProviderAuthProfileConfiguredMock: vi.fn(() => false),
      resolveApiKeyForProviderMock: vi.fn(
        async (): Promise<{ apiKey: string | undefined }> => ({ apiKey: undefined }),
      ),
    };
  });

vi.mock("ws", () => ({
  default: FakeWebSocket,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: isProviderAuthProfileConfiguredMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

type FakeWebSocketInstance = InstanceType<typeof FakeWebSocket>;
type RealtimeVoiceBridgeWithSpeakText = RealtimeVoiceBridge & {
  speakText?: (text: string, options?: { mode?: "exact" | "natural"; source?: string }) => void;
};
type SentRealtimeEvent = {
  type: string;
  audio?: string;
  item_id?: string;
  content_index?: number;
  audio_end_ms?: number | null;
  session?: {
    model?: string;
    instructions?: string;
    voice?: string;
    turn_detection?: {
      type?: string;
      threshold?: number;
      prefix_padding_ms?: number;
      silence_duration_ms?: number;
      create_response?: boolean;
      interrupt_response?: boolean;
    };
    audio?: {
      input?: {
        format?: Record<string, unknown>;
        transcription?: Record<string, unknown>;
      };
      output?: {
        format?: Record<string, unknown>;
      };
    };
    tools?: unknown[];
    tool_choice?: string;
  };
  item?: unknown;
};

function parseSent(socket: FakeWebSocketInstance): SentRealtimeEvent[] {
  return socket.sent.map((payload: string) => JSON.parse(payload) as SentRealtimeEvent);
}

async function connectBridge(bridge: RealtimeVoiceBridge): Promise<FakeWebSocketInstance> {
  const connecting = bridge.connect();
  await vi.waitFor(() => {
    expect(FakeWebSocket.instances[0]).toBeDefined();
  });
  const socket = FakeWebSocket.instances[0];
  if (!socket) {
    throw new Error("expected bridge to create a websocket");
  }
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");
  socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
  await connecting;
  return socket;
}

function requireSession(socket: FakeWebSocketInstance): NonNullable<SentRealtimeEvent["session"]> {
  const session = parseSent(socket).find((event) => event.type === "session.update")?.session;
  if (!session) {
    throw new Error("expected session.update");
  }
  return session;
}

describe("xai realtime voice provider", () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    isProviderAuthProfileConfiguredMock.mockReset();
    isProviderAuthProfileConfiguredMock.mockReturnValue(false);
    resolveApiKeyForProviderMock.mockReset();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: undefined });
    delete process.env.XAI_API_KEY;
    delete process.env.XAI_BASE_URL;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes xAI realtime voice config and reports gateway relay capabilities", () => {
    const provider = buildXaiRealtimeVoiceProvider();

    expect(provider.id).toBe("xai");
    expect(provider.defaultModel).toBe("grok-voice-think-fast-1.0");
    expect(provider.models).toContain("grok-voice-latest");
    expect(provider.capabilities?.transports).toEqual(["gateway-relay"]);
    expect(provider.capabilities?.supportsToolCalls).toBe(true);
    expect(provider.capabilities?.supportsBargeIn).toBe(true);
    expect(
      provider.resolveConfig?.({
        cfg: {} as never,
        rawConfig: {
          providers: {
            xai: {
              apiKey: "xai-test-key",
              baseUrl: "https://api.x.ai/v1",
              model: "grok-voice-latest",
              voice: "leo",
              vadThreshold: 0.7,
              silenceDurationMs: 650,
              prefixPaddingMs: 250,
              interruptResponseOnInputAudio: false,
            },
          },
        },
      }),
    ).toEqual({
      apiKey: "xai-test-key",
      baseUrl: "https://api.x.ai/v1",
      model: "grok-voice-latest",
      voice: "leo",
      vadThreshold: 0.7,
      silenceDurationMs: 650,
      prefixPaddingMs: 250,
      interruptResponseOnInputAudio: false,
      minBargeInAudioEndMs: undefined,
    });
  });

  it("opens the xAI realtime websocket and sends a native voice session update", async () => {
    const provider = buildXaiRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: {
        apiKey: "xai-test-key",
        model: "grok-voice-latest",
        voice: "leo",
        vadThreshold: 0.7,
        silenceDurationMs: 650,
        prefixPaddingMs: 250,
      },
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      instructions: "Keep replies concise.",
      tools: [
        {
          type: "function",
          name: "openclaw_agent_consult",
          description: "Consult OpenClaw",
          parameters: { type: "object", properties: {} },
        },
      ],
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    const socket = await connectBridge(bridge);

    expect(socket.args[0]).toBe("wss://api.x.ai/v1/realtime?model=grok-voice-latest");
    expect(socket.args[1]).toEqual({
      headers: {
        Authorization: "Bearer xai-test-key",
        "User-Agent": expect.stringMatching(/^openclaw\//),
      },
    });
    const session = requireSession(socket);
    expect(session.model).toBeUndefined();
    expect(session.instructions).toBe("Keep replies concise.");
    expect(session.voice).toBe("leo");
    expect(session.turn_detection).toEqual({
      type: "server_vad",
      threshold: 0.7,
      prefix_padding_ms: 250,
      silence_duration_ms: 650,
      create_response: true,
      interrupt_response: true,
    });
    expect(session.audio?.input).toEqual({
      format: { type: "audio/pcm", rate: 24000 },
      transcription: { model: "grok-transcribe" },
    });
    expect(session.audio?.output).toEqual({
      format: { type: "audio/pcm", rate: 24000 },
    });
    expect(session.tool_choice).toBe("auto");
    expect(session.tools).toHaveLength(1);
    expect(bridge.isConnected()).toBe(true);
  });

  it("emits inbound speech transcript updates for meeting and voice surfaces", async () => {
    const provider = buildXaiRealtimeVoiceProvider();
    const onAudio = vi.fn();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test-key" },
      onAudio,
      onClearAudio: vi.fn(),
      onTranscript,
    });
    const socket = await connectBridge(bridge);
    const audio = Buffer.from("assistant audio");

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.updated",
          transcript: "we should enable meeting transcription",
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.output_audio.delta",
          item_id: "item_1",
          delta: audio.toString("base64"),
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.output_audio_transcript.done",
          transcript: "Enabled through xAI realtime.",
        }),
      ),
    );

    expect(onTranscript).toHaveBeenCalledWith(
      "user",
      "we should enable meeting transcription",
      false,
    );
    expect(onAudio).toHaveBeenCalledWith(audio);
    expect(onTranscript).toHaveBeenCalledWith("assistant", "Enabled through xAI realtime.", true);
  });

  it("maps OpenAI-compatible function calls and tool result continuation", async () => {
    const provider = buildXaiRealtimeVoiceProvider();
    const onToolCall = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall,
    });
    const socket = await connectBridge(bridge);

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          item_id: "item_1",
          call_id: "call_1",
          name: "openclaw_agent_consult",
          arguments: JSON.stringify({ question: "status" }),
        }),
      ),
    );
    bridge.submitToolResult("call_1", { text: "done" }, { willContinue: true });
    bridge.submitToolResult("call_1", { text: "final" });

    expect(onToolCall).toHaveBeenCalledWith({
      itemId: "item_1",
      callId: "call_1",
      name: "openclaw_agent_consult",
      args: { question: "status" },
    });
    expect(parseSent(socket).slice(-3)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_1",
          output: JSON.stringify({ text: "done" }),
        },
      },
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_1",
          output: JSON.stringify({ text: "final" }),
        },
      },
      { type: "response.create" },
    ]);
  });

  it("uses xAI force_message for exact provider speech", async () => {
    const provider = buildXaiRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });
    const socket = await connectBridge(bridge);

    (bridge as RealtimeVoiceBridgeWithSpeakText).speakText?.("This call is being recorded.", {
      mode: "exact",
      source: "agent-final",
    });

    expect(parseSent(socket).slice(-1)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "force_message",
          role: "assistant",
          interruptible: true,
          content: [{ type: "output_text", text: "This call is being recorded." }],
        },
      },
    ]);
  });

  it("resolves xAI OAuth/profile auth when no API key is configured", async () => {
    delete process.env.XAI_API_KEY;
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "oauth-bearer" });
    const provider = buildXaiRealtimeVoiceProvider();
    const cfg = { agents: { defaults: {} } };
    const bridge = provider.createBridge({
      cfg,
      providerConfig: {},
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    const socket = await connectBridge(bridge);

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith({ provider: "xai", cfg });
    expect(socket.args[1]).toEqual({
      headers: {
        Authorization: "Bearer oauth-bearer",
        "User-Agent": expect.stringMatching(/^openclaw\//),
      },
    });
  });

  it("reports configured when an xAI auth profile exists", () => {
    delete process.env.XAI_API_KEY;
    isProviderAuthProfileConfiguredMock.mockReturnValue(true);
    const provider = buildXaiRealtimeVoiceProvider();

    expect(provider.isConfigured({ cfg: {}, providerConfig: {} })).toBe(true);
    expect(isProviderAuthProfileConfiguredMock).toHaveBeenCalledWith({ provider: "xai", cfg: {} });
  });

  it("builds websocket urls from custom xAI-compatible base urls", () => {
    expect(
      xaiRealtimeVoiceProviderInternalsForTest.toXaiRealtimeWsUrl({
        baseUrl: "http://127.0.0.1:9999/v1",
        model: "grok-voice-think-fast-1.0",
      }),
    ).toBe("ws://127.0.0.1:9999/v1/realtime?model=grok-voice-think-fast-1.0");
  });
});
