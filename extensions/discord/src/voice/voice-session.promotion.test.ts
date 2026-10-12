import { PassThrough } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    createConnectionMock,
    joinVoiceChannelMock,
    realtimeSessionMock,
    resolveRealtimeVoiceAgentContextInstructionsMock,
    createAgentProxyManager,
    createManager,
    createClient,
    configureVoiceStateGateway,
    makeVoiceConfig,
    expectConnectedStatus,
    getSessionEntry,
    getLastAudioPlayer,
    lastRealtimeBridgeParams,
    startTranscripts,
    stopTranscripts,
    receiveRecordedSpeech,
    agentCommandMock,
    updateVoiceState,
    createRealtimeVoiceBridgeSessionMock,
    expectDefined,
    createAudioPlayerMock,
    decodeOpusStreamChunksMock,
    loggerErrorMock,
    lastRealtimeBridge,
    beginSpeakerTurn,
    expectOffEventWithFunction,
    handleSpeakingStart,
  }) => {
    it.each([
      { mode: "bidi", stop: "after" },
      { mode: "bidi", stop: "during" },
    ] as const)(
      "disconnects capture stopped $stop a failed $mode promotion",
      async ({ mode, stop }) => {
        const manager = createAgentProxyManager(undefined, { voice: { mode } });
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        expect(await startTranscripts(manager)).toMatchObject({ ok: true });
        const { promise: connect, reject: rejectConnect } = createDeferred<undefined>();
        realtimeSessionMock.connect.mockImplementationOnce(() => connect);

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
        const entry = getSessionEntry(manager);
        const { promise: ready, resolve: finish } = createDeferred<void>();
        const pending =
          phase !== "connect"
            ? resolveRealtimeVoiceAgentContextInstructionsMock
            : realtimeSessionMock.connect;
        if (phase === "bootstrap") {
          resolveRealtimeVoiceAgentContextInstructionsMock.mockImplementationOnce(async () => {
            await ready;
            return "Agent context: shared voice agent context.";
          });
        } else {
          realtimeSessionMock.connect.mockImplementationOnce(() => ready);
        }
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
        expect(await joining).toMatchObject({ ok: true });
        expect(getSessionEntry(manager)).toBe(entry);
        expectConnectedStatus(manager, "1001");
        expect(realtimeSessionMock.connect).toHaveBeenCalledOnce();
        expect(await stopTranscripts()).toMatchObject({ ok: true });
        expectConnectedStatus(manager, "1001");
        expect(joinVoiceChannelMock).toHaveBeenCalledOnce();
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
      expect(getSessionEntry(manager).realtimeLifecycle.status).toBe("active");
      lastRealtimeBridgeParams().audioSink.sendAudio(Buffer.alloc(24_000));
      expect(getLastAudioPlayer().play).toHaveBeenCalledOnce();
      expect(joinVoiceChannelMock).toHaveBeenCalledOnce();
    });

    it("preserves replacement capture when a pending promotion fails", async () => {
      const manager = createAgentProxyManager();
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      await startTranscripts(manager);
      const { promise: connect, reject: rejectConnect } = createDeferred<undefined>();
      realtimeSessionMock.connect.mockImplementationOnce(() => connect);
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
        const connect = createDeferred<undefined>();
        realtimeSessionMock.connect.mockImplementationOnce(() => connect.promise);
        const joining = manager.join({ guildId: "g1", channelId: "1001" });
        await vi.waitFor(() => expect(realtimeSessionMock.connect).toHaveBeenCalledOnce());
        expect(await manager.leave({ guildId: "g1" })).toMatchObject({ ok: true });
        expect(await stopTranscripts()).toMatchObject({ ok: true });
        const replacement = manager.join({ guildId: "g1", channelId: "1002" });
        if (settlement === "resolve") {
          connect.resolve(undefined);
        } else {
          connect.reject(new Error("provider unavailable"));
        }
        expect(await joining).toMatchObject({ ok: false });
        expect(await replacement).toMatchObject({ ok: true });
        await oldEntry.stop();
        expect(oldConnection.destroy).toHaveBeenCalledOnce();
        expect(replacementConnection.destroy).not.toHaveBeenCalled();
        expectConnectedStatus(manager, "1002");
      },
    );

    it("releases initial startup when the manager is destroyed during provider connect", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createAgentProxyManager();
      realtimeSessionMock.connect.mockImplementationOnce(async () => {
        await manager.destroy();
      });

      try {
        await expect(manager.join({ guildId: "g1", channelId: "1001" })).resolves.toEqual({
          ok: false,
          message: "Discord realtime voice session stopped before startup completed.",
          guildId: "g1",
          channelId: "1001",
        });

        expect(manager.status()).toEqual([]);
        expect(realtimeSessionMock.close).toHaveBeenCalled();
        expect(connection.destroy).toHaveBeenCalledTimes(1);
        expect(getLastAudioPlayer().stop).toHaveBeenCalledWith(true);
      } finally {
        await manager.destroy();
      }
    });

    it("does not activate capture if Discord destroys the connection during initial startup", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createAgentProxyManager();
      realtimeSessionMock.connect.mockImplementationOnce(async () => {
        connection.state.status = "destroyed";
        connection.handlers.get("destroyed")?.();
      });

      try {
        await expect(manager.join({ guildId: "g1", channelId: "1001" })).resolves.toEqual({
          ok: false,
          message: "Discord realtime voice session stopped before startup completed.",
          guildId: "g1",
          channelId: "1001",
        });

        expect(manager.status()).toEqual([]);
        expect(connection.receiver.subscribe).not.toHaveBeenCalled();
        expect(realtimeSessionMock.close).toHaveBeenCalled();
        expect(getLastAudioPlayer().stop).toHaveBeenCalledWith(true);
      } finally {
        await manager.destroy();
      }
      expect(connection.destroy).not.toHaveBeenCalled();
    });

    it.each(["output overflow", "synchronous close"] as const)(
      "handles terminal provider %s before the initial realtime connect finishes",
      async (terminal) => {
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        const manager = createAgentProxyManager();
        if (terminal === "synchronous close") {
          createRealtimeVoiceBridgeSessionMock.mockImplementationOnce(() => {
            lastRealtimeBridgeParams().onClose?.("error");
            return realtimeSessionMock;
          });
        } else {
          realtimeSessionMock.connect.mockImplementationOnce(async () => {
            const provider = lastRealtimeBridgeParams();
            // Provider output can arrive while connect is pending; exceed the two-minute PCM cap.
            provider.audioSink.sendAudio(Buffer.alloc(24_000 * 2 * 121));
          });
        }

        try {
          await expect(manager.join({ guildId: "g1", channelId: "1001" })).resolves.toEqual({
            ok: false,
            message: "Discord realtime voice session stopped before startup completed.",
            guildId: "g1",
            channelId: "1001",
          });

          expect(manager.status()).toEqual([]);
          expect(connection.receiver.subscribe).not.toHaveBeenCalled();
          expect(realtimeSessionMock.close).toHaveBeenCalledOnce();
          expect(connection.destroy).toHaveBeenCalledTimes(1);
          expect(getLastAudioPlayer().stop).toHaveBeenCalledWith(true);
          if (terminal === "synchronous close") {
            expect(realtimeSessionMock.connect).not.toHaveBeenCalled();
          }
        } finally {
          await manager.destroy();
        }
        expect(connection.destroy).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      ["agent-proxy", "leave"],
      ["bidi", "destroyed"],
    ] as const)(
      "retires %s room capture on %s without affecting its replacement",
      async (mode, boundary) => {
        const oldConnection = createConnectionMock();
        const newConnection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(oldConnection).mockReturnValueOnce(newConnection);
        const manager = createAgentProxyManager(undefined, {
          allowFrom: ["discord:u-owner"],
          voice: { mode },
        });
        const decoding = createDeferred<void>();
        let receive: Promise<void> | undefined;
        try {
          await manager.join({ guildId: "g1", channelId: "1001" });
          const entry = getSessionEntry(manager);
          const onUtterance = vi.fn();
          await startTranscripts(manager, onUtterance);
          const registration = entry.transcripts;
          decodeOpusStreamChunksMock.mockReturnValueOnce(decoding.promise);
          const captureStream = new PassThrough({ objectMode: true });
          const destroyCapture = vi.spyOn(captureStream, "destroy");
          oldConnection.receiver.subscribe.mockReturnValueOnce(captureStream);
          receive = handleSpeakingStart(manager, entry, "u-owner");
          await vi.waitFor(() => expect(decodeOpusStreamChunksMock).toHaveBeenCalledOnce());
          oldConnection.receiver.speaking.emit("end", "u-owner");
          const turn = beginSpeakerTurn(entry);
          const { bridgeParams: provider, session: oldProvider } = lastRealtimeBridge();
          const player = getLastAudioPlayer();
          provider.audioSink.sendAudio(Buffer.alloc(24_000));
          expect(player.play).toHaveBeenCalledOnce();

          oldProvider.close.mockImplementationOnce(() => provider.onClose?.("completed"));
          if (boundary === "leave") {
            await manager.leave({ guildId: "g1" });
          } else {
            oldConnection.state.status = "destroyed";
            expectDefined(oldConnection.handlers.get("destroyed"), "destroyed listener")();
          }

          expect(manager.status()).toEqual([]);
          expect(entry.realtimeLifecycle.status).toBe("stopped");
          expect(entry.transcripts).toBe(registration);
          expect(registration?.isCurrent()).toBe(true);
          expect(destroyCapture).toHaveBeenCalledOnce();
          expect(entry.capture.size).toBe(0);
          expect(oldConnection.destroy).toHaveBeenCalledTimes(boundary === "leave" ? 1 : 0);
          expect(oldProvider.close).toHaveBeenCalledOnce();
          expect(loggerErrorMock).not.toHaveBeenCalled();
          expect(player.stop).toHaveBeenCalledWith(true);
          expectOffEventWithFunction(oldConnection.receiver.speaking.off, "start");
          expectOffEventWithFunction(oldConnection.receiver.speaking.off, "end");
          const audioPlayer = expectDefined(
            createAudioPlayerMock.mock.results[0]?.value,
            "audio player",
          );
          expectOffEventWithFunction(audioPlayer.off, "idle");

          await manager.join({ guildId: "g1", channelId: "1001" });
          const replacement = getSessionEntry(manager);
          expect(replacement.transcripts).toBe(registration);
          const replacementProvider = lastRealtimeBridge();
          const inputCalls = oldProvider.sendAudio.mock.calls.length;
          turn.sendInputAudio(Buffer.alloc(3840));
          turn.close();
          provider.onClose?.("error");
          provider.onReady?.();
          provider.onEvent?.({ direction: "client", type: "session.reconnect.ready" });
          provider.audioSink.sendAudio(Buffer.alloc(24_000));
          provider.onTranscript?.("user", "stale transcript", true);
          provider.onEvent?.({ direction: "server", type: "response.done" });
          await Promise.resolve();

          expectConnectedStatus(manager, "1001");
          expect(getSessionEntry(manager)).toBe(replacement);
          expect(newConnection.destroy).not.toHaveBeenCalled();
          expect(oldProvider.close).toHaveBeenCalledOnce();
          expect(loggerErrorMock).not.toHaveBeenCalled();
          expect(oldProvider.sendAudio).toHaveBeenCalledTimes(inputCalls);
          expect(player.play).toHaveBeenCalledOnce();
          expect(registration?.isCurrent()).toBe(true);
          expect(onUtterance).not.toHaveBeenCalled();
          beginSpeakerTurn(replacement);
          expect(replacementProvider.session.sendAudio).toHaveBeenCalledOnce();
          expect(oldProvider.sendAudio).toHaveBeenCalledTimes(inputCalls);
        } finally {
          decoding.resolve();
          await receive;
          await manager.destroy();
        }
      },
    );
  },
);
