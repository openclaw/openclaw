import { PassThrough } from "node:stream";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    createConnectionMock,
    joinVoiceChannelMock,
    createManager,
    makeVoiceConfig,
    getSessionEntry,
    handleSpeakingStart,
    transcribeAudioFileMock,
    loggerWarnMock,
    decodeOpusStreamChunksMock,
  }) => {
    async function createCaptureFixture(maxBytes: number) {
      decodeOpusStreamChunksMock.mockImplementation(
        (await vi.importActual<typeof import("./audio.js")>("./audio.js")).decodeOpusStreamChunks,
      );
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager(
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-speaker"] }),
        undefined,
        { tools: { media: { audio: { maxBytes } } } },
      );
      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = getSessionEntry(manager);
      return {
        connection,
        manager,
        entry,
        conversations: vi.spyOn(entry.conversations, "enqueue"),
      };
    }

    it("accounts for the WAV header at the transcription limit", async () => {
      const { connection, manager, entry, conversations } = await createCaptureFixture(
        20 * 3840 + 43,
      );
      const stream = new PassThrough({ objectMode: true });
      connection.receiver.subscribe.mockReturnValueOnce(stream);
      const completion = handleSpeakingStart(manager, entry, "u-speaker");
      const outcome = expect(completion).rejects.toThrow("speak a shorter segment");
      for (let frame = 0; frame < 20; frame += 1) {
        stream.write(Buffer.from([0xf8, 0xff, 0xfe]));
      }
      stream.end();
      await outcome;
      await entry.processingQueue;
      await Promise.all(conversations.mock.results.map((result) => result.value));
      expect(transcribeAudioFileMock).not.toHaveBeenCalled();
      expect(stream.destroyed).toBe(true);
      expect(entry.capture.size).toBe(0);
      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.stringContaining("speak a shorter segment"),
      );
      await manager.destroy();
    });

    it("allows the same speaker to restart after an oversized capture without transcribing a prefix", async () => {
      const { connection, manager, entry, conversations } = await createCaptureFixture(
        20 * 3840 + 44,
      );
      for (const frames of [21, 20]) {
        const stream = new PassThrough({ objectMode: true });
        connection.receiver.subscribe.mockReturnValueOnce(stream);
        const completion = handleSpeakingStart(manager, entry, "u-speaker");
        const outcome =
          frames === 21
            ? expect(completion).rejects.toThrow("speak a shorter segment")
            : expect(completion).resolves.toBeUndefined();
        for (let frame = 0; frame < frames; frame += 1) {
          stream.write(Buffer.from([0xf8, 0xff, 0xfe]));
        }
        stream.end();
        await outcome;
        await entry.processingQueue;
        await Promise.all(conversations.mock.results.map((result) => result.value));
        expect(transcribeAudioFileMock).toHaveBeenCalledTimes(frames === 21 ? 0 : 1);
        expect(stream.destroyed).toBe(true);
        expect(entry.capture.size).toBe(0);
      }
      await manager.destroy();
    });

    it("records disabled batch transcription without decoding or retaining a capture", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager(undefined, undefined, {
        tools: { media: { audio: { enabled: false } } },
      });
      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = getSessionEntry(manager);
      await handleSpeakingStart(manager, entry, "u-speaker");
      expect(decodeOpusStreamChunksMock).not.toHaveBeenCalled();
      expect(transcribeAudioFileMock).not.toHaveBeenCalled();
      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.stringContaining("audio understanding is disabled"),
      );
      expect(connection.receiver.subscribe).not.toHaveBeenCalled();
      expect(entry.capture.size).toBe(0);
      await manager.destroy();
    });
  },
);
