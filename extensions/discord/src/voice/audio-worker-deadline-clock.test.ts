import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    createConnectionMock,
    joinVoiceChannelMock,
    entersStateMock,
    createManager,
  }) => {
    it("ignores wall-clock skew when budgeting the voice connection readiness timeout", async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      // Seed the deadline before applying the wall-clock rewind.
      let firstCall = true;
      const dateNow = vi.spyOn(Date, "now").mockImplementation(() => {
        if (firstCall) {
          firstCall = false;
          return 1_700_000_000_000;
        }
        return 1_700_000_000_000 - 10_000;
      });
      try {
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        const manager = createManager({
          voice: { connectTimeoutMs: 30_000, reconnectGraceMs: 15_000 },
        });

        await manager.join({ guildId: "g1", channelId: "1001" });

        const readyCall = entersStateMock.mock.calls[0];
        expect(readyCall?.[0]).toBe(connection);
        expect(readyCall?.[1]).toBe("ready");
        expect(timeout.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(29_900);
        expect(timeout.mock.calls[0]?.[0]).toBeLessThanOrEqual(30_000);
        await manager.leave({ guildId: "g1", channelId: "1001" });
      } finally {
        dateNow.mockRestore();
        timeout.mockRestore();
      }
    });
  },
);
