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

    it("keeps the follow-up armed across a forward wall-clock step past the window", async () => {
      const { bridgeParams, entry, manager } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { requireWakeName: true } } },
      });
      vi.useFakeTimers();
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
      try {
        beginSpeakerTurn(entry, { senderIsOwner: false }).close();
        // Arm the wake-name follow-up (10 s window).
        bridgeParams.onTranscript?.("user", "OpenClaw", true);
        // A forward wall-clock step (NTP correction, manual clock change) must
        // not expire the armed follow-up early: the window is monotonic, so only
        // elapsed time moves it. On the old wall-clock window (+11 s step) the
        // follow-up was rejected and the follow-up transcript was dropped.
        clock.mockReturnValue(1_700_000_011_000);
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
