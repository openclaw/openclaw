import { createHash } from "node:crypto";
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { FakeWebSocket } = await vi.hoisted(() => import("./realtime-voice-socket.test-support.js"));
// mock-isolation: replace only the external WebSocket; exercise the production bridge.
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
  vi.restoreAllMocks();
});

describe("Inworld response-owned audio truncation", () => {
  it.each([
    { name: "host barge-in", serverVad: false },
    { name: "server VAD", serverVad: true },
  ])("retains distinct pending playback before successor audio on $name", async ({ serverVad }) => {
    const onClearAudio = vi.fn();
    const bridge = createTestBridge({ onMark: vi.fn(), onClearAudio });
    bridges.push(bridge);
    const socket = await openRealtimeBridge(bridge);
    socket.emitServer({ type: "response.created", response: { id: "same-response" } });
    socket.emitServer({
      type: "response.output_item.added",
      response_id: "same-response",
      item: { id: "playing-item", type: "message", role: "assistant" },
    });
    bridge.setMediaTimestamp(0);
    socket.emitServer({
      type: "response.output_audio.delta",
      response_id: "same-response",
      item_id: "playing-item",
      delta: Buffer.alloc(8000).toString("base64"),
    });
    bridge.setMediaTimestamp(250);
    socket.emitServer({
      type: "response.output_item.added",
      response_id: "same-response",
      item: { id: "next-item", type: "message", role: "assistant" },
    });
    if (serverVad) {
      socket.emitServer({ type: "input_audio_buffer.speech_started" });
    } else {
      bridge.handleBargeIn?.({ audioPlaybackActive: true });
    }
    const sent = parseSent(socket);
    expect(onClearAudio).toHaveBeenCalledOnce();
    expect(sent.filter((event) => event.type === "response.cancel")).toHaveLength(
      serverVad ? 0 : 1,
    );
    expect(sent.filter((event) => event.type === "conversation.item.truncate")).toEqual([
      {
        type: "conversation.item.truncate",
        item_id: "playing-item",
        content_index: 0,
        audio_end_ms: 83,
      },
    ]);
  });

  it.each([
    { audioFormat: undefined, bytesPerMs: 8 },
    { audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ, bytesPerMs: 48 },
  ])(
    "resets a reused item at its added receipt ($bytesPerMs bytes/ms)",
    async ({ audioFormat, bytesPerMs }) => {
      const bridge = createTestBridge({
        audioFormat,
        getPlaybackState: () => [{ itemId: "shared", audioEndMs: 9000 }],
      });
      bridges.push(bridge);
      const socket = await openRealtimeBridge(bridge);
      socket.emitServer({ type: "response.created", response: { id: "response-1" } });
      socket.emitServer({
        type: "response.output_audio.delta",
        response_id: "response-1",
        item_id: "shared",
        delta: Buffer.alloc(4000 * bytesPerMs).toString("base64"),
      });
      socket.emitServer({
        type: "response.output_item.added",
        response_id: "response-1",
        item: { id: "shared", type: "message", role: "assistant" },
      });
      socket.emitServer({
        type: "response.output_audio.delta",
        response_id: "response-1",
        item_id: "shared",
        delta: Buffer.alloc(1000 * bytesPerMs).toString("base64"),
      });
      socket.emitServer({
        type: "response.done",
        response: { id: "response-1", status: "completed" },
      });
      bridge.handleBargeIn?.({ audioPlaybackActive: true });
      socket.emitServer({ type: "response.created", response: { id: "response-2" } });
      socket.emitServer({
        type: "response.output_item.added",
        response_id: "response-2",
        item: { id: "shared", type: "message", role: "assistant" },
      });
      socket.emitServer({
        type: "response.output_audio.delta",
        response_id: "response-2",
        item_id: "shared",
        delta: Buffer.alloc(2000 * bytesPerMs).toString("base64"),
      });
      bridge.handleBargeIn?.({ audioPlaybackActive: true });
      expect(
        parseSent(socket).filter((event) => event.type === "conversation.item.truncate"),
      ).toEqual([
        {
          type: "conversation.item.truncate",
          item_id: "shared",
          content_index: 0,
          audio_end_ms: bytesPerMs === 8 ? 333 : 1000,
        },
        {
          type: "conversation.item.truncate",
          item_id: "shared",
          content_index: 0,
          audio_end_ms: bytesPerMs === 8 ? 666 : 2000,
        },
      ]);
    },
  );

  it("bounds two responses sharing an item ID by the latest response bytes", async () => {
    const bridge = createTestBridge({
      getPlaybackState: () => [{ itemId: "shared", audioEndMs: 9000 }],
    });
    bridges.push(bridge);
    const socket = await openRealtimeBridge(bridge);
    for (const [responseId, bytes] of [
      ["response-1", 32000],
      ["response-2", 16000],
    ] as const) {
      socket.emitServer({ type: "response.created", response: { id: responseId } });
      socket.emitServer({
        type: "response.output_item.added",
        response_id: responseId,
        item: { id: "shared", type: "message", role: "assistant" },
      });
      socket.emitServer({
        type: "response.output_audio.delta",
        response_id: responseId,
        item_id: "shared",
        delta: Buffer.alloc(bytes).toString("base64"),
      });
      socket.emitServer({
        type: "response.done",
        response: { id: responseId, status: "completed" },
      });
    }
    bridge.handleBargeIn?.({ audioPlaybackActive: true });
    expect(
      parseSent(socket).find((event) => event.type === "conversation.item.truncate")?.audio_end_ms,
    ).toBe(666);
  });

  it("does not inherit prior bytes before the reused successor item produces audio", async () => {
    const bridge = createTestBridge({
      getPlaybackState: () => [{ itemId: "shared", audioEndMs: 9000 }],
    });
    bridges.push(bridge);
    const socket = await openRealtimeBridge(bridge);
    socket.emitServer({ type: "response.created", response: { id: "response-1" } });
    socket.emitServer({
      type: "response.output_audio.delta",
      response_id: "response-1",
      item_id: "shared",
      delta: Buffer.alloc(8000).toString("base64"),
    });
    socket.emitServer({
      type: "response.done",
      response: { id: "response-1", status: "completed" },
    });
    socket.emitServer({ type: "response.created", response: { id: "response-2" } });
    socket.emitServer({
      type: "response.output_item.added",
      response_id: "response-2",
      item: { id: "shared", type: "message", role: "assistant" },
    });
    bridge.handleBargeIn?.({ audioPlaybackActive: true });
    expect(
      parseSent(socket).find((event) => event.type === "conversation.item.truncate")?.audio_end_ms,
    ).toBe(0);
  });

  it("publishes the new item bound before an observer interrupts", async () => {
    const bridge = createTestBridge({
      getPlaybackState: () => [{ itemId: "shared", audioEndMs: 9000 }],
      onEvent: (event) => {
        if (event.direction === "server" && event.type === "response.output_item.added") {
          bridge.handleBargeIn?.({ audioPlaybackActive: true });
        }
      },
    });
    bridges.push(bridge);
    const socket = await openRealtimeBridge(bridge);
    socket.emitServer({ type: "response.created", response: { id: "response-1" } });
    socket.emitServer({
      type: "response.output_audio.delta",
      response_id: "response-1",
      item_id: "shared",
      delta: Buffer.alloc(8000).toString("base64"),
    });
    socket.emitServer({
      type: "response.output_item.added",
      response_id: "response-1",
      item: { id: "shared", type: "message", role: "assistant" },
    });
    expect(
      parseSent(socket).find((event) => event.type === "conversation.item.truncate")?.audio_end_ms,
    ).toBe(0);
  });

  it.each([false, true])(
    "journals redacted truncate metadata with negotiated format reported=%s",
    async (reported) => {
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      const bridge = createTestBridge({
        getPlaybackState: () => [{ itemId: "private-item", audioEndMs: 9000 }],
      });
      bridges.push(bridge);
      const socket = await openRealtimeBridge(bridge);
      if (reported) {
        socket.emitServer({
          type: "session.updated",
          session: {
            audio: {
              output: {
                format: { type: "audio/pcm", rate: 24000, private_field: "private-format-content" },
              },
            },
            instructions: "private-instructions",
          },
        });
      }
      socket.emitServer({ type: "response.created", response: { id: "private-response" } });
      const delta = Buffer.alloc(8000, 7).toString("base64");
      socket.emitServer({
        type: "response.output_audio.delta",
        response_id: "private-response",
        item_id: "private-item",
        delta,
      });
      bridge.handleBargeIn?.({ audioPlaybackActive: true });
      const line = log.mock.calls.find(([entry]) =>
        String(entry).startsWith("[inworld] truncate "),
      )?.[0];
      expect(line).toBeTypeOf("string");
      const receipt = JSON.parse(String(line).slice("[inworld] truncate ".length));
      const fingerprint = (id: string) =>
        createHash("sha256").update(id).digest("hex").slice(0, 16);
      expect(receipt).toMatchObject({
        response_id: fingerprint("private-response"),
        item_id: fingerprint("private-item"),
        counted_bytes: 8000,
        audio_end_ms: 333,
        audioFormat: { encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 },
        negotiated_output_format: reported ? { type: "audio/pcm", rate: 24000 } : null,
      });
      for (const privateText of [
        "private-item",
        "private-response",
        "private-format-content",
        "private-instructions",
        "inworld-test",
        delta,
      ]) {
        expect(String(line)).not.toContain(privateText);
      }
    },
  );
});
