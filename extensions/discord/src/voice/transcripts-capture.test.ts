import { setDiscordTranscriptsVoiceManager } from "./transcripts-source.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    createConnectionMock,
    joinVoiceChannelMock,
    entersStateMock,
    createAudioPlayerMock,
    resolveRealtimeBootstrapContextInstructionsMock,
    createRealtimeVoiceBridgeSessionMock,
    realtimeSessionMock,
    createManager,
    createAgentProxyManager,
    expectConnectedStatus,
    getSessionEntry,
    getVoiceReceive,
    createJoinedAgentProxyFixture,
    startTranscripts,
    stopTranscripts,
    beginSpeakerTurn,
    lastRealtimeBridgeParams,
    emitFinalRealtimeUserTranscript,
    receiveRecordedSpeech,
    transcribeAudioFileMock,
    agentCommandMock,
    makeVoiceConfig,
    emitDecryptFailure,
    createClient,
    configureVoiceStateGateway,
    enqueueSystemEventMock,
    updateVoiceState,
  }) => {
    it.each(["capture-start", "recovery"])(
      "keeps the subscription when the room empties during %s",
      async (phase) => {
        const client = createClient();
        const human = {
          guild_id: "g1",
          channel_id: "1001",
          user_id: "u-owner",
          member: { user: { id: "u-owner", bot: false } },
        };
        let states: Array<Record<string, unknown>> = [human];
        configureVoiceStateGateway(client, () => states);
        const manager = createManager(
          makeVoiceConfig(
            {
              mode: "agent-proxy",
              autoJoin: [{ guildId: "g1", channelId: "1001", whenOccupied: true }],
              realtime: { provider: "openai", requireWakeName: true },
            },
            { groupPolicy: "open" },
          ),
          client,
        );
        const onUtterance = vi.fn();
        if (phase === "recovery") {
          await manager.autoJoin();
          await startTranscripts(manager, onUtterance);
        }
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        let ready!: () => void;
        entersStateMock.mockImplementationOnce(
          () =>
            new Promise<undefined>((resolve) => {
              ready = () => resolve(undefined);
            }),
        );
        const start =
          phase === "capture-start" ? startTranscripts(manager, onUtterance) : undefined;
        if (phase === "recovery") {
          emitDecryptFailure(manager);
          emitDecryptFailure(manager);
          emitDecryptFailure(manager);
        }
        await vi.waitFor(() =>
          expect(joinVoiceChannelMock).toHaveBeenCalledTimes(phase === "recovery" ? 2 : 1),
        );
        states = [];
        const departure = updateVoiceState(manager, "u-owner", null, human.member);
        ready();
        if (start) {
          expect(await start).toMatchObject({ ok: true });
        }
        await departure;
        await vi.waitFor(() => expect(connection.destroy).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(manager.status()).toEqual([]));
        states = [human];
        await updateVoiceState(manager, "u-owner", "1001", human.member);
        await receiveRecordedSpeech(manager, "after returning to the room");
        expect(onUtterance).toHaveBeenCalledOnce();
      },
    );
    it.each(["capture-first", "restart"])(
      "keeps unrelated capture dormant beside configured conversation (%s)",
      async (order) => {
        const client = createClient();
        configureVoiceStateGateway(client, () => [
          {
            guild_id: "g1",
            channel_id: "1001",
            user_id: "u-owner",
            member: { user: { id: "u-owner", bot: false } },
          },
        ]);
        const config = makeVoiceConfig(
          {
            mode: "agent-proxy",
            autoJoin: [{ guildId: "g1", channelId: "1001", whenOccupied: true }],
            realtime: { provider: "openai", requireWakeName: true },
          },
          { groupPolicy: "open", allowFrom: ["discord:u-owner"] },
        );
        let manager = createManager(config, client);
        if (order === "restart") {
          await manager.autoJoin();
        }
        const onUtterance = vi.fn();
        expect(await startTranscripts(manager, onUtterance, "other-room", "1002")).toMatchObject({
          ok: true,
        });
        if (order === "restart") {
          const oldManager = manager;
          manager = createManager(config, client);
          setDiscordTranscriptsVoiceManager({ accountId: "default", manager });
          await oldManager.destroy();
        }
        try {
          await manager.autoJoin();
          expectConnectedStatus(manager, "1001");
          await receiveRecordedSpeech(manager, "not the capture channel");
          expect(onUtterance).not.toHaveBeenCalled();
          await manager.join({ guildId: "g1", channelId: "1002" });
          await receiveRecordedSpeech(manager, "the selected channel");
          expect(onUtterance).toHaveBeenCalledOnce();
          expect(await stopTranscripts("other-room", "1002")).toMatchObject({ ok: true });
          expectConnectedStatus(manager, "1002");
        } finally {
          await manager.destroy();
          setDiscordTranscriptsVoiceManager({
            accountId: "default",
            manager: null,
            expectedManager: manager,
          });
        }
      },
    );

    it("retires an uncommitted capture-only entry when its registration is replaced", async () => {
      const connection = createConnectionMock();
      connection.receiver.speaking.users.set("guest", Date.now());
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const client = createClient();
      configureVoiceStateGateway(client, () => []);
      const manager = createManager(
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-owner"] }),
        client,
      );
      const firstUtterance = vi.fn();
      const nextUtterance = vi.fn();
      let replacement: ReturnType<typeof startTranscripts> | undefined;
      enqueueSystemEventMock.mockImplementationOnce(() => {
        replacement = startTranscripts(manager, nextUtterance, "notes-2");
        return true;
      });
      expect(await startTranscripts(manager, firstUtterance)).toMatchObject({ ok: false });
      expect(await replacement).toMatchObject({ ok: true });
      expect(connection.receiver.subscribe).not.toHaveBeenCalled();
      expectConnectedStatus(manager, "1001");
      await receiveRecordedSpeech(manager);
      expect(firstUtterance).not.toHaveBeenCalled();
      expect(nextUtterance).toHaveBeenCalledOnce();
      expect(agentCommandMock).not.toHaveBeenCalled();
    });

    it("does not let cancelled capture recovery fence a newer manual audio session", async () => {
      const manager = createAgentProxyManager();
      await startTranscripts(manager);
      const captureEntry = getSessionEntry(manager);
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      let ready!: () => void;
      entersStateMock.mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            ready = () => resolve(undefined);
          }),
      );
      const leave = manager.leave.bind(manager);
      let manual: ReturnType<typeof manager.join> | undefined;
      vi.spyOn(manager, "leave").mockImplementationOnce(async (...args) => {
        const result = await leave(...args);
        manual = manager.join({ guildId: "g1", channelId: "1001" });
        return result;
      });
      emitDecryptFailure(manager);
      emitDecryptFailure(manager);
      emitDecryptFailure(manager);
      await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2));
      expect(await stopTranscripts()).toMatchObject({ ok: true });
      ready();
      expect(await manual).toMatchObject({ ok: true });
      await vi.waitFor(() =>
        expect(captureEntry.receiveRecovery.decryptRecoveryInFlight).toBe(false),
      );
      await vi.waitFor(() => expectConnectedStatus(manager, "1001"));
      const entry = getSessionEntry(manager);
      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(
        lastRealtimeBridgeParams(),
        "OpenClaw, are you still listening?",
      );
      expect(agentCommandMock).toHaveBeenCalledOnce();
      expect(connection.destroy).not.toHaveBeenCalled();
    });
    it("cancels a pending capture-only join without leaving an orphan connection", async () => {
      const manager = createAgentProxyManager();
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      let ready!: () => void;
      entersStateMock.mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            ready = () => resolve(undefined);
          }),
      );
      const starting = startTranscripts(manager);
      await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledOnce());
      expect(await stopTranscripts()).toMatchObject({ ok: true });
      ready();
      expect(await starting).toMatchObject({ ok: false });
      expect(connection.destroy).toHaveBeenCalledOnce();
      expect(manager.status()).toEqual([]);
    });

    it("keeps standalone capture silent across recovery and discards STT completing after stop", async () => {
      const manager = createManager(
        makeVoiceConfig(
          { mode: "agent-proxy" },
          { groupPolicy: "open", allowFrom: ["discord:u-owner"] },
        ),
      );
      const onUtterance = vi.fn();
      await startTranscripts(manager, onUtterance);
      const receiveSegment = () => receiveRecordedSpeech(manager);
      await receiveSegment();
      expect(onUtterance).toHaveBeenCalledOnce();
      emitDecryptFailure(manager);
      emitDecryptFailure(manager);
      emitDecryptFailure(manager);
      await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2));
      await receiveSegment();
      expect(onUtterance).toHaveBeenCalledTimes(2);
      expect(createRealtimeVoiceBridgeSessionMock).not.toHaveBeenCalled();
      let finishStt!: () => void;
      transcribeAudioFileMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishStt = () => resolve({ text: "late STT" });
          }),
      );
      const pending = receiveSegment();
      await vi.waitFor(() => expect(transcribeAudioFileMock).toHaveBeenCalledTimes(3));
      expect(await stopTranscripts()).toMatchObject({ ok: true });
      finishStt();
      await pending;
      expect(onUtterance).toHaveBeenCalledTimes(2);
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(manager.status()).toEqual([]);
    });
    it("rebinds capture to a replacement account manager and fences old cleanup", async () => {
      const config = {
        voice: {
          enabled: true,
          mode: "agent-proxy" as const,
          autoJoin: [{ guildId: "g1", channelId: "1001" }],
          realtime: { provider: "openai", requireWakeName: true },
        },
        groupPolicy: "open" as const,
      };
      const oldManager = createManager(config);
      await oldManager.autoJoin();
      const onUtterance = vi.fn();
      await startTranscripts(oldManager, onUtterance);
      const oldEntry = getSessionEntry(oldManager);
      const replacement = createManager(config);
      setDiscordTranscriptsVoiceManager({ accountId: "default", manager: replacement });
      await oldManager.destroy();
      setDiscordTranscriptsVoiceManager({
        accountId: "default",
        manager: null,
        expectedManager: oldManager,
      });
      try {
        await replacement.autoJoin();
        await receiveRecordedSpeech(replacement, "replacement manager note");
        expect(onUtterance).toHaveBeenCalledOnce();
        await receiveRecordedSpeech(oldManager, "stale manager", oldEntry);
        expect(onUtterance).toHaveBeenCalledOnce();
        expect(await stopTranscripts()).toMatchObject({ ok: true });
        expectConnectedStatus(replacement, "1001");
      } finally {
        await replacement.destroy();
        setDiscordTranscriptsVoiceManager({
          accountId: "default",
          manager: null,
          expectedManager: replacement,
        });
      }
    });

    it("stops an exact offline subscription and never reattaches it", async () => {
      const manager = createAgentProxyManager();
      const onUtterance = vi.fn();
      await startTranscripts(manager, onUtterance);
      const capture = getSessionEntry(manager).transcripts;
      await manager.destroy();
      setDiscordTranscriptsVoiceManager({
        accountId: "default",
        manager: null,
        expectedManager: manager,
      });
      expect(await stopTranscripts("notes-1", "1002")).toMatchObject({ ok: false });
      expect(await stopTranscripts()).toMatchObject({ ok: true });
      await capture?.onUtterance?.({ sessionId: "notes-1", text: "late note", final: true });
      expect(onUtterance).not.toHaveBeenCalled();
      const replacement = createAgentProxyManager();
      setDiscordTranscriptsVoiceManager({ accountId: "default", manager: replacement });
      try {
        await replacement.join({ guildId: "g1", channelId: "1001" });
        await receiveRecordedSpeech(replacement, "uncaptured note");
        expect(onUtterance).not.toHaveBeenCalled();
      } finally {
        await replacement.destroy();
        setDiscordTranscriptsVoiceManager({
          accountId: "default",
          manager: null,
          expectedManager: replacement,
        });
      }
    });
    it("attaches transcripts capture to an existing voice session", async () => {
      const manager = createManager(
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-owner"] }),
      );

      await manager.join({ guildId: "g1", channelId: "1001" });
      const onUtterance = vi.fn();
      const result = await startTranscripts(manager, onUtterance, "notes-1");

      const entry = getSessionEntry(manager);
      expect(result.ok).toBe(true);
      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
      expect(entry.transcripts?.sessionId).toBe("notes-1");
      await receiveRecordedSpeech(manager);
      expect(onUtterance).toHaveBeenCalledOnce();
      expect(agentCommandMock).toHaveBeenCalledOnce();
      expect(await stopTranscripts()).toMatchObject({ ok: true });
      expectConnectedStatus(manager, "1001");
    });

    it("does not leave a newer transcripts-only session for a stale stop", async () => {
      const manager = createAgentProxyManager();
      const firstUtterance = vi.fn();
      const secondUtterance = vi.fn();

      await manager.join({ guildId: "g1", channelId: "1001" });
      await startTranscripts(manager, firstUtterance, "notes-1");
      const oldCapture = getSessionEntry(manager).transcripts;
      await startTranscripts(manager, secondUtterance, "notes-2");
      await oldCapture?.onUtterance?.({ text: "stale capture", final: true });
      expect(firstUtterance).not.toHaveBeenCalled();

      const result = await stopTranscripts("notes-1");
      const entry = getSessionEntry(manager);

      expect(result.ok).toBe(false);
      expect(entry.transcripts?.sessionId).toBe("notes-2");
      expectConnectedStatus(manager, "1001");
      await receiveRecordedSpeech(manager, "replacement capture");
      expect(secondUtterance).toHaveBeenCalledOnce();
    });

    it("upgrades a transcripts-only session to realtime on a normal join", async () => {
      const manager = createAgentProxyManager();
      const onUtterance = vi.fn();

      await startTranscripts(manager, onUtterance, "notes-1");
      expect(createRealtimeVoiceBridgeSessionMock).not.toHaveBeenCalled();
      expect(createAudioPlayerMock).toHaveBeenCalledWith({
        behaviors: { maxMissedFrames: 100 },
      });

      const entry = getSessionEntry(manager);
      let resolveRealtimeReady!: () => void;
      const realtimeReady = new Promise<undefined>((resolve) => {
        resolveRealtimeReady = () => resolve(undefined);
      });
      realtimeSessionMock.connect.mockImplementationOnce(async () => realtimeReady);

      const upgrade = manager.join({ guildId: "g1", channelId: "1001" });

      await vi.waitFor(() => expect(createRealtimeVoiceBridgeSessionMock).toHaveBeenCalledTimes(1));
      expect(entry.realtime).toBeUndefined();

      resolveRealtimeReady();
      const result = await upgrade;

      expect(result.ok).toBe(true);
      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
      expect(createRealtimeVoiceBridgeSessionMock).toHaveBeenCalledTimes(1);
      expect(realtimeSessionMock.connect).toHaveBeenCalledTimes(1);
      expect(entry.transcripts?.sessionId).toBe("notes-1");
      expect(entry.realtime).toBeTruthy();
      const attempts = getVoiceReceive(manager).daveRecoveryAttempts;
      attempts.set("g1", Date.now());

      const stopNotesResult = await stopTranscripts("notes-1");

      expect(stopNotesResult.ok).toBe(true);
      expect(entry.transcripts).toBeUndefined();
      expect(entry.realtime).toBeTruthy();
      expect(realtimeSessionMock.close).not.toHaveBeenCalled();
      expect(attempts.has("g1")).toBe(true);
      expectConnectedStatus(manager, "1001");
    });

    it("closes a pending realtime upgrade if the voice entry stops before connect resolves", async () => {
      const manager = createAgentProxyManager();
      const onUtterance = vi.fn();

      await startTranscripts(manager, onUtterance, "notes-1");
      const entry = getSessionEntry(manager);
      let resolveRealtimeReady!: () => void;
      const realtimeReady = new Promise<undefined>((resolve) => {
        resolveRealtimeReady = () => resolve(undefined);
      });
      realtimeSessionMock.connect.mockImplementationOnce(async () => realtimeReady);

      const upgrade = manager.join({ guildId: "g1", channelId: "1001" });

      await vi.waitFor(() => expect(createRealtimeVoiceBridgeSessionMock).toHaveBeenCalledTimes(1));
      expect(entry.pendingRealtime).toBeTruthy();
      expect(entry.realtime).toBeUndefined();

      entry.stop();
      expect(realtimeSessionMock.close).toHaveBeenCalled();
      expect(entry.pendingRealtime).toBeUndefined();
      expect(entry.realtime).toBeUndefined();

      resolveRealtimeReady();
      const result = await upgrade;

      expect(result.ok).toBe(false);
      expect(result.message).toContain("stopped before startup completed");
      expect(entry.realtime).toBeUndefined();
    });

    it.each(["bootstrap", "connect"])(
      "detaches transcripts without leaving voice during pending realtime upgrade (%s)",
      async (phase) => {
        const manager = createAgentProxyManager();
        const onUtterance = vi.fn();

        await startTranscripts(manager, onUtterance, "notes-1");
        const entry = getSessionEntry(manager);
        let resolveRealtimeReady!: () => void;
        const realtimeReady = new Promise<undefined>((resolve) => {
          resolveRealtimeReady = () => resolve(undefined);
        });
        const pending =
          phase === "bootstrap"
            ? resolveRealtimeBootstrapContextInstructionsMock
            : realtimeSessionMock.connect;
        pending.mockImplementationOnce(async () => realtimeReady);

        const upgrade = manager.join({ guildId: "g1", channelId: "1001" });

        await vi.waitFor(() => expect(pending).toHaveBeenCalledOnce());
        const stopNotesResult = await stopTranscripts("notes-1");

        expect(stopNotesResult.ok).toBe(true);
        expect(entry.transcripts).toBeUndefined();
        expect(entry.realtime).toBeUndefined();

        resolveRealtimeReady();
        const result = await upgrade;

        expect(result.ok).toBe(true);
        expect(entry.pendingRealtime).toBeUndefined();
        expect(entry.realtime).toBeTruthy();
        expectConnectedStatus(manager, "1001");
      },
    );

    it("does not start realtime upgrade if the voice entry leaves during bootstrap", async () => {
      const manager = createAgentProxyManager();
      const onUtterance = vi.fn();

      await startTranscripts(manager, onUtterance, "notes-1");
      let resolveBootstrap!: () => void;
      const bootstrapReady = new Promise<undefined>((resolve) => {
        resolveBootstrap = () => resolve(undefined);
      });
      resolveRealtimeBootstrapContextInstructionsMock.mockImplementationOnce(
        async () => bootstrapReady,
      );

      const upgrade = manager.join({ guildId: "g1", channelId: "1001" });
      await Promise.resolve();

      const leaveResult = await manager.leave({ guildId: "g1" });
      resolveBootstrap();
      const result = await upgrade;

      expect(leaveResult.ok).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("stopped before startup completed");
      expect(createRealtimeVoiceBridgeSessionMock).not.toHaveBeenCalled();
    });

    it("keeps realtime playback alive when transcripts attaches to an existing voice session", async () => {
      const { bridgeParams, entry, manager, player } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { consultPolicy: "auto" } } },
      });

      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(24_000));
      const stopCallsBeforeTranscripts = player.stop.mock.calls.length;
      const onUtterance = vi.fn(async () => undefined);

      const result = await startTranscripts(manager, onUtterance, "notes-1");

      expect(result.ok).toBe(true);
      expect(entry.transcripts?.sessionId).toBe("notes-1");
      expect(realtimeSessionMock.close).not.toHaveBeenCalled();
      expect(player.stop).toHaveBeenCalledTimes(stopCallsBeforeTranscripts);

      await receiveRecordedSpeech(manager, "meeting note transcript");

      await vi.waitFor(() =>
        expect(onUtterance).toHaveBeenCalledWith(
          expect.objectContaining({
            final: true,
            sessionId: "notes-1",
            speaker: { id: "u-owner", label: "u-owner" },
            text: "meeting note transcript",
            metadata: expect.objectContaining({
              channel: "discord",
              channelId: "1001",
              guildId: "g1",
              voiceSessionKey: "discord:g1:c1",
            }),
          }),
        ),
      );
      expect(player.stop).toHaveBeenCalledTimes(stopCallsBeforeTranscripts);
    });
  },
);
