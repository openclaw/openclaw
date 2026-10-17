import { PassThrough } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests((h) => {
  const { expect, it, vi } = h;
  const useConnection = () => {
    const connection = h.createConnectionMock();
    h.joinVoiceChannelMock.mockReturnValueOnce(connection);
    return connection;
  };
  const pendingPromotion = async (manager: ReturnType<typeof h.createManager>) => {
    const connect = createDeferred<undefined>();
    h.realtimeSessionMock.connect.mockReturnValueOnce(connect.promise);
    const joining = manager.join({ guildId: "g1", channelId: "1001" });
    await vi.waitFor(() => expect(h.realtimeSessionMock.connect).toHaveBeenCalledOnce());
    return { joining, ...connect };
  };
  const expectStartupStopped = async (manager: ReturnType<typeof h.createManager>) => {
    await expect(manager.join({ guildId: "g1", channelId: "1001" })).resolves.toEqual({
      ok: false,
      message: "Discord realtime voice session stopped before startup completed.",
      guildId: "g1",
      channelId: "1001",
    });
    expect(manager.status()).toEqual([]);
    expect(h.getLastAudioPlayer().stop).toHaveBeenCalledWith(true);
  };
  it.each([
    { mode: "bidi", stop: "after" },
    { mode: "bidi", stop: "during" },
  ] as const)(
    "disconnects capture stopped $stop a failed $mode promotion",
    async ({ mode, stop }) => {
      const manager = h.createAgentProxyManager(undefined, { voice: { mode } });
      const connection = h.createConnectionMock();
      h.joinVoiceChannelMock.mockReturnValueOnce(connection);
      expect(await h.startTranscripts(manager)).toMatchObject({ ok: true });
      const { joining, reject: rejectConnect } = await pendingPromotion(manager);
      if (stop === "during") {
        expect(await h.stopTranscripts()).toMatchObject({ ok: true });
        expect(connection.destroy).not.toHaveBeenCalled();
      }
      rejectConnect(new Error("provider unavailable"));
      expect(await joining).toMatchObject({
        ok: false,
        message: "Failed to start Discord realtime voice: provider unavailable",
      });
      if (stop === "after") {
        expect(connection.destroy).not.toHaveBeenCalled();
        expect(await h.stopTranscripts()).toMatchObject({ ok: true });
      }
      expect(connection.destroy).toHaveBeenCalledOnce();
      expect(manager.status()).toEqual([]);
      expect(h.realtimeSessionMock.close).toHaveBeenCalled();
      expect(h.joinVoiceChannelMock).toHaveBeenCalledOnce();
    },
  );

  it.each(["bootstrap", "connect"])(
    "keeps recording while conversation promotion waits for %s",
    async (phase) => {
      const manager = h.createAgentProxyManager();
      const onUtterance = vi.fn();
      await h.startTranscripts(manager, onUtterance);
      const entry = h.getSessionEntry(manager);
      const { promise: ready, resolve: finish } = createDeferred<void>();
      const pending =
        phase !== "connect"
          ? h.resolveRealtimeVoiceAgentContextInstructionsMock
          : h.realtimeSessionMock.connect;
      if (phase === "bootstrap") {
        h.resolveRealtimeVoiceAgentContextInstructionsMock.mockImplementationOnce(async () => {
          await ready;
          return "Agent context: shared voice agent context.";
        });
      } else {
        h.realtimeSessionMock.connect.mockImplementationOnce(() => ready);
      }
      const joining = manager.join({ guildId: "g1", channelId: "1001" });
      try {
        await vi.waitFor(() => expect(pending).toHaveBeenCalledOnce());
        await h.receiveRecordedSpeech(manager, "recorded during promotion");
        expect(onUtterance).toHaveBeenCalledWith(
          expect.objectContaining({ text: "recorded during promotion" }),
        );
        expect(h.agentCommandMock).not.toHaveBeenCalled();
      } finally {
        finish();
        await joining;
      }
      expect(await joining).toMatchObject({ ok: true });
      expect(h.getSessionEntry(manager)).toBe(entry);
      h.expectConnectedStatus(manager, "1001");
      expect(h.realtimeSessionMock.connect).toHaveBeenCalledOnce();
      expect(await h.stopTranscripts()).toMatchObject({ ok: true });
      h.expectConnectedStatus(manager, "1001");
      expect(h.joinVoiceChannelMock).toHaveBeenCalledOnce();
    },
  );

  it("resumes silent recording after failed promotion and can retry conversation", async () => {
    const manager = h.createAgentProxyManager();
    const onUtterance = vi.fn();
    await h.startTranscripts(manager, onUtterance);
    h.realtimeSessionMock.connect.mockRejectedValueOnce(new Error("provider unavailable"));

    expect(await manager.join({ guildId: "g1", channelId: "1001" })).toMatchObject({ ok: false });
    await h.receiveRecordedSpeech(manager, "still recording");
    expect(onUtterance).toHaveBeenCalledWith(expect.objectContaining({ text: "still recording" }));
    expect(h.agentCommandMock).not.toHaveBeenCalled();
    h.expectConnectedStatus(manager, "1001");

    expect(await manager.join({ guildId: "g1", channelId: "1001" })).toMatchObject({ ok: true });
    expect(await h.stopTranscripts()).toMatchObject({ ok: true });
    h.expectConnectedStatus(manager, "1001");
    expect(h.getSessionEntry(manager).realtimeLifecycle.status).toBe("active");
    h.lastRealtimeBridgeParams().audioSink.sendAudio(Buffer.alloc(24_000));
    expect(h.getLastAudioPlayer().play).toHaveBeenCalledOnce();
    expect(h.joinVoiceChannelMock).toHaveBeenCalledOnce();
  });

  it("preserves replacement capture when a pending promotion fails", async () => {
    const manager = h.createAgentProxyManager();
    const connection = useConnection();
    await h.startTranscripts(manager);
    const { joining, reject: rejectConnect } = await pendingPromotion(manager);
    const onUtterance = vi.fn();
    const replacement = h.startTranscripts(manager, onUtterance, "notes-2");
    await vi.waitFor(() =>
      expect(h.getSessionEntry(manager).transcripts?.sessionId).toBe("notes-2"),
    );
    rejectConnect(new Error("provider unavailable"));
    expect(await joining).toMatchObject({ ok: false });
    expect(await replacement).toMatchObject({ ok: true });
    expect(await h.stopTranscripts()).toMatchObject({ ok: false });
    await h.receiveRecordedSpeech(manager, "replacement recording");
    expect(onUtterance).toHaveBeenCalledOnce();
    expect(h.agentCommandMock).not.toHaveBeenCalled();
    expect(connection.destroy).not.toHaveBeenCalled();
    expect(await h.stopTranscripts("notes-2")).toMatchObject({ ok: true });
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(manager.status()).toEqual([]);
  });

  it.each([false, true])(
    "retains existing occupancy ownership (%s) after failed promotion",
    async (whenOccupied) => {
      const client = h.createClient();
      const human = {
        guild_id: "g1",
        channel_id: "1001",
        user_id: "u-owner",
        member: { user: { id: "u-owner", bot: false } },
      };
      let states: Array<Record<string, unknown>> = [human];
      h.configureVoiceStateGateway(client, () => states);
      const config = h.makeVoiceConfig(
        {
          mode: "stt-tts",
          autoJoin: [{ guildId: "g1", channelId: "1001", whenOccupied: true }],
        },
        { groupPolicy: "open" },
      );
      const manager = h.createManager(config, client);
      await manager.join(
        { guildId: "g1", channelId: "1001" },
        { autoJoinWhenOccupied: whenOccupied },
      );
      const connection = h.joinVoiceChannelMock.mock.results[0]!.value;
      await h.startTranscripts(manager);
      // Exercise realtime attachment on a transport with an established conversation owner.
      config.voice!.mode = "agent-proxy";
      h.realtimeSessionMock.connect.mockRejectedValueOnce(new Error("provider unavailable"));

      expect(
        await manager.join(
          { guildId: "g1", channelId: "1001" },
          {
            autoJoinWhenOccupied: !whenOccupied,
          },
        ),
      ).toMatchObject({ ok: false });
      expect(await h.stopTranscripts()).toMatchObject({ ok: true });
      expect(connection.destroy).not.toHaveBeenCalled();
      h.expectConnectedStatus(manager, "1001");
      states = [];
      await h.updateVoiceState(manager, "u-owner", null, human.member);
      if (whenOccupied) {
        expect(connection.destroy).toHaveBeenCalledOnce();
        expect(manager.status()).toEqual([]);
      } else {
        expect(connection.destroy).not.toHaveBeenCalled();
        h.expectConnectedStatus(manager, "1001");
      }
    },
  );

  it.each(["resolve", "reject"])(
    "does not revive a cancelled promotion when connect later %ss",
    async (settlement) => {
      const manager = h.createAgentProxyManager();
      const oldConnection = h.createConnectionMock();
      const replacementConnection = h.createConnectionMock();
      h.joinVoiceChannelMock
        .mockReturnValueOnce(oldConnection)
        .mockReturnValueOnce(replacementConnection);
      await h.startTranscripts(manager);
      const oldEntry = h.getSessionEntry(manager);
      const { joining, ...connect } = await pendingPromotion(manager);
      expect(await manager.leave({ guildId: "g1" })).toMatchObject({ ok: true });
      expect(await h.stopTranscripts()).toMatchObject({ ok: true });
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
      h.expectConnectedStatus(manager, "1002");
    },
  );

  it("releases initial startup when the manager is destroyed during provider connect", async () => {
    const connection = useConnection();
    const manager = h.createAgentProxyManager();
    h.realtimeSessionMock.connect.mockImplementationOnce(async () => {
      await manager.destroy();
    });

    try {
      await expectStartupStopped(manager);
      expect(h.realtimeSessionMock.close).toHaveBeenCalled();
      expect(connection.destroy).toHaveBeenCalledTimes(1);
    } finally {
      await manager.destroy();
    }
  });

  it("does not activate capture if Discord destroys the connection during initial startup", async () => {
    const connection = useConnection();
    const manager = h.createAgentProxyManager();
    h.realtimeSessionMock.connect.mockImplementationOnce(async () => {
      connection.state.status = "destroyed";
      connection.handlers.get("destroyed")?.();
    });

    try {
      await expectStartupStopped(manager);
      expect(connection.receiver.subscribe).not.toHaveBeenCalled();
      expect(h.realtimeSessionMock.close).toHaveBeenCalled();
    } finally {
      await manager.destroy();
    }
    expect(connection.destroy).not.toHaveBeenCalled();
  });

  it.each(["output overflow", "synchronous close"] as const)(
    "handles terminal provider %s before the initial realtime connect finishes",
    async (terminal) => {
      const connection = h.createConnectionMock();
      h.joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = h.createAgentProxyManager();
      if (terminal === "synchronous close") {
        h.createRealtimeVoiceBridgeSessionMock.mockImplementationOnce(() => {
          h.lastRealtimeBridgeParams().onClose?.("error");
          return h.realtimeSessionMock;
        });
      } else {
        h.realtimeSessionMock.connect.mockImplementationOnce(async () => {
          const provider = h.lastRealtimeBridgeParams();
          // Provider output can arrive while connect is pending; exceed the two-minute PCM cap.
          provider.audioSink.sendAudio(Buffer.alloc(24_000 * 2 * 121));
        });
      }

      try {
        await expectStartupStopped(manager);
        expect(connection.receiver.subscribe).not.toHaveBeenCalled();
        expect(h.realtimeSessionMock.close).toHaveBeenCalledOnce();
        expect(connection.destroy).toHaveBeenCalledTimes(1);
        if (terminal === "synchronous close") {
          expect(h.realtimeSessionMock.connect).not.toHaveBeenCalled();
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
      const oldConnection = h.createConnectionMock();
      const newConnection = h.createConnectionMock();
      h.joinVoiceChannelMock.mockReturnValueOnce(oldConnection).mockReturnValueOnce(newConnection);
      const manager = h.createAgentProxyManager(undefined, {
        allowFrom: ["discord:u-owner"],
        voice: { mode },
      });
      const decoding = createDeferred<void>();
      let receive: Promise<void> | undefined;
      try {
        await manager.join({ guildId: "g1", channelId: "1001" });
        const entry = h.getSessionEntry(manager);
        const onUtterance = vi.fn();
        await h.startTranscripts(manager, onUtterance);
        const registration = entry.transcripts;
        h.decodeOpusStreamChunksMock.mockReturnValueOnce(decoding.promise);
        const captureStream = new PassThrough({ objectMode: true });
        const destroyCapture = vi.spyOn(captureStream, "destroy");
        oldConnection.receiver.subscribe.mockReturnValueOnce(captureStream);
        receive = h.handleSpeakingStart(manager, entry, "u-owner");
        await vi.waitFor(() => expect(h.decodeOpusStreamChunksMock).toHaveBeenCalledOnce());
        oldConnection.receiver.speaking.emit("end", "u-owner");
        const turn = h.beginSpeakerTurn(entry);
        const { bridgeParams: provider, session: oldProvider } = h.lastRealtimeBridge();
        const player = h.getLastAudioPlayer();
        provider.audioSink.sendAudio(Buffer.alloc(24_000));
        expect(player.play).toHaveBeenCalledOnce();

        oldProvider.close.mockImplementationOnce(() => provider.onClose?.("completed"));
        if (boundary === "leave") {
          await manager.leave({ guildId: "g1" });
        } else {
          oldConnection.state.status = "destroyed";
          h.expectDefined(oldConnection.handlers.get("destroyed"), "destroyed listener")();
        }

        expect(manager.status()).toEqual([]);
        expect(entry.realtimeLifecycle.status).toBe("stopped");
        expect(entry.transcripts).toBe(registration);
        expect(registration?.isCurrent()).toBe(true);
        expect(destroyCapture).toHaveBeenCalledOnce();
        expect(entry.capture.size).toBe(0);
        expect(oldConnection.destroy).toHaveBeenCalledTimes(boundary === "leave" ? 1 : 0);
        expect(oldProvider.close).toHaveBeenCalledOnce();
        expect(h.loggerErrorMock).not.toHaveBeenCalled();
        expect(player.stop).toHaveBeenCalledWith(true);
        h.expectOffEventWithFunction(oldConnection.receiver.speaking.off, "start");
        h.expectOffEventWithFunction(oldConnection.receiver.speaking.off, "end");
        const audioPlayer = h.expectDefined(
          h.createAudioPlayerMock.mock.results[0]?.value,
          "audio player",
        );
        h.expectOffEventWithFunction(audioPlayer.off, "idle");

        await manager.join({ guildId: "g1", channelId: "1001" });
        const replacement = h.getSessionEntry(manager);
        expect(replacement.transcripts).toBe(registration);
        const replacementProvider = h.lastRealtimeBridge();
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

        h.expectConnectedStatus(manager, "1001");
        expect(h.getSessionEntry(manager)).toBe(replacement);
        expect(newConnection.destroy).not.toHaveBeenCalled();
        expect(oldProvider.close).toHaveBeenCalledOnce();
        expect(h.loggerErrorMock).not.toHaveBeenCalled();
        expect(oldProvider.sendAudio).toHaveBeenCalledTimes(inputCalls);
        expect(player.play).toHaveBeenCalledOnce();
        expect(registration?.isCurrent()).toBe(true);
        expect(onUtterance).not.toHaveBeenCalled();
        h.beginSpeakerTurn(replacement);
        expect(replacementProvider.session.sendAudio).toHaveBeenCalledOnce();
        expect(oldProvider.sendAudio).toHaveBeenCalledTimes(inputCalls);
      } finally {
        decoding.resolve();
        await receive;
        await manager.destroy();
      }
    },
  );
});
