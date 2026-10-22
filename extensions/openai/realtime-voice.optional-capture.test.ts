import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";

const state = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
const { FakeWebSocket } = state;
const mocks = vi.hoisted(() => ({
  capture: vi.fn<typeof import("openclaw/plugin-sdk/proxy-capture").captureWsEventAsync>(),
  proxyAgent: { fixture: "configured-proxy" },
}));

vi.mock("ws", () => ({ default: FakeWebSocket }));
vi.mock("openclaw/plugin-sdk/proxy-capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/proxy-capture")>()),
  captureWsEventAsync: mocks.capture,
  resolveDebugProxySettings: () => ({ enabled: true }),
  createDebugProxyWebSocketAgent: () => mocks.proxyAgent,
}));

describe.each(["present", "rejected"])("async capture %s", (capture) => {
  beforeEach(() => {
    vi.resetModules();
    FakeWebSocket.instances = [];
    mocks.capture.mockReset().mockResolvedValue(undefined);
    if (capture === "rejected") {
      mocks.capture.mockRejectedValue(new Error("diagnostic store failed"));
    }
  });

  it("preserves proxied realtime events and close", async () => {
    const { buildOpenAIRealtimeVoiceProvider } = await import("./realtime-voice-provider.js");
    const { createNativeBridge, connectReadyBridge, parseSent } = createOpenAIRealtimeTestSupport({
      ...state,
      buildOpenAIRealtimeVoiceProvider,
    });
    const callbacks = { onReady: vi.fn(), onError: vi.fn(), onClose: vi.fn() };
    const bridge = createNativeBridge({
      providerConfig: { apiKey: "fixture-key" },
      ...callbacks,
    });
    try {
      const socket = await connectReadyBridge(bridge);
      expect(socket.args[1]).toMatchObject({ agent: mocks.proxyAgent });
      expect(callbacks.onReady).toHaveBeenCalledOnce();
      bridge.sendAudio(Buffer.from("voice"));
      expect(parseSent(socket)).toContainEqual({
        type: "input_audio_buffer.append",
        audio: Buffer.from("voice").toString("base64"),
      });
      const transportError = new Error("upstream failed");
      socket.emit("error", transportError);
      expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(transportError);
    } finally {
      await bridge.close();
    }
    expect(callbacks.onClose).toHaveBeenCalledExactlyOnceWith("completed");
    expect(mocks.capture.mock.calls.map(([event]) => event)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ direction: "local", kind: "ws-open" }),
        expect.objectContaining({ direction: "outbound", kind: "ws-frame" }),
        expect.objectContaining({ direction: "inbound", kind: "ws-frame" }),
        expect.objectContaining({ direction: "local", kind: "error" }),
        expect.objectContaining({ direction: "local", kind: "ws-close" }),
      ]),
    );
  });

  it("preserves Live session input and graceful close", async () => {
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
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({ meta: { provider: "openai", capability: "gpt-live-voice" } }),
    );
  });
});
