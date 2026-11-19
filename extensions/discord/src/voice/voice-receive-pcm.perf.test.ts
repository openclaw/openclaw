import { loadavg } from "node:os";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { DiscordAudioFrame } from "./audio-worker-protocol.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

// OPENCLAW_VOICE_PCM_MEASURE=1: four speakers × 50 frames/s × 20 ms stereo PCM.
// Accelerate the clock, retaining only one tick of pending input. Network/model I/O is synthetic.
defineDiscordVoiceTests((h) => {
  const { expect, it, vi } = h;
  it("delivers exact PCM byte ranges while retaining the received allocation", async () => {
    const measure = process.env.OPENCLAW_VOICE_PCM_MEASURE === "1";
    const { DiscordVoiceRecording } = await import("./voice-recording.js");
    // Keep subscriptions alive; decoded fixtures enter at the IPC boundary below.
    h.decodeOpusStreamChunksMock.mockImplementation(async (input) => {
      input.resume();
      await finished(input);
    });
    const connection = h.useConnection();
    const manager = h.createManager(h.makeVoiceConfig());
    await manager.join({ guildId: "g1", channelId: "1001" });
    await h.startTranscripts(manager, vi.fn());
    const entry = h.getSessionEntry(manager);
    entry.captureOnly = true;
    const subscriptions = vi.spyOn(entry.audio, "subscribe");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const streams: PassThrough[] = [];
    const receiving: Promise<void>[] = [];
    const captures = [];
    for (let speaker = 0; speaker < 4; speaker++) {
      const stream = new PassThrough({ objectMode: true });
      const subscribed = createDeferred<void>();
      connection.receiver.subscribe.mockImplementationOnce(() => {
        subscribed.resolve();
        return stream;
      });
      streams.push(stream);
      receiving.push(h.handleSpeakingStart(manager, entry, `speaker-${speaker}`));
      await subscribed.promise;

      const capture = entry.capture.get(`speaker-${speaker}`)?.stream;
      if (!capture) {
        throw new Error("Missing admitted capture");
      }
      captures.push({
        capture,
        recordingEpoch: Atomics.load(
          new BigInt64Array(h.expectDefined(subscriptions.mock.calls[speaker], "subscription")[1]),
          0,
        ),
      });
    }
    // Nonzero offset and high bytes catch byte-range mistakes and sample truncation.
    const source = new Uint8Array(3_848);
    source.fill(0xee);
    const pcm = source.subarray(4, 3_844);
    for (let byte = 0; byte < pcm.length; byte++) {
      pcm[byte] = byte % 256;
    }
    const expected = Buffer.from(pcm);
    let consumed = createDeferred<void>();
    let count = 0;
    let copiedBytes = 0;
    let last: Buffer | undefined;
    // Observe the real receive owner's downstream boundary; disk/transcription is excluded.
    const append = vi
      .spyOn(DiscordVoiceRecording.prototype, "append")
      .mockImplementation(async (chunk) => {
        last = chunk;
        copiedBytes += chunk.buffer === pcm.buffer ? 0 : chunk.byteLength;
        if (++count % 4 === 0) {
          consumed.resolve();
        }
      });
    try {
      for (let sample = 0; sample < (measure ? 6 : 1); sample++) {
        const ticks = measure ? 2_500 : 2;
        append.mockClear();
        copiedBytes = 0;
        let dispatchMs = 0;
        const cpu = process.threadCpuUsage();
        const started = performance.now();
        for (let tick = 0; tick < ticks; tick++) {
          consumed = createDeferred<void>();
          const start = performance.now();
          for (const { capture, recordingEpoch } of captures) {
            capture.push({
              pcm,
              packet: new Uint8Array([0xf8, 0xff, 0xfe]),
              receivedAt: tick * 20,
              recordingEpoch,
            } satisfies DiscordAudioFrame);
          }
          dispatchMs += performance.now() - start;
          await consumed.promise;
        }
        const elapsedMs = performance.now() - started;
        const used = process.threadCpuUsage(cpu);
        if (measure && sample > 0) {
          console.log(
            JSON.stringify({
              sample,
              frames: ticks * 4,
              dispatchMs,
              elapsedMs,
              cpuUs: used.user + used.system,
              copiedBytes,
              load: loadavg(),
            }),
          );
        }
        expect(last).toEqual(expected);
        if (!measure) {
          expect(copiedBytes).toBe(0);
          expect(last?.buffer).toBe(pcm.buffer);
          expect(last?.byteOffset).toBe(pcm.byteOffset);
        }
      }
    } finally {
      for (const stream of streams) {
        stream.end();
      }
      await Promise.all(receiving);
      append.mockRestore();
      vi.useRealTimers();
    }
  });
});
