import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { createDecoder } from "libopus-wasm";
import { expect, it, vi } from "vitest";
import type { DiscordAudioEvent } from "./audio-worker-protocol.js";

const fixture = vi.hoisted(() => ({ post: (_event: DiscordAudioEvent) => {} }));
vi.mock("./audio-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./audio-worker.js")>()),
  DiscordAudioWorker: class {
    constructor(_options: unknown, post: typeof fixture.post) {
      fixture.post = post;
    }
    async connect() {}
    async stop() {}
  },
}));

it("transfers decoder-owned PCM without detaching the codec or packet storage", async () => {
  const { port1, port2 } = new MessageChannel();
  vi.doMock("node:worker_threads", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:worker_threads")>()),
    parentPort: port1,
    workerData: {},
  }));
  const decoder = await createDecoder({ sampleRate: 48_000, channels: 2 });
  try {
    await import("./audio-worker.runtime.js");
    // Repeated decoding after transfer must leave the codec's WASM heap usable.
    for (let index = 0; index < 2; index++) {
      const packet = Buffer.from([0xf8, 0xff, 0xfe]);
      const decoded = decoder.decode(packet);
      if (!(decoded.buffer instanceof ArrayBuffer)) {
        throw new Error("Expected independently allocated decoder PCM");
      }
      const pcm = Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength);
      const received = once(port2, "message");
      fixture.post({
        type: "capture-frame",
        id: 1,
        frame: { pcm, packet, receivedAt: index, recordingEpoch: 1n },
      });
      const [event] = (await received) as [Extract<DiscordAudioEvent, { type: "capture-frame" }>];
      expect(event.frame.pcm).toBeInstanceOf(Uint8Array);
      expect(Buffer.isBuffer(event.frame.pcm)).toBe(false);
      expect(event.frame.pcm).toEqual(new Uint8Array(3_840));
      expect(event.frame.packet).toEqual(new Uint8Array([0xf8, 0xff, 0xfe]));
      expect(packet.byteLength).toBe(3);
      expect(decoded.buffer.byteLength).toBe(0);
    }
  } finally {
    decoder.free();
    port1.close();
    port2.close();
    vi.doUnmock("node:worker_threads");
  }
});
