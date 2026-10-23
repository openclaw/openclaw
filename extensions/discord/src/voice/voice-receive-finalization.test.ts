import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests((h) => {
  const { expect, it, vi } = h;
  const recording = (voice: { captureSilenceGraceMs?: number } = {}) => {
    h.decodeOpusStreamChunksMock.mockImplementation(async (input, callbacks) => {
      for await (const packet of input) {
        await callbacks.onChunk(packet, packet);
      }
    });
    const decode = h.decodeOpusStreamChunksMock.getMockImplementation()!;
    const connection = h.useConnection();
    const manager = h.createManager(h.makeVoiceConfig(voice));
    const start = async () => {
      await manager.join({ guildId: "g1", channelId: "1001" });
      const sink = vi.fn();
      await h.startTranscripts(manager, sink);
      const entry = h.getSessionEntry(manager);
      return { entry, sink, begin: () => h.handleSpeakingStart(manager, entry, "u1") };
    };
    return { connection, start, decode };
  };
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
    const { connection, start } = recording();
    connection.receiver.subscribe.mockReturnValueOnce(first).mockReturnValueOnce(second);
    let receiving: Promise<void> | undefined;
    try {
      const { entry, begin } = await start();
      receiving = begin();
      const reservation = entry.capture.get("u1");
      expect(reservation).toBeDefined();
      first.end();
      await receiving;
      expect(first.closed).toBe(false);
      expect(entry.capture.get("u1")).toBe(reservation);
      await begin();
      expect(connection.receiver.subscribe).toHaveBeenCalledTimes(1);

      releaseClose.resolve();
      await physicallyClosed;
      expect(entry.capture.has("u1")).toBe(false);
      const replacement = begin();
      second.end();
      await replacement;
      expect(connection.receiver.subscribe).toHaveBeenCalledTimes(2);
    } finally {
      releaseClose.resolve();
      first.destroy();
      second.destroy();
      await receiving;
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
      const { connection, start, decode } = recording({ captureSilenceGraceMs: graceMs });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      h.decodeOpusStreamChunksMock.mockImplementationOnce(async (input, callbacks) => {
        if (held === "decoder") {
          entered.resolve();
          await release.promise;
        }
        await decode(input, callbacks);
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
      h.transcribeAudioFileMock.mockImplementation(async ({ filePath }) => ({
        text: "segment-" + (await fs.readFile(filePath))[44],
      }));
      const first = new PassThrough({ objectMode: true });
      const second = new PassThrough({ objectMode: true });
      let receiving: Promise<void> | undefined;
      try {
        const { entry, sink, begin } = await start();
        connection.receiver.subscribe.mockReturnValueOnce(first).mockReturnValueOnce(second);
        let firstDone = false;
        receiving = begin().then(() => {
          firstDone = true;
        });
        first.write(Buffer.alloc(96_000, 1));
        connection.receiver.speaking.emit("end", "u1");
        await vi.advanceTimersByTimeAsync(graceMs - 1);
        expect(first.destroyed).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await entered.promise;
        expect([first.destroyed, firstDone, entry.capture.has("u1")]).toEqual([true, false, false]);

        // Subscribe before releasing the prior decoder/recording frontier.
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
        expect(
          sink.mock.calls
            .map(([utterance]) => utterance.text)
            .toSorted((a, b) => a.localeCompare(b)),
        ).toEqual(["segment-1", "segment-2"]);
      } finally {
        release.resolve();
        first.destroy();
        second.destroy();
        await receiving;
        finishing?.mockRestore();
        vi.useRealTimers();
      }
    },
  );
});
