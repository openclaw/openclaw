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
      // Regression guard for BUG-092: connect() used Date.now() (wall clock) to seed the
      // readiness deadline while AbortSignal.timeout consumes a monotonic libuv timer. A
      // clock rollback enlarged `deadline - Date.now()` and made the readiness wait exceed
      // connectTimeoutMs. After switching to performance.now() the budget stays monotonic
      // and is unaffected by Date.now() skew.
      const timeout = vi.spyOn(AbortSignal, "timeout");
      // Counter model (same shape as BUG-089/090): the first Date.now() call seeds the
      // deadline from the pre-rollback epoch; every later call observes the post-rollback
      // epoch, so the skew is never cancelled. Without the fix the budget handed to
      // AbortSignal.timeout grows by the rollback amount.
      let firstCall = true;
      const dateNow = vi.spyOn(Date, "now").mockImplementation(() => {
        if (firstCall) {
          firstCall = false;
          return 1_700_000_000_000; // pre-rollback epoch
        }
        return 1_700_000_000_000 - 10_000; // 10s wall-clock rollback
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
        // The budget handed to AbortSignal.timeout must track connectTimeoutMs (minus the
        // few monotonic milliseconds elapsed), NOT connectTimeoutMs + the 10s rollback.
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
