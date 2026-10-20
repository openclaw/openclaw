import { EventEmitter } from "node:events";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type {
  RealtimeVoiceBridgeCallbacks,
  RealtimeVoiceGatewayControl,
} from "openclaw/plugin-sdk/realtime-voice";
import { vi } from "vitest";
import type { ClientOptions } from "ws";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverVoiceBridge } from "./realtime-quicksilver-bridge.js";
import type { OpenAIQuicksilverSocket } from "./realtime-quicksilver-socket.shared.js";
import { fakeQuicksilverMediaSocket } from "./realtime-quicksilver-socket.test-support.js";

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
    if (!this.deferClose) {
      this.finishClose(1000);
    }
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
}) {
  const socket = new FakeSocket(params?.autoStart, params?.afterOpen);
  socket.deferClose = params?.deferClose ?? false;
  const connections: Array<{ url: string; options: ClientOptions }> = [];
  const callbacks = {
    onAudio: vi.fn<RealtimeVoiceBridgeCallbacks["onAudio"]>(),
    onClearAudio: vi.fn<RealtimeVoiceBridgeCallbacks["onClearAudio"]>(),
    onTranscript: vi.fn<NonNullable<RealtimeVoiceBridgeCallbacks["onTranscript"]>>(),
    onToolCall: vi.fn<NonNullable<RealtimeVoiceBridgeCallbacks["onToolCall"]>>(),
    onReady: vi.fn<NonNullable<RealtimeVoiceBridgeCallbacks["onReady"]>>(),
    onError: vi.fn<NonNullable<RealtimeVoiceBridgeCallbacks["onError"]>>(),
    onClose: vi.fn<NonNullable<RealtimeVoiceBridgeCallbacks["onClose"]>>(),
    onEvent: vi.fn<NonNullable<RealtimeVoiceBridgeCallbacks["onEvent"]>>(),
  };
  const logger = { warn: vi.fn<PluginLogger["warn"]>() };
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
      mediaSocketFactory: fakeQuicksilverMediaSocket((url, options) => {
        connections.push({ url, options });
        queueMicrotask(() => socket.open());
        return socket;
      }),
      ...callbacks,
      handleDelegationInput: params?.handleDelegationInput,
      logger,
    },
    openAIRealtimeHost,
  );
  return { bridge, connections, logger, ...callbacks, socket };
}

export function sentEvents(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}
