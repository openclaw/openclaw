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
    it("uses the default timeout for initial voice connection readiness", async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      try {
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        const manager = createManager();

        await manager.join({ guildId: "g1", channelId: "1001" });

        const readyCall = entersStateMock.mock.calls[0];
        expect(readyCall?.[0]).toBe(connection);
        expect(readyCall?.[1]).toBe("ready");
        expect(timeout.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(29_900);
        expect(timeout.mock.calls[0]?.[0]).toBeLessThanOrEqual(30_000);
        expect(readyCall?.[2]).toMatchObject({ aborted: false });
        await manager.leave({ guildId: "g1" });
        expect(readyCall?.[2]).toMatchObject({ aborted: true });
      } finally {
        timeout.mockRestore();
      }
    });

    it.each([
      { configured: true, connectTimeoutMs: 45_000, reconnectGraceMs: 20_000 },
      { configured: false, connectTimeoutMs: 30_000, reconnectGraceMs: 15_000 },
    ])(
      "uses connection and reconnect timeouts before destroying disconnected sessions (configured=$configured)",
      async ({ configured, connectTimeoutMs, reconnectGraceMs }) => {
        const timeout = vi.spyOn(AbortSignal, "timeout");
        try {
          const connection = createConnectionMock();
          joinVoiceChannelMock.mockReturnValueOnce(connection);
          const manager = createManager(
            configured ? { voice: { connectTimeoutMs, reconnectGraceMs } } : undefined,
          );
          await manager.join({ guildId: "g1", channelId: "1001" });
          const readyCall = entersStateMock.mock.calls[0];
          expect(readyCall?.[0]).toBe(connection);
          expect(readyCall?.[1]).toBe("ready");
          expect(timeout.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(connectTimeoutMs - 100);
          expect(timeout.mock.calls[0]?.[0]).toBeLessThanOrEqual(connectTimeoutMs);

          if (!configured) {
            connection.handlers.get("disconnected")?.();
            await vi.waitFor(() =>
              expect(entersStateMock).toHaveBeenCalledWith(
                connection,
                "connecting",
                expect.any(AbortSignal),
              ),
            );
          }
          entersStateMock.mockClear();
          entersStateMock.mockRejectedValueOnce(new Error("still disconnected"));
          entersStateMock.mockRejectedValueOnce(new Error("still disconnected"));
          const disconnected = connection.handlers.get("disconnected");
          expect(disconnected).toBeTypeOf("function");
          await disconnected?.();
          expect(timeout).toHaveBeenLastCalledWith(reconnectGraceMs);
          expect(entersStateMock).toHaveBeenCalledWith(
            connection,
            "signalling",
            expect.any(AbortSignal),
          );
          expect(entersStateMock).toHaveBeenCalledWith(
            connection,
            "connecting",
            expect.any(AbortSignal),
          );
          await vi.waitFor(() => expect(connection.destroy).toHaveBeenCalledTimes(1));
          await vi.waitFor(() => expect(manager.status()).toStrictEqual([]));
        } finally {
          timeout.mockRestore();
        }
      },
    );
  },
);
