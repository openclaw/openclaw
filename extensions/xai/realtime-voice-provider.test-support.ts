// Shared xAI realtime provider test helpers. Test files must mock ./ws-runtime.js
// with FakeWebSocket before importing this module.
import { expect, vi } from "vitest";
import { buildXaiRealtimeVoiceProvider } from "./realtime-voice-provider.js";
import { FakeWebSocket } from "./realtime-voice-socket.test-support.js";

export type FakeWebSocketInstance = InstanceType<typeof FakeWebSocket>;
export type TestBridgeOptions = Parameters<
  ReturnType<typeof buildXaiRealtimeVoiceProvider>["createBridge"]
>[0];
export type TestBridge = ReturnType<
  ReturnType<typeof buildXaiRealtimeVoiceProvider>["createBridge"]
>;
export type SentRealtimeEvent = {
  type: string;
  audio?: string;
  item?: {
    type?: string;
  };
  session?: {
    voice?: string;
    model?: string;
    turn_detection?: {
      type?: string;
      threshold?: number;
      silence_duration_ms?: number;
      prefix_padding_ms?: number;
    };
    audio?: {
      input?: { format?: Record<string, unknown>; transcription?: Record<string, unknown> };
      output?: { format?: Record<string, unknown> };
    };
    resumption?: {
      enabled?: boolean;
    };
    reasoning?: {
      effort?: string;
    };
    tools?: unknown[];
    tool_choice?: string;
  };
};

export function waitForRealtimeState<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { interval: 1 });
}

export function parseSent(socket: FakeWebSocketInstance): SentRealtimeEvent[] {
  return socket.sent.map((payload: string) => JSON.parse(payload) as SentRealtimeEvent);
}

export function requireSocket(index = 0): FakeWebSocketInstance {
  const socket = FakeWebSocket.instances[index];
  if (!socket) {
    throw new Error(`expected xAI realtime socket at index ${index}`);
  }
  return socket;
}

export function requireSession(socket: FakeWebSocketInstance, index = 0): Record<string, unknown> {
  const session = parseSent(socket)[index]?.session;
  if (!session || typeof session !== "object") {
    throw new Error("expected session.update payload");
  }
  return session as Record<string, unknown>;
}

export function createTestBridge(options: Partial<TestBridgeOptions> = {}): TestBridge {
  return buildXaiRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
    ...options,
  });
}

export async function startRealtimeBridge(bridge: TestBridge, index = 0, conversationId?: string) {
  const connecting = bridge.connect();
  await waitForRealtimeState(() => expect(FakeWebSocket.instances.length).toBe(index + 1));
  const socket = requireSocket(index);
  socket.open();
  if (conversationId) {
    socket.emitServer({ type: "conversation.created", conversation: { id: conversationId } });
  }
  socket.emitServer({ type: "session.updated" });
  return { connecting, socket };
}

export async function openRealtimeBridge(bridge: TestBridge, index = 0, conversationId?: string) {
  const { connecting, socket } = await startRealtimeBridge(bridge, index, conversationId);
  await connecting;
  return socket;
}
