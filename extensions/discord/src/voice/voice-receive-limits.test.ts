import { PassThrough } from "node:stream";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests((h) => {
  const { expect, it, vi } = h;
  async function createCaptureFixture(audio: { maxBytes?: number; enabled?: boolean }) {
    const connection = h.useConnection();
    const manager = h.createManager(
      audio.enabled === false
        ? undefined
        : h.makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-speaker"] }),
      undefined,
      { tools: { media: { audio } } },
    );
    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = h.getSessionEntry(manager);
    const conversations = vi.spyOn(entry.conversations, "enqueue");
    return {
      connection,
      entry,
      start: () => h.handleSpeakingStart(manager, entry, "u-speaker"),
      async capture(frames: number, oversized: boolean) {
        h.decodeOpusStreamChunksMock.mockImplementation(
          (await vi.importActual<typeof import("./audio.js")>("./audio.js")).decodeOpusStreamChunks,
        );
        const stream = new PassThrough({ objectMode: true });
        connection.receiver.subscribe.mockReturnValueOnce(stream);
        const completion = h.handleSpeakingStart(manager, entry, "u-speaker");
        const outcome = oversized
          ? expect(completion).rejects.toThrow("speak a shorter segment")
          : expect(completion).resolves.toBeUndefined();
        for (let frame = 0; frame < frames; frame += 1) {
          stream.write(Buffer.from([0xf8, 0xff, 0xfe]));
        }
        stream.end();
        await outcome;
        await entry.processingQueue;
        await Promise.all(conversations.mock.results.map((result) => result.value));
        expect(stream.destroyed).toBe(true);
        expect(entry.capture.size).toBe(0);
      },
    };
  }

  it("accounts for the WAV header at the transcription limit", async () => {
    const fixture = await createCaptureFixture({ maxBytes: 20 * 3840 + 43 });
    await fixture.capture(20, true);
    expect(h.transcribeAudioFileMock).not.toHaveBeenCalled();
    expect(h.loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("speak a shorter segment"),
    );
  });

  it("allows the same speaker to restart after an oversized capture without transcribing a prefix", async () => {
    const fixture = await createCaptureFixture({ maxBytes: 20 * 3840 + 44 });
    await fixture.capture(21, true);
    expect(h.transcribeAudioFileMock).not.toHaveBeenCalled();
    await fixture.capture(20, false);
    expect(h.transcribeAudioFileMock).toHaveBeenCalledTimes(1);
  });

  it("records disabled batch transcription without decoding or retaining a capture", async () => {
    const { start, connection, entry } = await createCaptureFixture({ enabled: false });
    await start();
    expect(h.decodeOpusStreamChunksMock).not.toHaveBeenCalled();
    expect(h.transcribeAudioFileMock).not.toHaveBeenCalled();
    expect(h.loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("audio understanding is disabled"),
    );
    expect(connection.receiver.subscribe).not.toHaveBeenCalled();
    expect(entry.capture.size).toBe(0);
  });
});
