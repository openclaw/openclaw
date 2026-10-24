import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

const voiceAudio = await import("./audio.js");
const { CAPTURE_FINALIZE_GRACE_MS } = await import("./session.js");
const silence = Buffer.from([0xf8, 0xff, 0xfe]);

defineDiscordVoiceTests((h) => {
  const { expect, it, vi } = h;
  it.each([
    { limit: "jobs", blocked: "transcription", frames: 1, attempts: 256, expectedFiles: 128 },
    { limit: "bytes", blocked: "publication", frames: 500, attempts: 40, expectedFiles: 34 },
  ] as const)("bounds $limit across reconnect with stalled $blocked", async (scenario) => {
    const { frames, attempts, expectedFiles } = scenario;
    const channel = { guildId: "g1", channelId: "1001" };
    const manager = h.createManager(h.makeVoiceConfig(), undefined, {
      tools: { media: { audio: { maxBytes: frames * 3_840 + 44 } } },
    });
    const release = createDeferred<void>();
    const stall = (stage: typeof scenario.blocked) =>
      stage === scenario.blocked ? release.promise : undefined;
    const sink = vi.fn(() => stall("publication"));
    await h.startTranscripts(manager, sink);
    const entry = h.getSessionEntry(manager);
    const audio = await vi.importActual<typeof import("./audio.js")>("./audio.js");
    h.decodeOpusStreamChunksMock.mockImplementation(audio.decodeOpusStreamChunks);
    h.transcribeAudioFileMock.mockImplementation(async () => {
      await stall("transcription");
      return { text: "Recorded speech" };
    });
    let created = createDeferred<boolean>();
    const files: string[] = [];
    let totalBytes = 0;
    const writes = vi.spyOn(voiceAudio, "writeVoiceWavFile").mockImplementation(async (pcm) => {
      const wav = await audio.writeVoiceWavFile(pcm);
      files.push(wav.path);
      totalBytes += (await fs.stat(wav.path)).size;
      created.resolve(true);
      return wav;
    });
    const streams: PassThrough[] = [];
    const writeFrames = (stream: PassThrough) => {
      for (let frame = 0; frame < frames; frame++) {
        stream.write(silence);
      }
    };
    const receive = (target = entry) => {
      const stream = new PassThrough({ objectMode: true });
      streams.push(stream);
      const receiver = h.getSessionConnection(target).receiver;
      // Keep speaking until the recording budget rejects input, not the silence timer.
      receiver.speaking.users.set("guest", Date.now());
      stream.once("close", () => receiver.speaking.users.delete("guest"));
      receiver.subscribe.mockReturnValueOnce(stream);
      const receiving = h.handleSpeakingStart(manager, target, "guest").catch((error: unknown) => {
        if (!(error instanceof Error) || !error.message.includes("recording backlog")) {
          throw error;
        }
      });
      return { stream, receiving };
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = receive();
    try {
      for (let chunk = 0; chunk < attempts; chunk++) {
        created = createDeferred<boolean>();
        writeFrames(first.stream);
        if (!(await Promise.race([created.promise, first.receiving]))) {
          break;
        }
        if (chunk === 0) {
          await vi.advanceTimersByTimeAsync(CAPTURE_FINALIZE_GRACE_MS + 1);
          expect(first.stream.destroyed).toBe(false);
        }
      }
      first.stream.end();
      await first.receiving;
      expect(files).toHaveLength(expectedFiles);
      expect(totalBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
      expect(h.loggerWarnMock).toHaveBeenCalledWith(expect.stringContaining("recording backlog"));
      expect(entry.transcripts?.isCurrent()).toBe(true);

      await manager.leave(channel);
      expect(await manager.startTranscriptsCapture(channel)).toMatchObject({ ok: true });
      const replacement = h.getSessionEntry(manager);
      const blocked = receive(replacement);
      writeFrames(blocked.stream);
      blocked.stream.end();
      await blocked.receiving;
      expect(files).toHaveLength(expectedFiles);

      release.resolve();
      await entry.processingQueue;
      await Promise.all(
        files.map((path) => expect(fs.access(path)).rejects.toMatchObject({ code: "ENOENT" })),
      );
      const calls = sink.mock.calls.length;
      const resumed = receive(replacement);
      resumed.stream.end(silence);
      await resumed.receiving;
      await replacement.processingQueue;
      expect(files).toHaveLength(expectedFiles + 1);
      expect(sink).toHaveBeenCalledTimes(calls + 1);
      expect(replacement.transcripts?.isCurrent()).toBe(true);
    } finally {
      try {
        release.resolve();
        streams.forEach((stream) => stream.end());
        await first.receiving;
        await entry.processingQueue;
      } finally {
        writes.mockRestore();
        vi.useRealTimers();
      }
    }
  });
});
