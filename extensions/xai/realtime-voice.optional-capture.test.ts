import { beforeEach, expect, it, vi } from "vitest";

const { FakeWebSocket } = await vi.hoisted(() => import("./realtime-voice-socket.test-support.js"));
const mocks = vi.hoisted(() => ({
  capture: vi.fn<typeof import("openclaw/plugin-sdk/proxy-capture").captureWsEventAsync>(),
  proxyAgent: { fixture: "configured-proxy" },
}));

vi.mock("./ws-runtime.js", () => ({ WebSocket: FakeWebSocket }));
vi.mock("openclaw/plugin-sdk/proxy-capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/proxy-capture")>()),
  captureWsEventAsync: mocks.capture,
  resolveDebugProxySettings: () => ({ enabled: true }),
  createDebugProxyWebSocketAgent: () => mocks.proxyAgent,
}));

import {
  createTestBridge,
  openRealtimeBridge,
  parseSent,
} from "./realtime-voice-provider.test-support.js";

beforeEach(() => {
  FakeWebSocket.instances = [];
  mocks.capture.mockReset().mockResolvedValue(undefined);
});

it.each(["present", "rejected"] as const)(
  "preserves proxied realtime events and close when async capture is %s",
  async (capture) => {
    if (capture === "rejected") {
      mocks.capture.mockRejectedValue(new Error("diagnostic store failed"));
    }
    const onReady = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();
    const bridge = createTestBridge({ onReady, onError, onClose });
    try {
      const socket = await openRealtimeBridge(bridge);
      expect(socket.args[1]).toMatchObject({ agent: mocks.proxyAgent });
      expect(onReady).toHaveBeenCalledOnce();
      bridge.sendAudio(Buffer.from("voice"));
      expect(parseSent(socket)).toContainEqual({
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
    expect(mocks.capture.mock.calls.map(([event]) => event)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ direction: "local", kind: "ws-open" }),
        expect.objectContaining({ direction: "outbound", kind: "ws-frame" }),
        expect.objectContaining({ direction: "inbound", kind: "ws-frame" }),
        expect.objectContaining({ direction: "local", kind: "error" }),
        expect.objectContaining({ direction: "local", kind: "ws-close" }),
      ]),
    );
  },
);
