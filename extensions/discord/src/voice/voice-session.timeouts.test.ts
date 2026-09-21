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

    it("uses configured voice connection and reconnect timeouts", async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      try {
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        const manager = createManager({
          voice: {
            connectTimeoutMs: 45_000,
            reconnectGraceMs: 20_000,
          },
        });

        await manager.join({ guildId: "g1", channelId: "1001" });

        const readyCall = entersStateMock.mock.calls[0];
        expect(readyCall?.[0]).toBe(connection);
        expect(readyCall?.[1]).toBe("ready");
        expect(timeout.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(44_900);
        expect(timeout.mock.calls[0]?.[0]).toBeLessThanOrEqual(45_000);

        entersStateMock.mockClear();
        entersStateMock.mockRejectedValueOnce(new Error("still disconnected"));
        entersStateMock.mockRejectedValueOnce(new Error("still disconnected"));

        const disconnected = connection.handlers.get("disconnected");
        expect(disconnected).toBeTypeOf("function");
        await disconnected?.();

        expect(timeout).toHaveBeenLastCalledWith(20_000);
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
    });

    it("uses the default reconnect grace before destroying disconnected sessions", async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      try {
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        const manager = createManager();

        await manager.join({ guildId: "g1", channelId: "1001" });
        connection.handlers.get("disconnected")?.();
        await vi.waitFor(() =>
          expect(entersStateMock).toHaveBeenCalledWith(
            connection,
            "connecting",
            expect.any(AbortSignal),
          ),
        );

        entersStateMock.mockClear();
        entersStateMock.mockRejectedValueOnce(new Error("still disconnected"));
        entersStateMock.mockRejectedValueOnce(new Error("still disconnected"));

        const disconnected = connection.handlers.get("disconnected");
        expect(disconnected).toBeTypeOf("function");
        await disconnected?.();

        expect(timeout).toHaveBeenLastCalledWith(15_000);
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
    });
  },
);
