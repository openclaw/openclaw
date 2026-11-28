import type { MockCallSource } from "./manager.e2e.test-support.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    requireRecord,
    mockCall,
    joinVoiceChannelMock,
    entersStateMock,
    realtimeSessionMock,
    listenersModule,
    configureVoiceStateGateway,
    createClient,
    createManager,
    makeVoiceConfig,
    expectConnectedStatus,
    updateVoiceState,
    startTranscripts,
    stopTranscripts,
    getSessionEntry,
    beginSpeakerTurn,
    lastRealtimeBridgeParams,
    emitFinalRealtimeUserTranscript,
    receiveRecordedSpeech,
    agentCommandMock,
  }) => {
    it.each(["capture-first", "voice-first"])(
      "keeps explicit capture and wake-name conversation through occupancy (%s)",
      async (order) => {
        const client = createClient();
        const human = {
          guild_id: "g1",
          user_id: "u-owner",
          channel_id: "1001",
          member: { user: { id: "u-owner", bot: false } },
        };
        let states: Array<Record<string, unknown>> = order === "voice-first" ? [human] : [];
        configureVoiceStateGateway(client, () => states);
        const manager = createManager(
          makeVoiceConfig(
            {
              mode: "agent-proxy",
              autoJoin: [{ guildId: "g1", channelId: "1001", whenOccupied: true }],
              realtime: { provider: "openai", requireWakeName: true },
            },
            { groupPolicy: "open", allowFrom: ["discord:u-owner"] },
          ),
          client,
        );
        const onUtterance = vi.fn();
        if (order === "voice-first") {
          await manager.autoJoin();
        }
        expect(await startTranscripts(manager, onUtterance)).toMatchObject({ ok: true });
        if (order === "capture-first") {
          await manager.autoJoin();
          expect(manager.status()).toEqual([]);
          expect(joinVoiceChannelMock).not.toHaveBeenCalled();
          states = [human];
          await updateVoiceState(manager, "u-owner", "1001", human.member);
        }
        for (const text of ["first occupation", "second occupation"]) {
          expectConnectedStatus(manager, "1001");
          const entry = getSessionEntry(manager);
          expect(entry.realtimeLifecycle.status).toBe("active");
          await receiveRecordedSpeech(manager, text);
          await emitFinalRealtimeUserTranscript(lastRealtimeBridgeParams(), text);
          expect(onUtterance).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: "notes-1", text }),
          );
          expect(agentCommandMock).not.toHaveBeenCalled();
          states = [];
          await updateVoiceState(manager, "u-owner", null, human.member);
          expect(manager.status()).toEqual([]);
          states = [human];
          await updateVoiceState(manager, "u-owner", "1001", human.member);
        }
        beginSpeakerTurn(getSessionEntry(manager));
        await emitFinalRealtimeUserTranscript(
          lastRealtimeBridgeParams(),
          "OpenClaw, what is the next step?",
        );
        expect(agentCommandMock).toHaveBeenCalledOnce();
        states = [];
        await updateVoiceState(manager, "u-owner", null, human.member);
        expect(await stopTranscripts()).toMatchObject({ ok: true });
        states = [human];
        await updateVoiceState(manager, "u-owner", "1001", human.member);
        const count = onUtterance.mock.calls.length;
        await receiveRecordedSpeech(manager, "after capture stop");
        await emitFinalRealtimeUserTranscript(lastRealtimeBridgeParams(), "after capture stop");
        expect(onUtterance).toHaveBeenCalledTimes(count);
      },
    );
    it("autoJoin uses the last configured channel for duplicate guild entries", async () => {
      const manager = createManager({
        voice: {
          enabled: true,
          autoJoin: [
            { guildId: "g1", channelId: "1001" },
            { guildId: "g1", channelId: "1002" },
          ],
        },
      });

      await manager.autoJoin();

      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
      const joinOptions = requireRecord(
        mockCall(joinVoiceChannelMock as unknown as MockCallSource, 0, "join voice call")[0],
        "join voice options",
      );
      expect(joinOptions.guildId).toBe("g1");
      expect(joinOptions.channelId).toBe("1002");
      expectConnectedStatus(manager, "1002");
    });

    it("auto-joins an occupied room after the startup guild snapshot arrives", async () => {
      const client = createClient();
      let voiceStates: Array<Record<string, unknown>> = [];
      configureVoiceStateGateway(client, () => voiceStates);
      const manager = createManager(
        makeVoiceConfig({
          autoJoin: [{ guildId: "g1", channelId: "1001", whenOccupied: true }],
        }),
        client,
        {},
        "default",
        "bot-user",
      );

      await manager.autoJoin();
      expect(manager.status()).toEqual([]);

      voiceStates = [
        {
          guild_id: "g1",
          user_id: "u-owner",
          channel_id: "1001",
          member: { user: { id: "u-owner", bot: false } },
        },
      ];
      const { DiscordVoiceGuildCreateListener } = listenersModule;
      const listener = new DiscordVoiceGuildCreateListener(manager);
      await listener.handle({ id: "g1", unavailable: false } as never, client as never);

      await vi.waitFor(() => expectConnectedStatus(manager, "1001"));
    });

    it.each(["1002"])(
      "does not claim or disconnect a manual session in channel %s",
      async (manualChannelId) => {
        const client = createClient();
        const humanState = {
          guild_id: "g1",
          user_id: "u-owner",
          channel_id: "1001",
          member: { user: { id: "u-owner", bot: false } },
        };
        let voiceStates: Array<Record<string, unknown>> = [humanState];
        configureVoiceStateGateway(client, () => voiceStates);
        const manager = createManager(
          makeVoiceConfig({
            autoJoin: [{ guildId: "g1", channelId: "1001", whenOccupied: true }],
          }),
          client,
          {},
          "default",
          "bot-user",
        );

        await manager.join({ guildId: "g1", channelId: manualChannelId });
        await manager.autoJoin();
        voiceStates = [];
        await updateVoiceState(manager, "u-owner", null, humanState.member);

        expectConnectedStatus(manager, manualChannelId);
      },
    );

    it("applies the latest occupancy after a pending auto-join finishes", async () => {
      const client = createClient();
      const humanState = {
        guild_id: "g1",
        user_id: "u-owner",
        channel_id: "1001",
        member: { user: { id: "u-owner", bot: false } },
      };
      let voiceStates: Array<Record<string, unknown>> = [humanState];
      configureVoiceStateGateway(client, () => voiceStates);
      let resolveReady!: () => void;
      entersStateMock.mockImplementationOnce(
        async () =>
          await new Promise<undefined>((resolve) => {
            resolveReady = () => resolve(undefined);
          }),
      );
      const manager = createManager(
        makeVoiceConfig({
          autoJoin: [{ guildId: "g1", channelId: "1001", whenOccupied: true }],
        }),
        client,
        {},
        "default",
        "bot-user",
      );

      const joining = manager.autoJoin();
      await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1));
      voiceStates = [];
      const leaving = updateVoiceState(manager, "u-owner", null, humanState.member);
      resolveReady();
      await Promise.all([joining, leaving]);

      expect(manager.status()).toEqual([]);
    });

    it("suppresses repeated autoJoin attempts after fatal realtime startup failures", async () => {
      realtimeSessionMock.connect.mockRejectedValueOnce(new Error("Incorrect API key provided"));
      const manager = createManager(
        makeVoiceConfig({
          mode: "agent-proxy",
          autoJoin: [{ guildId: "g1", channelId: "1001" }],
        }),
      );

      await manager.autoJoin();
      await manager.autoJoin();

      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
      expect(realtimeSessionMock.connect).toHaveBeenCalledTimes(1);
      expect(manager.status()).toStrictEqual([]);
    });

    it("rejects joins outside configured allowed voice channels", async () => {
      const manager = createManager(
        makeVoiceConfig({ allowedChannels: [{ guildId: "g1", channelId: "1001" }] }),
      );

      const result = await manager.join({ guildId: "g1", channelId: "1002" });

      expect(result.ok).toBe(false);
      expect(result.message).toBe(
        "<#1002> is not allowed by channels.discord.voice.allowedChannels.",
      );
      expect(joinVoiceChannelMock).not.toHaveBeenCalled();
    });
  },
);
