import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

// Run with OPENCLAW_VOICE_CAPTURE_MEASURE=1 to emit owner timing/allocation evidence.
// The SDK socket and transcription service are synthetic; Opus decode and WAV I/O are real.
defineDiscordVoiceTests((h) => {
  const { expect, it, vi } = h;
  it("releases four full-size partial recordings after packet inactivity", async () => {
    const audio = await vi.importActual<typeof import("./audio.js")>("./audio.js");
    const { DiscordVoiceRecording } = await import("./voice-recording.js");
    h.decodeOpusStreamChunksMock.mockImplementation(audio.decodeOpusStreamChunks);
    const connection = h.useConnection();
    const manager = h.createManager(h.makeVoiceConfig());
    await manager.join({ guildId: "g1", channelId: "1001" });
    const sink = vi.fn();
    await h.startTranscripts(manager, sink);
    const entry = h.getSessionEntry(manager);
    // Retain the recording objects so cleanup must clear their owned chunks.
    const recordings = new Set<InstanceType<typeof DiscordVoiceRecording>>();
    let allocatedPcm = 0;
    const decoded = createDeferred<void>();
    const append = DiscordVoiceRecording.prototype.append; // oxlint-disable-line typescript/unbound-method -- Restored with append.call(this, ...) below.
    const observer = vi.spyOn(DiscordVoiceRecording.prototype, "append");
    observer.mockImplementation(async function (
      this: InstanceType<typeof DiscordVoiceRecording>,
      pcm,
      receipt,
    ) {
      recordings.add(this);
      allocatedPcm += pcm.length;
      await append.call(this, pcm, receipt);
      if (allocatedPcm === 75_264_000) {
        decoded.resolve();
      }
    });
    const retainedPcm = () =>
      [...recordings].reduce(
        (sum, recording) =>
          sum + recording["chunks"].reduce((bytes, chunk) => bytes + chunk.length, 0),
        0,
      );
    const streams: PassThrough[] = [];
    const receiving: Promise<void>[] = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      for (let speaker = 0; speaker < 4; speaker++) {
        const userId = `speaker-${speaker}`;
        const stream = new PassThrough({ objectMode: true });
        streams.push(stream);
        connection.receiver.speaking.users.set(userId, Date.now());
        connection.receiver.subscribe.mockReturnValueOnce(stream);
        receiving.push(h.handleSpeakingStart(manager, entry, userId));
      }
      const cpuStart = process.cpuUsage();
      const start = performance.now();
      // 4,900 real 20 ms Opus frames per speaker, below the default 20 MiB upload cap.
      for (let frame = 0; frame < 4_900; frame++) {
        for (const stream of streams) {
          stream.write(Buffer.from([0xf8, 0xff, 0xfe]));
        }
        if (frame % 8 === 7) {
          await setImmediate();
        }
      }
      await Promise.race([decoded.promise, Promise.all(receiving)]);
      const feedMs = performance.now() - start;
      const feedCpu = process.cpuUsage(cpuStart);
      const before = { reservations: entry.capture.size, retainedPcm: retainedPcm() };
      // Stagger silence expiry so disk work settles below the shared 64 MiB WAV budget.
      for (let speaker = 0; speaker < 4; speaker++) {
        connection.receiver.speaking.emit("end", `speaker-${speaker}`);
        await vi.advanceTimersByTimeAsync(1);
      }
      // Lose the corresponding end events on the renewed subscriptions' activity.
      for (let speaker = 0; speaker < 4; speaker++) {
        connection.receiver.speaking.emit("start", `speaker-${speaker}`);
        await vi.advanceTimersByTimeAsync(1);
      }
      const settleStart = performance.now();
      await vi.advanceTimersByTimeAsync(2_096);
      for (const [speaker, stream] of streams.entries()) {
        await vi.advanceTimersByTimeAsync(1);
        if (stream.destroyed) {
          await receiving[speaker];
          await entry.processingQueue;
        }
      }
      const after = { reservations: entry.capture.size, retainedPcm: retainedPcm() };
      if (process.env.OPENCLAW_VOICE_CAPTURE_MEASURE === "1") {
        console.log(
          JSON.stringify({
            feedMs,
            feedCpuUs: feedCpu.user + feedCpu.system,
            settleMs: performance.now() - settleStart,
            allocatedPcm,
            before,
            after,
          }),
        );
      }
      expect(before).toEqual({ reservations: 4, retainedPcm: 75_264_000 });
      expect(after).toEqual({ reservations: 0, retainedPcm: 0 });
      expect(sink).toHaveBeenCalledTimes(4);
    } finally {
      for (const stream of streams) {
        stream.destroy();
      }
      await Promise.allSettled(receiving);
      await entry.processingQueue;
      observer.mockRestore();
      vi.useRealTimers();
    }
  });
});
