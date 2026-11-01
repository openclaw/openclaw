import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    agentCommandMock,
    beginSpeakerTurn,
    createJoinedAgentProxyFixture,
    lastAgentCommandArgs,
  }) => {
    it("accepts a speaker's wake-name follow-up with valid expiry", async () => {
      const { bridgeParams, entry, manager } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { requireWakeName: true } } },
      });
      vi.useFakeTimers();
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
      try {
        beginSpeakerTurn(entry, { senderIsOwner: false }).close();
        bridgeParams.onTranscript?.("user", "OpenClaw", true);
        bridgeParams.onTranscript?.("user", "Summarize this note.", true);
        await vi.advanceTimersByTimeAsync(260);

        expect(agentCommandMock).toHaveBeenCalledTimes(1);
        expect(lastAgentCommandArgs().senderIsOwner).toBe(false);
      } finally {
        clock.mockRestore();
        vi.useRealTimers();
        await manager.destroy();
      }
    });
  },
);
