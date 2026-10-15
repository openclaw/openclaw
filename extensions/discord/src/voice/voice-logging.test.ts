import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";
import { voiceTestMocks } from "./voice-test-mocks.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    agentCommandMock,
    beginSpeakerTurn,
    createJoinedAgentProxyFixture,
    createManager,
    emitFinalRealtimeUserTranscript,
    getSessionEntry,
    lastAgentCommandArgs,
    logVerboseMock,
    receiveRecordedSpeech,
  }) => {
    it.each(["batch", "realtime"] as const)(
      "keeps %s speech available to the agent without logging its content",
      async (mode) => {
        const question = "private-voice-question-probe";
        const answer = "private-voice-answer-probe";
        agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: answer }] });
        voiceTestMocks.loggerInfoMock.mockClear();
        logVerboseMock.mockClear();
        if (mode === "realtime") {
          const { entry, bridgeParams } = await createJoinedAgentProxyFixture({
            config: { voice: { realtime: { requireWakeName: false } } },
          });
          beginSpeakerTurn(entry);
          await emitFinalRealtimeUserTranscript(bridgeParams, question);
          bridgeParams.onTranscript?.("assistant", answer, true);
        } else {
          const manager = createManager();
          await manager.join({ guildId: "g1", channelId: "1001" });
          await receiveRecordedSpeech(manager, question, getSessionEntry(manager));
        }
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(lastAgentCommandArgs().message).toContain(question);
        const logs = [...voiceTestMocks.loggerInfoMock.mock.calls, ...logVerboseMock.mock.calls]
          .flat()
          .join("\n");
        expect(logs).toContain("chars");
        expect(logs).not.toContain(question);
        expect(logs).not.toContain(answer);
      },
    );
  },
);
