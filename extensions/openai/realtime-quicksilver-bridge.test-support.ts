import { EventEmitter } from "node:events";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type {
  RealtimeVoiceBridgeCallbacks,
  RealtimeVoiceGatewayControl,
} from "openclaw/plugin-sdk/realtime-voice";
import { vi, type Mock } from "vitest";
import type { ClientOptions } from "ws";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverVoiceBridge } from "./realtime-quicksilver-bridge.js";
import type {
  OpenAIQuicksilverSocket,
  OpenAIQuicksilverSocketFactory,
} from "./realtime-quicksilver-sideband.js";

export class FakeSocket extends EventEmitter implements OpenAIQuicksilverSocket {
  readyState = 0;
  readonly sent: string[] = [];
  closeCalls = 0;
  deferClose = false;

  open(): void {
    this.readyState = 1;
    this.emit("open");
    this.afterOpen?.(this);
  }

  send(payload: string): void {
    this.sent.push(payload);
    const event = JSON.parse(payload) as { type?: string };
    if ((event.type === "session.update" || event.type === "session.start") && this.autoStart) {
      queueMicrotask(() =>
        this.serverEvent({
          type: "session.started",
          session: { id: "live-1", expires_at: Math.floor(Date.now() / 1000) + 60 },
        }),
      );
    }
  }

  close(): void {
    if (this.readyState === 3) {
      return;
    }
    this.closeCalls += 1;
    if (this.deferClose) {
      return;
    }
    this.finishClose(1000);
  }

  finishClose(code = 1006): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", code, Buffer.alloc(0)));
  }

  serverEvent(event: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(event)), false);
  }

  constructor(
    private readonly autoStart = true,
    private readonly afterOpen?: (socket: FakeSocket) => void,
  ) {
    super();
  }
}

export function createHarness(params?: {
  audioFormat?: "pcm16" | "g711_ulaw";
  handleDelegationInput?: RealtimeVoiceGatewayControl["handleDelegationInput"];
  autoStart?: boolean;
  deferClose?: boolean;
  afterOpen?: (socket: FakeSocket) => void;
  model?: string;
  resolveAuth?: () => Promise<{ type: "api-key"; token: string }>;
  mockDefaultSocket?: { mockImplementation: (factory: OpenAIQuicksilverSocketFactory) => void };
}) {
  const socket = new FakeSocket(params?.autoStart, params?.afterOpen);
  socket.deferClose = params?.deferClose ?? false;
  const connections: Array<{ url: string; options: ClientOptions }> = [];
  const webSocketFactory: OpenAIQuicksilverSocketFactory = (url, options) => {
    connections.push({ url, options });
    queueMicrotask(() => socket.open());
    return socket;
  };
  if (params?.mockDefaultSocket) {
    params.mockDefaultSocket.mockImplementation(function (url: string, options: ClientOptions) {
      connections.push({ url, options });
      queueMicrotask(() => socket.open());
      return socket;
    });
  }
  const onAudio: Mock<RealtimeVoiceBridgeCallbacks["onAudio"]> = vi.fn();
  const onClearAudio: Mock<RealtimeVoiceBridgeCallbacks["onClearAudio"]> = vi.fn();
  const onTranscript: Mock<NonNullable<RealtimeVoiceBridgeCallbacks["onTranscript"]>> = vi.fn();
  const onToolCall: Mock<NonNullable<RealtimeVoiceBridgeCallbacks["onToolCall"]>> = vi.fn();
  const onReady: Mock<NonNullable<RealtimeVoiceBridgeCallbacks["onReady"]>> = vi.fn();
  const onError: Mock<NonNullable<RealtimeVoiceBridgeCallbacks["onError"]>> = vi.fn();
  const onClose: Mock<NonNullable<RealtimeVoiceBridgeCallbacks["onClose"]>> = vi.fn();
  const onEvent: Mock<NonNullable<RealtimeVoiceBridgeCallbacks["onEvent"]>> = vi.fn();
  const logger: { warn: Mock<PluginLogger["warn"]> } = { warn: vi.fn() };
  const bridge = new OpenAIQuicksilverVoiceBridge(
    {
      providerConfig: {},
      model: params?.model ?? "gpt-live-test-canary",
      voice: "spruce",
      instructions: "Use delegation for real work.",
      audioFormat:
        params?.audioFormat === "g711_ulaw"
          ? { encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 }
          : { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
      resolveAuth: params?.resolveAuth ?? (async () => ({ type: "api-key", token: "test-key" })),
      ...(params?.mockDefaultSocket ? {} : { webSocketFactory }),
      onAudio,
      onClearAudio,
      onTranscript,
      onToolCall,
      handleDelegationInput: params?.handleDelegationInput,
      onReady,
      onError,
      onClose,
      onEvent,
      logger,
    },
    openAIRealtimeHost,
  );
  return {
    bridge,
    connections,
    logger,
    onAudio,
    onClearAudio,
    onClose,
    onError,
    onEvent,
    onReady,
    onToolCall,
    onTranscript,
    socket,
  };
}

export function sentEvents(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}
