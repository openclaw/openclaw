import { vi } from "vitest";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

const { sendMessageDiscord } = vi.hoisted(() => ({ sendMessageDiscord: vi.fn() }));
vi.mock("../send.outbound.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../send.outbound.js")>()),
  sendMessageDiscord,
}));

const REPLY = "The meeting is booked for Friday.";
// `textToSpeechMock` is typed with a success-only result; variables skip excess property checks.
const TTS_FAILURE = { success: false, audioPath: "", error: "provider down" };

function streamReply() {
  return {
    success: true,
    audioStream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    }),
    release: vi.fn(async () => undefined),
  };
}

defineDiscordVoiceTests((h) => {
  const { expect, it } = h;

  async function joinBatchFixture() {
    const manager = h.createManager(
      h.makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["333"] }),
      h.createClientWithMember("333", "Guest", "4321"),
    );
    expect(await manager.join({ guildId: "g1", channelId: "1001" })).toMatchObject({ ok: true });
    return { manager, entry: h.getSessionEntry(manager), player: h.getLastAudioPlayer() };
  }

  function mockSend() {
    sendMessageDiscord.mockReset().mockImplementation(async (_to, _text, options) => {
      options.assertPlatformSendAuthorized?.();
    });
  }

  it("posts the completed reply as text when batch TTS synthesis fails", async () => {
    mockSend();
    h.textToSpeechStreamMock.mockResolvedValue({ success: false, error: "stream unavailable" });
    h.textToSpeechMock.mockResolvedValue(TTS_FAILURE);
    h.agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: REPLY }] });
    const { manager, entry, player } = await joinBatchFixture();

    await h.receiveRecordedSpeech(manager, "book the meeting", entry, "333");

    expect(h.loggerWarnMock).toHaveBeenCalledWith("discord voice: TTS failed: provider down");
    expect(sendMessageDiscord).toHaveBeenCalledExactlyOnceWith(
      "channel:1001",
      REPLY,
      expect.objectContaining({ accountId: "default" }),
    );
    expect(player.play).not.toHaveBeenCalled();
  });

  it("posts the completed reply as text when playback fails", async () => {
    mockSend();
    h.textToSpeechStreamMock.mockResolvedValue(streamReply());
    h.agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: REPLY }] });
    const { manager, entry } = await joinBatchFixture();
    const play = vi.spyOn(entry.audio, "play").mockRejectedValueOnce(new Error("playback closed"));

    await h.receiveRecordedSpeech(manager, "book the meeting", entry, "333");
    await entry.playbackQueue;

    expect(play).toHaveBeenCalledOnce();
    expect(sendMessageDiscord).toHaveBeenCalledExactlyOnceWith(
      "channel:1001",
      REPLY,
      expect.objectContaining({ accountId: "default" }),
    );
    expect(h.loggerWarnMock).toHaveBeenCalledWith(
      "discord voice: playback failed: playback closed",
    );
  });

  it("does not post text when batch TTS succeeds", async () => {
    mockSend();
    h.agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: REPLY }] });
    const { manager, entry, player } = await joinBatchFixture();

    await h.receiveRecordedSpeech(manager, "book the meeting", entry, "333");
    await entry.playbackQueue;

    expect(player.play).toHaveBeenCalledOnce();
    expect(sendMessageDiscord).not.toHaveBeenCalled();
  });

  it("does not post text for an empty reply", async () => {
    mockSend();
    h.agentCommandMock.mockResolvedValueOnce({ payloads: [] });
    const { manager, entry } = await joinBatchFixture();

    await h.receiveRecordedSpeech(manager, "book the meeting", entry, "333");

    expect(sendMessageDiscord).not.toHaveBeenCalled();
  });

  it("logs but does not throw when the text fallback send fails", async () => {
    sendMessageDiscord.mockReset().mockRejectedValue(new Error("Missing Permissions"));
    h.textToSpeechStreamMock.mockResolvedValue({ success: false, error: "stream unavailable" });
    h.textToSpeechMock.mockResolvedValue(TTS_FAILURE);
    h.agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: REPLY }] });
    const { manager, entry } = await joinBatchFixture();

    await h.receiveRecordedSpeech(manager, "book the meeting", entry, "333");

    expect(h.loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("text fallback dropped guild=g1 channel=1001: Missing Permissions"),
    );
  });
});
