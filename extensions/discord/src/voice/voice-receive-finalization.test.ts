import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    it,
    expect,
    vi,
    createConnectionMock,
    joinVoiceChannelMock,
    createManager,
    decodeOpusStreamChunksMock,
    transcribeAudioFileMock,
    startTranscripts,
    getSessionEntry,
    handleSpeakingStart,
  }) => {
    it("retains the reservation until the SDK source closes after decoded EOF", async () => {
      const releaseClose = createDeferred<void>();
      const first = new PassThrough({
        objectMode: true,
        destroy(_error, done) {
          void releaseClose.promise.then(() => done(null));
        },
      });
      const physicallyClosed = new Promise<void>((resolve) => {
        first.once("close", resolve);
      });
      const second = new PassThrough({ objectMode: true });
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      connection.receiver.subscribe.mockReturnValueOnce(first).mockReturnValueOnce(second);
      decodeOpusStreamChunksMock.mockImplementation(async (input, callbacks) => {
        for await (const packet of input) {
          await callbacks.onChunk(packet, packet);
        }
      });
      const manager = createManager({ voice: { enabled: true, mode: "stt-tts" } });
      let receiving: Promise<void> | undefined;
      try {
        await manager.join({ guildId: "g1", channelId: "1001" });
        await startTranscripts(manager, vi.fn());
        const entry = getSessionEntry(manager);
        receiving = handleSpeakingStart(manager, entry, "u1");
        const reservation = entry.capture.get("u1");
        expect(reservation).toBeDefined();
        first.end();
        await receiving;
        expect(first.closed).toBe(false);
        expect(entry.capture.get("u1")).toBe(reservation);
        await handleSpeakingStart(manager, entry, "u1");
        expect(connection.receiver.subscribe).toHaveBeenCalledTimes(1);

        releaseClose.resolve();
        await physicallyClosed;
        expect(entry.capture.has("u1")).toBe(false);
        const replacement = handleSpeakingStart(manager, entry, "u1");
        second.end();
        await replacement;
        expect(connection.receiver.subscribe).toHaveBeenCalledTimes(2);
      } finally {
        releaseClose.resolve();
        first.destroy();
        second.destroy();
        await receiving;
        await manager.destroy();
      }
    });

    it.each([
      { graceMs: 2_000, held: "decoder" },
      { graceMs: 4_000, held: "recording" },
    ] as const)(
      "releases the $graceMs ms physical reservation while its $held still owns old audio",
      async ({ graceMs, held }) => {
        const { DiscordVoiceRecording } = await import("./voice-recording.js");
        vi.useFakeTimers();
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        const manager = createManager({
          voice: { enabled: true, mode: "stt-tts", captureSilenceGraceMs: graceMs },
        });
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        let firstDecode = true;
        decodeOpusStreamChunksMock.mockImplementation(async (input, callbacks) => {
          if (firstDecode) {
            firstDecode = false;
            if (held === "decoder") {
              entered.resolve();
              await release.promise;
            }
          }
          for await (const packet of input) {
            await callbacks.onChunk(packet, packet);
          }
        });
        const finishing =
          held === "recording" ? vi.spyOn(DiscordVoiceRecording.prototype, "finish") : undefined;
        if (finishing) {
          finishing.mockImplementationOnce(async function (
            this: InstanceType<typeof DiscordVoiceRecording>,
          ) {
            entered.resolve();
            await release.promise;
            finishing.mockRestore();
            await this.finish();
          });
        }
        transcribeAudioFileMock.mockImplementation(async ({ filePath }) => {
          const wav = await fs.readFile(filePath);
          return { text: "segment-" + wav[44] };
        });
        const first = new PassThrough({ objectMode: true });
        const second = new PassThrough({ objectMode: true });
        let receiving: Promise<void> | undefined;
        try {
          await manager.join({ guildId: "g1", channelId: "1001" });
          const sink = vi.fn();
          await startTranscripts(manager, sink);
          const entry = getSessionEntry(manager);
          connection.receiver.subscribe.mockReturnValueOnce(first).mockReturnValueOnce(second);
          let firstDone = false;
          receiving = handleSpeakingStart(manager, entry, "u1").then(() => {
            firstDone = true;
          });
          first.write(Buffer.alloc(96_000, 1));
          connection.receiver.speaking.emit("end", "u1");
          await vi.advanceTimersByTimeAsync(graceMs - 1);
          expect(first.destroyed).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          await entered.promise;
          expect(first.destroyed).toBe(true);
          expect(firstDone).toBe(false);
          expect(entry.capture.has("u1")).toBe(false);

          // A real second start must subscribe before the prior decoder or
          // recording frontier releases. Awaiting receiving first hides this race.
          connection.receiver.speaking.emit("start", "u1");
          await vi.waitFor(() => expect(connection.receiver.subscribe).toHaveBeenCalledTimes(2));
          const replacement = entry.capture.get("u1");
          expect(replacement).toBeDefined();
          second.write(Buffer.alloc(96_000, 2));
          expect(firstDone).toBe(false);
          release.resolve();
          await receiving;
          expect(entry.capture.get("u1")).toBe(replacement);
          second.end();
          await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(2));
          const texts = sink.mock.calls
            .map(([utterance]) => utterance.text)
            .toSorted((left, right) => left.localeCompare(right));
          expect(texts).toEqual(["segment-1", "segment-2"]);
        } finally {
          release.resolve();
          first.destroy();
          second.destroy();
          await receiving;
          finishing?.mockRestore();
          vi.useRealTimers();
          await manager.destroy();
        }
      },
    );
  },
);
