// Inworld tests cover inworld plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { FakeWebSocket } = await vi.hoisted(() => import("./realtime-voice-socket.test-support.js"));

// mock-isolation: ws-runtime only exports the ws WebSocket client; tests swap in an in-memory fake so no network socket is ever opened.
vi.mock("./ws-runtime.js", () => ({
  WebSocket: FakeWebSocket,
}));

import { createLazyInworldRealtimeVoiceProvider } from "./realtime-voice-lazy-provider.js";
import { parseSent } from "./realtime-voice-provider.test-support.js";

describe("createLazyInworldRealtimeVoiceProvider", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("queues input before the lazy bridge is ready and flushes it once connected", async () => {
    const provider = createLazyInworldRealtimeVoiceProvider();
    const onReady = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "inworld-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onReady,
    });
    bridge.sendAudio(Buffer.from([7, 8, 9]));
    bridge.sendUserMessage?.("hello");
    const connecting = bridge.connect();
    const socket = await FakeWebSocket.waitForInstance(0);
    socket.open();
    socket.emitServer({ type: "session.created" });
    socket.emitServer({ type: "session.updated" });
    await connecting;
    expect(onReady).toHaveBeenCalledTimes(1);
    const types = parseSent(socket).map((event) => event.type);
    expect(types[0]).toBe("session.update");
    expect(types).toContain("input_audio_buffer.append");
    expect(types).toContain("conversation.item.create");
    expect(bridge.isConnected()).toBe(true);
    void bridge.close();
    expect(bridge.isConnected()).toBe(false);
  });

  it("rejects unsupported requests before loading the runtime", () => {
    const provider = createLazyInworldRealtimeVoiceProvider();
    expect(() =>
      provider.createBridge({
        providerConfig: { apiKey: "k" }, // pragma: allowlist secret
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        autoRespondToAudio: false,
      }),
    ).toThrow(/automatic turn-detection responses/);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
