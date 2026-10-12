import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { beforeEach, expect, it, vi } from "vitest";

const { FakeWebSocket } = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
const mocks = vi.hoisted(() => ({
  captureAvailable: true,
  capture: vi.fn<typeof import("openclaw/plugin-sdk/proxy-capture").captureWsEventAsync>(),
  proxyAgent: { fixture: "configured-proxy" },
}));

vi.mock("ws", () => ({ default: FakeWebSocket }));
vi.mock("openclaw/plugin-sdk/proxy-capture", () => ({
  get captureWsEventAsync() {
    return mocks.captureAvailable ? mocks.capture : undefined;
  },
  resolveDebugProxySettings: () => ({ enabled: true }),
  createDebugProxyWebSocketAgent: () => mocks.proxyAgent,
}));

beforeEach(() => {
  vi.resetModules();
  FakeWebSocket.instances = [];
  mocks.capture.mockReset().mockResolvedValue(undefined);
});

it.each(["absent", "present", "rejected"] as const)(
  "preserves proxied realtime events and close when async capture is %s",
  async (capture) => {
    mocks.captureAvailable = capture !== "absent";
    if (capture === "rejected") {
      mocks.capture.mockRejectedValue(new Error("diagnostic store failed"));
    }
    const { buildOpenAIRealtimeVoiceProvider } = await import("./realtime-voice-provider.js");
    const onReady = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();
    const bridge = buildOpenAIRealtimeVoiceProvider().createBridge({
      providerConfig: { apiKey: "fixture-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onReady,
      onError,
      onClose,
    });
    try {
      const connecting = bridge.connect();
      const socket = FakeWebSocket.instances[0];
      if (!socket) {
        throw new Error("OpenAI realtime socket is unavailable");
      }
      expect(socket.args[1]).toMatchObject({ agent: mocks.proxyAgent });
      socket.readyState = FakeWebSocket.OPEN;
      socket.emit("open");
      socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
      await connecting;
      expect(onReady).toHaveBeenCalledOnce();
      bridge.sendAudio(Buffer.from("voice"));
      expect(socket.sent.map((payload) => JSON.parse(payload))).toContainEqual({
        type: "input_audio_buffer.append",
        audio: Buffer.from("voice").toString("base64"),
      });
      const transportError = new Error("upstream failed");
      socket.emit("error", transportError);
      expect(onError).toHaveBeenCalledExactlyOnceWith(transportError);
    } finally {
      await bridge.close();
    }
    expect(onClose).toHaveBeenCalledExactlyOnceWith("completed");
    if (capture === "absent") {
      expect(mocks.capture).not.toHaveBeenCalled();
    } else {
      expect(mocks.capture.mock.calls.map(([event]) => event)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ direction: "local", kind: "ws-open" }),
          expect.objectContaining({ direction: "outbound", kind: "ws-frame" }),
          expect.objectContaining({ direction: "inbound", kind: "ws-frame" }),
          expect.objectContaining({ direction: "local", kind: "error" }),
          expect.objectContaining({ direction: "local", kind: "ws-close" }),
        ]),
      );
    }
  },
);

it.each(["absent", "present", "rejected"] as const)(
  "preserves Live session input and graceful close when async capture is %s",
  async (capture) => {
    mocks.captureAvailable = capture !== "absent";
    if (capture === "rejected") {
      mocks.capture.mockRejectedValue(new Error("diagnostic store failed"));
    }
    const { createHarness, sentEvents } =
      await import("./realtime-quicksilver-bridge.test-support.js");
    const harness = createHarness({ model: "gpt-live-1" });
    try {
      await harness.bridge.connect();
      expect(harness.onReady).toHaveBeenCalledOnce();
      harness.bridge.sendUserMessage("Hello");
      expect(sentEvents(harness.socket)).toContainEqual({
        type: "session.commentary.append",
        delegation_id: null,
        content: "Hello",
      });
      harness.socket.serverEvent({
        type: "session.input_transcript.delta",
        delta: "Spoken words",
        start_ms: 0,
        end_ms: 100,
      });
      expect(harness.onTranscript).toHaveBeenCalledWith("user", "Spoken words", false);
    } finally {
      const closing = harness.bridge.close();
      harness.socket.serverEvent({ type: "session.closed", reason: "close_requested" });
      await closing;
    }
    expect(harness.onClose).toHaveBeenCalledExactlyOnceWith("completed");
    expect(harness.onError).not.toHaveBeenCalled();
    if (capture === "absent") {
      expect(mocks.capture).not.toHaveBeenCalled();
    } else {
      expect(mocks.capture).toHaveBeenCalledWith(
        expect.objectContaining({ meta: { provider: "openai", capability: "gpt-live-voice" } }),
      );
    }
  },
);
