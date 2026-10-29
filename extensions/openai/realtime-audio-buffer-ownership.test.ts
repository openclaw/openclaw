import assert from "node:assert/strict";
import { once } from "node:events";
import {
  rawDataToString,
  type RealtimeVoiceBridge,
} from "openclaw/plugin-sdk/realtime-voice-provider";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverVoiceBridge } from "./realtime-quicksilver-bridge.js";
import { OpenAIQuicksilverWorkerSocket } from "./realtime-quicksilver-socket.js";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

type RealtimeProviderKind = "native" | "gpt-live";

async function withRealtimeProvider(
  kind: RealtimeProviderKind,
  expectedAudio: number[],
  prepareAudio: (bridge: RealtimeVoiceBridge) => void,
): Promise<void> {
  const audioEventType = kind === "native" ? "input_audio_buffer.append" : "input_audio.append";
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string", "expected a local realtime WebSocket address");
  const received: Buffer[] = [];
  const acknowledgement =
    kind === "native" ? { type: "session.updated" } : { type: "session.started", session: {} };
  server.once("connection", (socket) => {
    socket.on("message", (payload) => {
      const event = JSON.parse(rawDataToString(payload)) as Record<string, unknown>;
      if (event.type === audioEventType) {
        received.push(Buffer.from(String(event.audio), "base64"));
      }
      if (event.type === "session.update") {
        socket.send(JSON.stringify(acknowledgement));
      }
    });
  });

  const socketUrl = `ws://127.0.0.1:${address.port}`;
  const audioCallbacks = { onAudio: vi.fn(), onClearAudio: vi.fn() };
  const bridge =
    kind === "native"
      ? buildOpenAIRealtimeVoiceProvider().createBridge({
          providerConfig: {
            apiKey: "fixture-local", // pragma: allowlist secret
            azureEndpoint: `http://127.0.0.1:${address.port}`,
            azureDeployment: "fixture-realtime",
          },
          ...audioCallbacks,
        })
      : new OpenAIQuicksilverVoiceBridge(
          {
            providerConfig: {},
            model: "gpt-live-test-canary",
            audioFormat: { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
            resolveAuth: async () => ({ type: "api-key", token: "fixture-local" }),
            mediaSocketFactory: (_url, options, media, callbacks) =>
              OpenAIQuicksilverWorkerSocket.create(socketUrl, options, media, callbacks),
            ...audioCallbacks,
          },
          openAIRealtimeHost,
        );

  try {
    prepareAudio(bridge);
    await bridge.connect();
    await vi.waitFor(() => {
      expect(Buffer.concat(received).length).toBeGreaterThanOrEqual(expectedAudio.length);
    });
  } finally {
    await bridge.close();
    for (const client of server.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  expect(Buffer.concat(received)).toEqual(Buffer.from(expectedAudio));
}

describe("OpenAI realtime queued audio buffer ownership", () => {
  it.each<RealtimeProviderKind>(["native", "gpt-live"])(
    "%s preserves each reusable producer frame until the real WebSocket is ready",
    (kind) =>
      withRealtimeProvider(kind, [0x7f, 0x7f, 0x41, 0x41], (bridge) => {
        // Each view contains a complete PCM16 sample; worker batching may merge frames.
        const producerView = Buffer.alloc(2 * 1024 * 1024, 0x7f).subarray(0, 2);
        bridge.sendAudio(producerView);
        producerView.fill(0x41);
        bridge.sendAudio(producerView);
        producerView.fill(0);
      }),
  );

  it.each<RealtimeProviderKind>(["native", "gpt-live"])(
    "%s rejects oversized producer frames before allocating a queued copy",
    (kind) =>
      withRealtimeProvider(kind, [0x7f, 0x7f], (bridge) => {
        const oversized = Buffer.alloc(1024 * 1024 + 2);
        const copyBuffer = vi.spyOn(Buffer, "from");
        try {
          bridge.sendAudio(oversized);
          expect(copyBuffer.mock.calls.some(([source]) => source === oversized)).toBe(false);
        } finally {
          copyBuffer.mockRestore();
        }
        bridge.sendAudio(Buffer.from([0x7f, 0x7f]));
      }),
  );
});
