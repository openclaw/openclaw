import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import plugin from "./index.js";

// Exercises index.ts registration -> transcribeAudio -> real ffmpeg -> provider socket.
// Requires ffmpeg; the endpoint is local and no provider credential is used.
it("transcribes audio beyond twenty minutes while another transcription completes", async () => {
  const providers: MediaUnderstandingProvider[] = [];
  plugin.register(
    createTestPluginApi({
      registerMediaUnderstandingProvider: (provider) => providers.push(provider),
    }),
  );
  const transcribeAudio = expectDefined(providers[0]?.transcribeAudio, "registered transcription");
  const pcm = Buffer.alloc(1500 * 16_000 * 2);
  const marker = Buffer.alloc(16_000 * 2, 23);
  marker.copy(pcm, 1260 * 16_000 * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  const firstFrame = createDeferred<void>();
  const releaseTranscript = createDeferred<void>();
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          results: { channels: [{ alternatives: [{ transcript: "short note" }] }] },
        }),
      );
    });
  });
  const sockets = new WebSocketServer({ server });
  const frames: Buffer[] = [];
  sockets.on("connection", (socket) => {
    socket.on("message", (data, binary) => {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      if (binary) {
        frames.push(bytes);
        firstFrame.resolve();
        return;
      }
      if (JSON.parse(bytes.toString("utf8")).type === "CloseStream") {
        void releaseTranscript.promise.then(() => {
          const received = Buffer.concat(frames);
          const includesMarker = received.subarray(1260 * 32_000, 1261 * 32_000).equals(marker);
          socket.send(
            JSON.stringify({
              type: "TurnInfo",
              event: "EndOfTurn",
              transcript: includesMarker ? "late marker" : "prefix only",
            }),
          );
          socket.close(1000);
        });
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const request = {
    apiKey: "fixture-key",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    fileName: "long.wav",
    buffer: Buffer.concat([header, pcm]),
    request: { allowPrivateNetwork: true },
    timeoutMs: 20_000,
  };
  try {
    const long = transcribeAudio({ ...request, model: "flux-general-en" });
    await Promise.race([firstFrame.promise, long]);
    const short = await transcribeAudio({
      ...request,
      buffer: Buffer.from("short audio"),
      model: "nova-3",
    });
    expect(short.text).toBe("short note");
    releaseTranscript.resolve();
    expect((await long).text).toBe("late marker");
    const received = Buffer.concat(frames);
    expect(received.length).toBe(pcm.length);
    expect(received.equals(pcm)).toBe(true);
  } finally {
    releaseTranscript.resolve();
    for (const socket of sockets.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => {
      sockets.close(() => server.close(() => resolve()));
    });
  }
}, 30_000);
