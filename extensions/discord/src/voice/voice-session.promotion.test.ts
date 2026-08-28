import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    createConnectionMock,
    joinVoiceChannelMock,
    realtimeSessionMock,
    resolveRealtimeBootstrapContextInstructionsMock,
    createAgentProxyManager,
    createManager,
    createClient,
    configureVoiceStateGateway,
    makeVoiceConfig,
    expectConnectedStatus,
    getSessionEntry,
    startTranscripts,
    stopTranscripts,
    receiveRecordedSpeech,
    agentCommandMock,
    updateVoiceState,
  }) => {
    it.each([
      { mode: "agent-proxy", stop: "after" },
      { mode: "agent-proxy", stop: "during" },
      { mode: "bidi", stop: "after" },
      { mode: "bidi", stop: "during" },
    ] as const)(
      "disconnects capture stopped $stop a failed $mode promotion",
      async ({ mode, stop }) => {
        const manager = createAgentProxyManager(undefined, { voice: { mode } });
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        expect(await startTranscripts(manager)).toMatchObject({ ok: true });
        let rejectConnect!: (error: Error) => void;
        realtimeSessionMock.connect.mockImplementationOnce(
          () =>
            new Promise<undefined>((_resolve, reject) => {
              rejectConnect = reject;
            }),
        );

        const joining = manager.join({ guildId: "g1", channelId: "1001" });
        await vi.waitFor(() => expect(realtimeSessionMock.connect).toHaveBeenCalledOnce());
        if (stop === "during") {
          expect(await stopTranscripts()).toMatchObject({ ok: true });
          expect(connection.destroy).not.toHaveBeenCalled();
        }
        rejectConnect(new Error("provider unavailable"));
        expect(await joining).toMatchObject({
          ok: false,
          message: "Failed to start Discord realtime voice: provider unavailable",
        });
        if (stop === "after") {
          expect(connection.destroy).not.toHaveBeenCalled();
          expect(await stopTranscripts()).toMatchObject({ ok: true });
        }
        expect(connection.destroy).toHaveBeenCalledOnce();
        expect(manager.status()).toEqual([]);
        expect(realtimeSessionMock.close).toHaveBeenCalled();
        expect(joinVoiceChannelMock).toHaveBeenCalledOnce();
      },
    );

    it.each(["bootstrap", "connect"])(
      "keeps recording while conversation promotion waits for %s",
      async (phase) => {
        const manager = createAgentProxyManager();
        const onUtterance = vi.fn();
        await startTranscripts(manager, onUtterance);
        let finish!: () => void;
        const ready = new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        });
        const pending =
          phase === "bootstrap"
            ? resolveRealtimeBootstrapContextInstructionsMock
            : realtimeSessionMock.connect;
        pending.mockImplementationOnce(async () => ready);
        const joining = manager.join({ guildId: "g1", channelId: "1001" });
        try {
          await vi.waitFor(() => expect(pending).toHaveBeenCalledOnce());
          await receiveRecordedSpeech(manager, "recorded during promotion");
          expect(onUtterance).toHaveBeenCalledWith(
            expect.objectContaining({ text: "recorded during promotion" }),
          );
          expect(agentCommandMock).not.toHaveBeenCalled();
        } finally {
          finish();
          await joining;
        }
      },
    );

    it("resumes silent recording after failed promotion and can retry conversation", async () => {
      const manager = createAgentProxyManager();
      const onUtterance = vi.fn();
      await startTranscripts(manager, onUtterance);
      realtimeSessionMock.connect.mockRejectedValueOnce(new Error("provider unavailable"));

      expect(await manager.join({ guildId: "g1", channelId: "1001" })).toMatchObject({ ok: false });
      await receiveRecordedSpeech(manager, "still recording");
      expect(onUtterance).toHaveBeenCalledWith(
        expect.objectContaining({ text: "still recording" }),
      );
      expect(agentCommandMock).not.toHaveBeenCalled();
      expectConnectedStatus(manager, "1001");

      expect(await manager.join({ guildId: "g1", channelId: "1001" })).toMatchObject({ ok: true });
      expect(await stopTranscripts()).toMatchObject({ ok: true });
      expectConnectedStatus(manager, "1001");
      expect(getSessionEntry(manager).realtime).toBeTruthy();
      expect(joinVoiceChannelMock).toHaveBeenCalledOnce();
    });

    it("preserves replacement capture when a pending promotion fails", async () => {
      const manager = createAgentProxyManager();
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      await startTranscripts(manager);
      let rejectConnect!: (error: Error) => void;
      realtimeSessionMock.connect.mockImplementationOnce(
        () =>
          new Promise<undefined>((_resolve, reject) => {
            rejectConnect = reject;
          }),
      );
      const joining = manager.join({ guildId: "g1", channelId: "1001" });
      await vi.waitFor(() => expect(realtimeSessionMock.connect).toHaveBeenCalledOnce());
      const onUtterance = vi.fn();
      const replacement = startTranscripts(manager, onUtterance, "notes-2");
      await vi.waitFor(() =>
        expect(getSessionEntry(manager).transcripts?.sessionId).toBe("notes-2"),
      );
      rejectConnect(new Error("provider unavailable"));
      expect(await joining).toMatchObject({ ok: false });
      expect(await replacement).toMatchObject({ ok: true });
      expect(await stopTranscripts()).toMatchObject({ ok: false });
      await receiveRecordedSpeech(manager, "replacement recording");
      expect(onUtterance).toHaveBeenCalledOnce();
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(connection.destroy).not.toHaveBeenCalled();
      expect(await stopTranscripts("notes-2")).toMatchObject({ ok: true });
      expect(connection.destroy).toHaveBeenCalledOnce();
      expect(manager.status()).toEqual([]);
    });

    it.each([false, true])(
      "retains existing occupancy ownership (%s) after failed promotion",
      async (whenOccupied) => {
        const client = createClient();
        const human = {
          guild_id: "g1",
          channel_id: "1001",
          user_id: "u-owner",
          member: { user: { id: "u-owner", bot: false } },
        };
        let states: Array<Record<string, unknown>> = [human];
        configureVoiceStateGateway(client, () => states);
        const config = makeVoiceConfig(
          {
            mode: "stt-tts",
            autoJoin: [{ guildId: "g1", channelId: "1001", whenOccupied: true }],
          },
          { groupPolicy: "open" },
        );
        const manager = createManager(config, client);
        await manager.join(
          { guildId: "g1", channelId: "1001" },
          { autoJoinWhenOccupied: whenOccupied },
        );
        const connection = joinVoiceChannelMock.mock.results[0]!.value;
        await startTranscripts(manager);
        // Exercise realtime attachment on a transport with an established conversation owner.
        config.voice!.mode = "agent-proxy";
        realtimeSessionMock.connect.mockRejectedValueOnce(new Error("provider unavailable"));

        expect(
          await manager.join(
            { guildId: "g1", channelId: "1001" },
            {
              autoJoinWhenOccupied: !whenOccupied,
            },
          ),
        ).toMatchObject({ ok: false });
        expect(await stopTranscripts()).toMatchObject({ ok: true });
        expect(connection.destroy).not.toHaveBeenCalled();
        expectConnectedStatus(manager, "1001");
        states = [];
        await updateVoiceState(manager, "u-owner", null, human.member);
        if (whenOccupied) {
          expect(connection.destroy).toHaveBeenCalledOnce();
          expect(manager.status()).toEqual([]);
        } else {
          expect(connection.destroy).not.toHaveBeenCalled();
          expectConnectedStatus(manager, "1001");
        }
      },
    );

    it.each(["resolve", "reject"])(
      "does not revive a cancelled promotion when connect later %ss",
      async (settlement) => {
        const manager = createAgentProxyManager();
        const oldConnection = createConnectionMock();
        const replacementConnection = createConnectionMock();
        joinVoiceChannelMock
          .mockReturnValueOnce(oldConnection)
          .mockReturnValueOnce(replacementConnection);
        await startTranscripts(manager);
        const oldEntry = getSessionEntry(manager);
        let finishConnect!: () => void;
        realtimeSessionMock.connect.mockImplementationOnce(
          () =>
            new Promise<undefined>((resolve, reject) => {
              finishConnect = () =>
                settlement === "resolve"
                  ? resolve(undefined)
                  : reject(new Error("provider unavailable"));
            }),
        );
        const joining = manager.join({ guildId: "g1", channelId: "1001" });
        await vi.waitFor(() => expect(realtimeSessionMock.connect).toHaveBeenCalledOnce());
        expect(await manager.leave({ guildId: "g1" })).toMatchObject({ ok: true });
        expect(await stopTranscripts()).toMatchObject({ ok: true });
        const replacement = manager.join({ guildId: "g1", channelId: "1002" });
        finishConnect();
        expect(await joining).toMatchObject({ ok: false });
        expect(await replacement).toMatchObject({ ok: true });
        oldEntry.stop();
        expect(oldConnection.destroy).toHaveBeenCalledOnce();
        expect(replacementConnection.destroy).not.toHaveBeenCalled();
        expectConnectedStatus(manager, "1002");
      },
    );
  },
);
