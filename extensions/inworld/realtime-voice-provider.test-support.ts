// Shared Inworld realtime provider test helpers. Test files must mock ./ws-runtime.js
// with FakeWebSocket before importing this module.
import { vi } from "vitest";
import { buildInworldRealtimeVoiceProvider } from "./realtime-voice-provider.js";
import { FakeWebSocket } from "./realtime-voice-socket.test-support.js";

export type FakeWebSocketInstance = InstanceType<typeof FakeWebSocket>;
export type TestBridgeOptions = Parameters<
  ReturnType<typeof buildInworldRealtimeVoiceProvider>["createBridge"]
>[0];
export type TestBridge = ReturnType<
  ReturnType<typeof buildInworldRealtimeVoiceProvider>["createBridge"]
>;
export type SentRealtimeEvent = {
  type: string;
  audio?: string;
  item?: { type?: string; call_id?: string; output?: string };
  item_id?: string;
  audio_end_ms?: number;
  session?: Record<string, unknown>;
};

export function parseSent(socket: FakeWebSocketInstance): SentRealtimeEvent[] {
  return socket.sent.map((payload: string) => JSON.parse(payload) as SentRealtimeEvent);
}

export function requireSession(socket: FakeWebSocketInstance, index = 0): Record<string, unknown> {
  const session = parseSent(socket)[index]?.session;
  if (!session || typeof session !== "object") {
    throw new Error("expected session.update payload");
  }
  return session;
}

export function createTestBridge(options: Partial<TestBridgeOptions> = {}): TestBridge {
  return buildInworldRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "inworld-test" }, // pragma: allowlist secret
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
    ...options,
  });
}

export async function startRealtimeBridge(bridge: TestBridge, index = 0) {
  const connecting = bridge.connect();
  const socket = await FakeWebSocket.waitForInstance(index);
  socket.open();
  socket.emitServer({ type: "session.created" });
  socket.emitServer({ type: "session.updated" });
  return { connecting, socket };
}

export async function openRealtimeBridge(bridge: TestBridge, index = 0) {
  const { connecting, socket } = await startRealtimeBridge(bridge, index);
  await connecting;
  return socket;
}
