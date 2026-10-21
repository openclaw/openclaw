import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

const voiceAudio = await import("./audio.js");
const { CAPTURE_FINALIZE_GRACE_MS } = await import("./session.js");

defineDiscordVoiceTests((h) => {
  const { expect, it, vi } = h;
  it.each([
    { limit: "jobs", blocked: "transcription", frames: 1, attempts: 256, expectedFiles: 128 },
    { limit: "bytes", blocked: "publication", frames: 500, attempts: 40, expectedFiles: 34 },
  ] as const)(
    "bounds queued WAV $limit during stalled $blocked across reconnect",
    async (scenario) => {
      const { frames, attempts, expectedFiles } = scenario;
      const manager = h.createManager(h.makeVoiceConfig(), undefined, {
        tools: { media: { audio: { maxBytes: frames * 3_840 + 44 } } },
      });
      const release = createDeferred<void>();
      const stall = (stage: typeof scenario.blocked) =>
        stage === scenario.blocked ? release.promise : undefined;
      const sink = vi.fn(async () => {
        await stall("publication");
      });
      await h.startTranscripts(manager, sink);
      const entry = h.getSessionEntry(manager);
      h.decodeOpusStreamChunksMock.mockImplementation(async (input, callbacks) => {
        try {
          for await (const packet of input) {
            await callbacks.onChunk(Buffer.alloc(3_840, packet[0]), packet);
          }
        } catch (error) {
          callbacks.onError?.(error);
        }
      });
      h.transcribeAudioFileMock.mockImplementation(async () => {
        await stall("transcription");
        return { text: "Recorded speech" };
      });
      let created = createDeferred<void>();
      const files: Array<{ path: string; bytes: number }> = [];
      const writeWav = voiceAudio.writeVoiceWavFile;
      const writes = vi.spyOn(voiceAudio, "writeVoiceWavFile").mockImplementation(async (pcm) => {
        const wav = await writeWav(pcm);
        files.push({ path: wav.path, bytes: (await fs.stat(wav.path)).size });
        created.resolve();
        return wav;
      });
      const streams: PassThrough[] = [];
      const writeFrames = (stream: PassThrough, value: number) => {
        for (let frame = 0; frame < frames; frame++) {
          stream.write(Buffer.from([value]));
        }
      };
      const receive = (target = entry) => {
        const stream = new PassThrough({ objectMode: true });
        streams.push(stream);
        const receiver = h.getSessionConnection(target).receiver;
        // Keep speaking until the recording budget rejects input, not the silence timer.
        receiver.speaking.users.set("guest", Date.now());
        stream.once("close", () => {
          receiver.speaking.users.delete("guest");
        });
        receiver.subscribe.mockReturnValueOnce(stream);
        const receiving = h
          .handleSpeakingStart(manager, target, "guest")
          .catch((error: unknown) => {
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
          created = createDeferred<void>();
          writeFrames(first.stream, 7);
          if (
            !(await Promise.race([
              created.promise.then(() => true),
              first.receiving.then(() => false),
            ]))
          ) {
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
        expect(files.reduce((total, file) => total + file.bytes, 0)).toBeLessThanOrEqual(
          64 * 1024 * 1024,
        );
        expect(h.loggerWarnMock).toHaveBeenCalledWith(expect.stringContaining("recording backlog"));
        expect(entry.transcripts?.isCurrent()).toBe(true);

        await manager.leave({ guildId: "g1" });
        expect(
          await manager.startTranscriptsCapture({ guildId: "g1", channelId: "1001" }),
        ).toMatchObject({ ok: true });
        const replacement = h.getSessionEntry(manager);
        const blocked = receive(replacement);
        writeFrames(blocked.stream, 8);
        blocked.stream.end();
        await blocked.receiving;
        expect(files).toHaveLength(expectedFiles);

        release.resolve();
        await entry.processingQueue;
        await Promise.all(
          files.map(async (file) => {
            await expect(fs.access(file.path)).rejects.toMatchObject({ code: "ENOENT" });
          }),
        );
        const calls = sink.mock.calls.length;
        const resumed = receive(replacement);
        resumed.stream.end(Buffer.from([9]));
        await resumed.receiving;
        await replacement.processingQueue;
        expect(files).toHaveLength(expectedFiles + 1);
        expect(sink).toHaveBeenCalledTimes(calls + 1);
        expect(replacement.transcripts?.isCurrent()).toBe(true);
      } finally {
        try {
          release.resolve();
          for (const stream of streams) {
            stream.end();
          }
          await first.receiving;
          await entry.processingQueue;
          await manager.destroy();
        } finally {
          writes.mockRestore();
          vi.useRealTimers();
        }
      }
    },
  );
});
