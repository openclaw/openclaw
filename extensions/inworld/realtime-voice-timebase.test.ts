import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { FakeWebSocket } = await vi.hoisted(() => import("./realtime-voice-socket.test-support.js"));
// mock-isolation: exercise the real bridge, replacing only the external WebSocket.
vi.mock("./ws-runtime.js", () => ({ WebSocket: FakeWebSocket }));

import {
  createTestBridge,
  openRealtimeBridge,
  parseSent,
  type TestBridge,
} from "./realtime-voice-provider.test-support.js";

const bridges: TestBridge[] = [];
beforeEach(() => {
  FakeWebSocket.instances = [];
});
afterEach(() => {
  for (const bridge of bridges.splice(0)) {
    void bridge.close();
  }
});

describe("Inworld PCMU truncate timebase", () => {
  // Call 54d37d50: counted bytes, real playback ms, provider byte-duration bound.
  const livePairs = [
    { bytes: 89344, realMs: 7873, boundMs: 3722, expectedMs: 2624 },
    { bytes: 99652, realMs: 6413, boundMs: 4152, expectedMs: 2137 },
    { bytes: 227159, realMs: 8813, boundMs: 9464, expectedMs: 2937 },
    { bytes: 207863, realMs: 5140, boundMs: 8660, expectedMs: 1713 },
  ];
  for (const native of [false, true]) {
    for (const clamp of [false, true]) {
      it.each(livePairs)(
        `converts live $bytes-byte playback (native=${native}, clamp=${clamp})`,
        async ({ bytes, realMs, boundMs, expectedMs }) => {
          const playbackMs = clamp ? 100000 : realMs;
          const bridge = createTestBridge({
            onMark: vi.fn(),
            getPlaybackState: native
              ? () => [{ itemId: "live-item", audioEndMs: playbackMs }]
              : undefined,
          });
          bridges.push(bridge);
          const socket = await openRealtimeBridge(bridge);
          socket.emitServer({ type: "response.created", response: { id: "live-response" } });
          bridge.setMediaTimestamp(0);
          socket.emitServer({
            type: "response.output_audio.delta",
            response_id: "live-response",
            item_id: "live-item",
            delta: Buffer.alloc(bytes).toString("base64"),
          });
          bridge.setMediaTimestamp(playbackMs);
          bridge.handleBargeIn?.({ audioPlaybackActive: true });
          const truncate = parseSent(socket).find(
            (event) => event.type === "conversation.item.truncate",
          );
          expect(truncate?.audio_end_ms).toBe(clamp ? boundMs : expectedMs);
          expect(truncate?.audio_end_ms).toBeLessThanOrEqual(boundMs);
        },
      );
    }
  }
});
