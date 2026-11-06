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

    it("drops an expired wake-name follow-up after the wall clock steps backwards", async () => {
      const { bridgeParams, entry, manager } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { requireWakeName: true } } },
      });
      vi.useFakeTimers();
      const wallClock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
      try {
        beginSpeakerTurn(entry, { senderIsOwner: false }).close();
        // A bare wake name arms the follow-up with a 10 s window on the
        // process-local elapsed clock (fake timers advance performance.now).
        bridgeParams.onTranscript?.("user", "OpenClaw", true);
        // The wall clock steps back an hour while elapsed time passes the TTL.
        wallClock.mockReturnValue(1_700_000_000_000 - 3_600_000);
        await vi.advanceTimersByTimeAsync(11_000);
        bridgeParams.onTranscript?.("user", "Summarize this note.", true);
        await vi.advanceTimersByTimeAsync(260);

        // The follow-up expired on elapsed time, so the transcript is ignored
        // instead of being routed through the stale speaker's forced consult.
        expect(agentCommandMock).not.toHaveBeenCalled();
      } finally {
        wallClock.mockRestore();
        vi.useRealTimers();
        await manager.destroy();
      }
    });
  },
);
