import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { DiscordError } from "../internal/discord.js";
import type { MockCallSource } from "./manager.e2e.test-support.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expectDefined,
    expect,
    it,
    vi,
    ChannelType,
    requireRecord,
    mockCall,
    lastMockCall,
    createConnectionMock,
    joinVoiceChannelMock,
    entersStateMock,
    createAudioPlayerMock,
    realtimeSessionMock,
    logVerboseMock,
    managerModule,
    configureVoiceStateGateway,
    createClient,
    createManager,
    expectConnectedStatus,
    getSessionEntry,
    beginSpeakerTurn,
    getLastAudioPlayer,
    expectOffEventWithFunction,
    createJoinedAgentProxyFixture,
    createJoinedBidiFixture,
    handleSpeakingStart,
  }) => {
    it("rejects joins when Discord voice config is absent", async () => {
      const manager = createManager({});

      const result = await manager.join({ guildId: "g1", channelId: "1001" });
      expect(result.ok).toBe(false);
      expect(result.message).toBe("Discord voice is disabled (channels.discord.voice.enabled).");

      expect(joinVoiceChannelMock).not.toHaveBeenCalled();
    });

    it.each(["agent-proxy", "bidi"] as const)(
      "keeps %s playback alive through brief provider stalls",
      async (mode) => {
        const manager = createManager({
          voice: { enabled: true, mode, realtime: { provider: "openai" } },
        });

        await manager.join({ guildId: "g1", channelId: "1001" });

        expect(createAudioPlayerMock).toHaveBeenCalledWith({
          behaviors: { maxMissedFrames: 100 },
        });
      },
    );

    it("preserves default audio-player behavior for STT/TTS playback", async () => {
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });

      expect(createAudioPlayerMock).toHaveBeenCalledWith();
    });

    it("keeps the new session when an old disconnected handler fires", async () => {
      const oldConnection = createConnectionMock();
      const newConnection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(oldConnection).mockReturnValueOnce(newConnection);
      entersStateMock.mockImplementation(async (target: unknown, status?: string) => {
        if (target === oldConnection && (status === "signalling" || status === "connecting")) {
          throw new Error("old disconnected");
        }
        return undefined;
      });

      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });
      await manager.join({ guildId: "g1", channelId: "1002" });

      const oldDisconnected = oldConnection.handlers.get("disconnected");
      expect(oldDisconnected).toBeTypeOf("function");
      await oldDisconnected?.();

      expectConnectedStatus(manager, "1002");
      await manager.destroy();
    });

    it("keeps the new session when an old destroyed handler fires", async () => {
      const oldConnection = createConnectionMock();
      const newConnection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(oldConnection).mockReturnValueOnce(newConnection);

      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });
      await manager.join({ guildId: "g1", channelId: "1002" });

      const oldDestroyed = oldConnection.handlers.get("destroyed");
      expect(oldDestroyed).toBeTypeOf("function");
      oldDestroyed?.();

      expectConnectedStatus(manager, "1002");
      await manager.destroy();
    });

    it.each(["leave", "destroy"] as const)(
      "does not spawn a replacement worker after %s wins socket shutdown",
      async (boundary) => {
        const manager = createManager();
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const stop = vi
          .spyOn(manager["voiceSessions"], "stopTransport")
          .mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
          });
        const joining = manager.join({ guildId: "g1", channelId: "1001" });
        await entered.promise;
        if (boundary === "leave") {
          await manager.leave({ guildId: "g1" });
        } else {
          await manager.destroy();
        }
        release.resolve();
        expect((await joining).ok).toBe(false);
        expect(joinVoiceChannelMock).not.toHaveBeenCalled();
        expect(createAudioPlayerMock).not.toHaveBeenCalled();
        stop.mockRestore();
      },
    );

    it("keeps a departing worker as the join barrier until physical shutdown settles", async () => {
      const manager = createManager();
      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = getSessionEntry(manager);
      const release = createDeferred<void>();
      const originalStop = entry.audio.stop.bind(entry.audio);
      const physicalStop = release.promise.then(originalStop);
      vi.spyOn(entry.audio, "stop").mockReturnValue(physicalStop);
      const leaving = manager.leave({ guildId: "g1" });
      const joining = manager.join({ guildId: "g1", channelId: "1002" });
      try {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
        release.resolve();
        await leaving;
        expect((await joining).ok).toBe(true);
        expectConnectedStatus(manager, "1002");
      } finally {
        release.resolve();
        await Promise.allSettled([leaving, joining]);
      }
    });

    it("isolates voice connections by Discord account", async () => {
      const firstManager = createManager(undefined, undefined, undefined, "first");
      const secondManager = createManager(undefined, undefined, undefined, "second");

      await firstManager.join({ guildId: "g1", channelId: "1001" });
      await secondManager.join({ guildId: "g1", channelId: "1002" });

      expect(joinVoiceChannelMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ group: "openclaw:first" }),
      );
      expect(joinVoiceChannelMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ group: "openclaw:second" }),
      );
    });

    const missingAccessError = new DiscordError(new Response(null, { status: 403 }), {
      message: "Missing Access",
      code: 50001,
    });
    const unknownChannelError = new DiscordError(new Response(null, { status: 404 }), {
      message: "Unknown Channel",
      code: 10003,
    });
    const networkError = new TypeError("fetch failed");

    it.each([
      {
        name: "preserves Discord 403 / 50001 Missing Access",
        response: missingAccessError,
        expected: {
          ok: false,
          message: "Failed to resolve Discord channel 1001: Missing Access",
          guildId: "g1",
          channelId: "1001",
        },
      },
      {
        name: "preserves Discord 404 / 10003 Unknown Channel",
        response: unknownChannelError,
        expected: {
          ok: false,
          message: "Failed to resolve Discord channel 1001: Unknown Channel",
          guildId: "g1",
          channelId: "1001",
        },
      },
      {
        name: "preserves generic network failures",
        response: networkError,
        expected: {
          ok: false,
          message: "Failed to resolve Discord channel 1001: fetch failed",
          guildId: "g1",
          channelId: "1001",
        },
      },
      {
        name: "rejects a fetched GuildText channel",
        response: { id: "1001", guildId: "g1", type: ChannelType.GuildText },
        expected: { ok: false, message: "Channel 1001 is not a voice channel." },
      },
      {
        name: "accepts a fetched GuildVoice channel",
        response: { id: "1001", guildId: "g1", type: ChannelType.GuildVoice },
        expected: {
          ok: true,
          message: "Joined <#1001>.",
          guildId: "g1",
          channelId: "1001",
        },
      },
      {
        name: "accepts a fetched GuildStageVoice channel",
        response: { id: "1001", guildId: "g1", type: ChannelType.GuildStageVoice },
        expected: {
          ok: true,
          message: "Joined <#1001>.",
          guildId: "g1",
          channelId: "1001",
        },
      },
    ])("$name", async ({ response, expected }) => {
      const client = createClient();
      client.fetchChannel.mockImplementationOnce(async () => {
        if (response instanceof Error) {
          throw response;
        }
        return response as never;
      });
      const manager = createManager(undefined, client);

      await expect(manager.join({ guildId: "g1", channelId: "1001" })).resolves.toEqual(expected);
    });

    it("keeps cancellation authoritative when channel lookup later rejects", async () => {
      let rejectChannelLookup!: (reason: unknown) => void;
      const client = createClient();
      client.fetchChannel.mockImplementationOnce(
        async () =>
          await new Promise<never>((_, reject) => {
            rejectChannelLookup = reject;
          }),
      );
      const manager = createManager(undefined, client);

      const join = manager.join({ guildId: "g1", channelId: "1001" });
      await vi.waitFor(() => expect(client.fetchChannel).toHaveBeenCalledOnce());
      await manager.leave({ guildId: "g1" });
      rejectChannelLookup(missingAccessError);

      await expect(join).resolves.toEqual({
        ok: false,
        message: "Discord voice join was cancelled.",
        guildId: "g1",
        channelId: "1001",
      });
    });

    it("removes voice listeners on leave", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });
      await manager.leave({ guildId: "g1" });

      const player = createAudioPlayerMock.mock.results[0]?.value;
      expectOffEventWithFunction(connection.receiver.speaking.off, "start");
      expectOffEventWithFunction(connection.receiver.speaking.off, "end");
      expectOffEventWithFunction(connection.off, "disconnected");
      expectOffEventWithFunction(connection.off, "destroyed");
      expectOffEventWithFunction(player.off, "error");
    });

    it("force-stops buffering playback when leaving a voice session", async () => {
      const manager = createManager();
      await manager.join({ guildId: "g1", channelId: "1001" });
      const player = getLastAudioPlayer();
      player.state.status = "buffering";

      await manager.leave({ guildId: "g1" });

      expect(player.stop).toHaveBeenCalledWith(true);
    });

    it("ignores new capture while playback is running", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });

      const player = getLastAudioPlayer();
      const entry = getSessionEntry(manager);
      player.state.status = "playing";

      await handleSpeakingStart(manager, entry, "u1");

      expect(player.stop).not.toHaveBeenCalled();
      expect(connection.receiver.subscribe).not.toHaveBeenCalled();
    });

    it("waits for decoded speech before interrupting realtime playback", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const { bridgeParams, entry, manager, player } = await createJoinedBidiFixture({
        allowFrom: ["discord:u1"],
        voice: {
          realtime: {
            bargeIn: true,
            providers: {
              openai: {
                interruptResponseOnInputAudio: false,
              },
            },
          },
        },
      });
      player.state.status = "playing";
      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));

      await handleSpeakingStart(manager, entry, "u1");

      expect(realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
      expect(player.stop).not.toHaveBeenCalled();
      const subscribeCall = lastMockCall(
        connection.receiver.subscribe as unknown as MockCallSource,
        "receiver subscribe",
      );
      expect(subscribeCall?.[0]).toBe("u1");
      expect(requireRecord(subscribeCall?.[1], "subscribe options").end).toBeTypeOf("object");
      bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
    });

    it.each([
      { amplitude: 0, interrupts: false },
      { amplitude: 8, interrupts: false },
      { amplitude: 32, interrupts: true },
    ])(
      "qualifies decoded input before barge-in (amplitude=$amplitude)",
      async ({ amplitude, interrupts }) => {
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        const { bridgeParams, entry, player } = await createJoinedBidiFixture({
          allowFrom: ["discord:u1"],
          voice: {
            realtime: {
              bargeIn: true,
              providers: {
                openai: {
                  interruptResponseOnInputAudio: false,
                },
              },
            },
          },
        });
        const turn = beginSpeakerTurn(entry, { userId: "u1", initialAudio: null });

        bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
        const input = Buffer.alloc(3840);
        for (let offset = 0; offset < input.length; offset += 2) {
          input.writeInt16LE(amplitude, offset);
        }
        turn.sendInputAudio(input);

        expect(realtimeSessionMock.setMediaTimestamp).toHaveBeenCalledWith(0);
        expect(realtimeSessionMock.handleBargeIn).toHaveBeenCalledTimes(interrupts ? 1 : 0);
        if (interrupts) {
          expect(realtimeSessionMock.setMediaTimestamp).toHaveBeenCalledWith(10);
          const lastTimestampCall =
            realtimeSessionMock.setMediaTimestamp.mock.invocationCallOrder.at(-1);
          const firstBargeInCall = realtimeSessionMock.handleBargeIn.mock.invocationCallOrder[0];
          expect(expectDefined(lastTimestampCall, "last media timestamp invocation")).toBeLessThan(
            expectDefined(firstBargeInCall, "first barge-in invocation"),
          );
        }
        expect(player.stop).not.toHaveBeenCalled();
        expect(realtimeSessionMock.sendAudio).toHaveBeenCalled();
        bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
      },
    );

    it("retries ongoing speech when the provider declines the first interruption", async () => {
      const { bridgeParams, entry, player } = await createJoinedBidiFixture({
        allowFrom: ["discord:u1"],
        voice: {
          realtime: {
            bargeIn: true,
            providers: { openai: { interruptResponseOnInputAudio: false } },
          },
        },
      });
      const turn = beginSpeakerTurn(entry, { userId: "u1", initialAudio: null });
      bridgeParams.audioSink?.sendAudio(Buffer.alloc(48_000));
      realtimeSessionMock.handleBargeIn
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => bridgeParams.audioSink?.clearAudio?.());
      const speech = Buffer.alloc(3840, 1);

      turn.sendInputAudio(speech);
      expect(realtimeSessionMock.handleBargeIn).toHaveBeenCalledOnce();
      expect(player.stop).not.toHaveBeenCalled();

      turn.sendInputAudio(speech);
      expect(realtimeSessionMock.handleBargeIn).toHaveBeenCalledTimes(2);
      expect(player.stop).toHaveBeenCalledWith(true);
      turn.sendInputAudio(speech);
      expect(realtimeSessionMock.handleBargeIn).toHaveBeenCalledTimes(2);
      turn.close();
    });

    it("does not interrupt new playback with speech retained in the input filter", async () => {
      const { bridgeParams, entry } = await createJoinedBidiFixture({
        allowFrom: ["discord:u1"],
        voice: {
          realtime: {
            bargeIn: true,
            providers: { openai: { interruptResponseOnInputAudio: false } },
          },
        },
      });
      const turn = beginSpeakerTurn(entry, { userId: "u1", initialAudio: Buffer.alloc(3840, 1) });
      bridgeParams.audioSink?.sendAudio(Buffer.alloc(48_000));

      turn.sendInputAudio(Buffer.alloc(3840));

      expect(realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
      expect(realtimeSessionMock.sendAudio).toHaveBeenCalledTimes(2);
      turn.close();
    });

    it("does not interrupt realtime provider state when local playback is already idle", async () => {
      const { entry, player } = await createJoinedBidiFixture({
        allowFrom: ["discord:u1"],
        voice: {
          realtime: {
            bargeIn: true,
            providers: {
              openai: {
                interruptResponseOnInputAudio: false,
              },
            },
          },
        },
      });
      beginSpeakerTurn(entry, { userId: "u1", initialAudio: Buffer.alloc(3840) });

      expect(realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
      expect(player.stop).not.toHaveBeenCalled();
      expect(realtimeSessionMock.sendAudio).toHaveBeenCalled();
    });

    it("sends trailing realtime silence when a speaker turn closes", async () => {
      const { entry } = await createJoinedBidiFixture({
        allowFrom: ["discord:u1"],
        voice: {
          realtime: {
            providers: {
              openai: {
                silenceDurationMs: 450,
              },
            },
          },
        },
      });
      const turn = beginSpeakerTurn(entry, { userId: "u1", initialAudio: Buffer.alloc(3840) });
      turn.close();

      const trailingSilence = realtimeSessionMock.sendAudio.mock.calls.at(-1)?.[0] as
        | Buffer
        | undefined;
      expect(trailingSilence).toBeInstanceOf(Buffer);
      expect(trailingSilence?.length).toBe(33_600);
      expect(trailingSilence?.equals(Buffer.alloc(33_600))).toBe(true);
    });

    it("clamps configured realtime trailing silence before allocating audio", async () => {
      const { entry } = await createJoinedBidiFixture({
        allowFrom: ["discord:u1"],
        voice: {
          realtime: {
            providers: {
              openai: {
                silenceDurationMs: 60_000,
              },
            },
          },
        },
      });
      const turn = beginSpeakerTurn(entry, { userId: "u1", initialAudio: Buffer.alloc(3840) });
      turn.close();

      const trailingSilence = realtimeSessionMock.sendAudio.mock.calls.at(-1)?.[0] as
        | Buffer
        | undefined;
      expect(trailingSilence).toBeInstanceOf(Buffer);
      expect(trailingSilence?.length).toBe(144_000);
      expect(trailingSilence?.equals(Buffer.alloc(144_000))).toBe(true);
    });

    it("ignores realtime capture during playback when barge-in is disabled", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const { entry, manager, player } = await createJoinedBidiFixture({
        allowFrom: ["discord:u1"],
        voice: { realtime: { bargeIn: false } },
      });
      player.state.status = "playing";

      await handleSpeakingStart(manager, entry, "u1");

      expect(realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
      expect(player.stop).not.toHaveBeenCalled();
      expect(connection.receiver.subscribe).not.toHaveBeenCalled();
    });

    it("passes DAVE options to joinVoiceChannel", async () => {
      const manager = createManager({
        voice: {
          daveEncryption: false,
          decryptionFailureTolerance: 8,
        },
      });

      await manager.join({ guildId: "g1", channelId: "1001" });

      const joinOptions = requireRecord(
        mockCall(joinVoiceChannelMock as unknown as MockCallSource, 0, "join voice call")[0],
        "join voice options",
      );
      expect(joinOptions.daveEncryption).toBe(false);
      expect(joinOptions.decryptionFailureTolerance).toBe(8);
    });

    it("deduplicates concurrent joins for the same guild and channel", async () => {
      const connection = createConnectionMock();
      const waiting = createDeferred<void>();
      const ready = createDeferred<undefined>();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      entersStateMock.mockImplementationOnce(() => {
        waiting.resolve();
        return ready.promise;
      });
      const manager = createManager();

      const firstJoin = manager.join({ guildId: "g1", channelId: "1001" });
      const secondJoin = manager.join({ guildId: "g1", channelId: "1001" });
      await waiting.promise;

      try {
        expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
      } finally {
        ready.resolve(undefined);
      }

      const [firstResult, secondResult] = await Promise.all([firstJoin, secondJoin]);

      expect(firstResult.ok).toBe(true);
      expect(secondResult.ok).toBe(true);
      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
      expect(entersStateMock).toHaveBeenCalledTimes(1);
    });

    it("serializes queued joins after an active guild join settles", async () => {
      const firstConnection = createConnectionMock();
      const secondConnection = createConnectionMock();
      const thirdConnection = createConnectionMock();
      const waiting = createDeferred<void>();
      const firstReady = createDeferred<undefined>();
      const secondReady = createDeferred<undefined>();
      const thirdReady = createDeferred<undefined>();
      joinVoiceChannelMock
        .mockReturnValueOnce(firstConnection)
        .mockReturnValueOnce(secondConnection)
        .mockReturnValueOnce(thirdConnection);
      entersStateMock
        .mockImplementationOnce(() => {
          waiting.resolve();
          return firstReady.promise;
        })
        .mockImplementationOnce(() => secondReady.promise)
        .mockImplementationOnce(() => thirdReady.promise);
      const manager = createManager();

      const firstJoin = manager.join({ guildId: "g1", channelId: "1001" });
      const secondJoin = manager.join({ guildId: "g1", channelId: "1002" });
      const thirdJoin = manager.join({ guildId: "g1", channelId: "1003" });
      await waiting.promise;

      try {
        expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);

        firstReady.resolve(undefined);
        await firstJoin;
        await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2));
        expect(entersStateMock).toHaveBeenCalledTimes(2);

        secondReady.resolve(undefined);
        await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(3));
        thirdReady.resolve(undefined);
        const [secondResult, thirdResult] = await Promise.all([secondJoin, thirdJoin]);

        expect(secondResult.ok).toBe(true);
        expect(thirdResult.ok).toBe(true);
        expect(entersStateMock).toHaveBeenCalledTimes(3);
      } finally {
        firstReady.resolve(undefined);
        secondReady.resolve(undefined);
        thirdReady.resolve(undefined);
        await Promise.all([firstJoin, secondJoin, thirdJoin]);
      }
    });

    it("serializes a join requested synchronously by channel lookup", async () => {
      const client = createClient();
      const fetchChannel = expectDefined(
        client.fetchChannel.getMockImplementation(),
        "channel lookup",
      );
      const manager = createManager(undefined, client);
      let secondJoin: ReturnType<typeof manager.join> | undefined;
      client.fetchChannel.mockImplementationOnce((channelId) => {
        secondJoin = manager.join({ guildId: "g1", channelId: "1002" });
        return fetchChannel(channelId);
      });

      const firstResult = await manager.join({ guildId: "g1", channelId: "1001" });
      const secondResult = await expectDefined(secondJoin, "reentrant join");

      expect(firstResult.ok).toBe(true);
      expect(secondResult.ok).toBe(true);
      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
      expectConnectedStatus(manager, "1002");
    });

    it("retains prior shutdown when leave immediately cancels a replacement join", async () => {
      const manager = createManager({
        voice: { enabled: true, mode: "agent-proxy", realtime: { provider: "openai" } },
      });
      await manager.join({ guildId: "g1", channelId: "1001" });
      const closing = createDeferred<void>();
      const stopped = createDeferred<void>();
      realtimeSessionMock.close.mockImplementationOnce(() => {
        closing.resolve();
        return stopped.promise;
      });

      const replacement = manager.join({ guildId: "g1", channelId: "1002" });
      const leaving = manager.leave({ guildId: "g1" });
      const successor = manager.join({ guildId: "g1", channelId: "1003" });
      try {
        await closing.promise;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
        stopped.resolve();
        const [replacementResult, , successorResult] = await Promise.all([
          replacement,
          leaving,
          successor,
        ]);
        expect(replacementResult.ok).toBe(false);
        expect(successorResult.ok).toBe(true);
        expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
        expectConnectedStatus(manager, "1003");
      } finally {
        stopped.resolve();
        await Promise.allSettled([replacement, leaving, successor]);
      }
    });

    it.each(["occupancy-loss", "cancelled"] as const)(
      "keeps queued joins behind physical cleanup after %s during startup",
      async (reason) => {
        const client = createClient();
        let voiceStates: Array<Record<string, unknown>> = [
          {
            guild_id: "g1",
            user_id: "human",
            channel_id: "1001",
            member: { user: { id: "human", bot: false } },
          },
        ];
        configureVoiceStateGateway(client, () => voiceStates);
        const connecting = createDeferred<void>();
        const ready = createDeferred<void>();
        const closing = createDeferred<void>();
        const stopped = createDeferred<void>();
        realtimeSessionMock.connect.mockImplementationOnce(async () => {
          connecting.resolve();
          await ready.promise;
        });
        realtimeSessionMock.close.mockImplementationOnce(() => {
          closing.resolve();
          return stopped.promise;
        });
        const manager = createManager(
          { voice: { enabled: true, mode: "agent-proxy", realtime: { provider: "openai" } } },
          client,
        );
        // Bound the original microtask starvation so its regression failure can finish cleanup.
        let waits = 0;
        logVerboseMock.mockImplementation((message: string) => {
          if (message.includes("waiting for active guild join") && ++waits >= 100) {
            throw new Error("Voice join starved physical cleanup by awaiting settled work");
          }
        });
        const first = manager.join(
          { guildId: "g1", channelId: "1001" },
          { autoJoinWhenOccupied: reason === "occupancy-loss" },
        );
        let leaving: ReturnType<typeof manager.leave> | undefined;
        let joins: Promise<Awaited<ReturnType<typeof manager.join>>[]> | undefined;
        try {
          await connecting.promise;
          if (reason === "occupancy-loss") {
            voiceStates = [];
          } else {
            leaving = manager.leave({ guildId: "g1", channelId: "1001" });
          }
          ready.resolve();
          await closing.promise;
          const second = manager.join({ guildId: "g1", channelId: "1002" });
          const third = manager.join({ guildId: "g1", channelId: "1003" });
          const joined = Promise.all([first, second, third]);
          joins = joined;
          void joined.catch(() => undefined);
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
          stopped.resolve();
          const [firstResult, secondResult, thirdResult] = await joined;
          await leaving;
          expect(firstResult.ok).toBe(reason === "occupancy-loss");
          expect(secondResult.ok).toBe(true);
          expect(thirdResult.ok).toBe(true);
          expect(joinVoiceChannelMock).toHaveBeenCalledTimes(3);
          expectConnectedStatus(manager, "1003");
        } finally {
          ready.resolve();
          stopped.resolve();
          logVerboseMock.mockReset();
          await Promise.allSettled([first, leaving, joins]);
        }
      },
    );

    it("does not start queued joins after the voice manager is destroyed", async () => {
      const connection = createConnectionMock();
      const waiting = createDeferred<void>();
      const ready = createDeferred<undefined>();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      entersStateMock.mockImplementationOnce(() => {
        waiting.resolve();
        return ready.promise;
      });
      const manager = createManager();

      const firstJoin = manager.join({ guildId: "g1", channelId: "1001" });
      const queuedJoin = manager.join({ guildId: "g1", channelId: "1002" });
      await waiting.promise;

      try {
        await manager.destroy();
      } finally {
        ready.resolve(undefined);
      }
      const [firstResult, queuedResult] = await Promise.all([firstJoin, queuedJoin]);

      expect(firstResult.ok).toBe(false);
      expect(queuedResult.ok).toBe(false);
      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
      expect(connection.destroy).toHaveBeenCalledTimes(1);
    });

    it("retries an aborted initial voice connection readiness wait", async () => {
      const firstConnection = createConnectionMock();
      const secondConnection = createConnectionMock();
      joinVoiceChannelMock
        .mockReturnValueOnce(firstConnection)
        .mockReturnValueOnce(secondConnection);
      entersStateMock
        .mockRejectedValueOnce(new Error("The operation was aborted"))
        .mockResolvedValueOnce(undefined);
      const manager = createManager();

      const result = await manager.join({ guildId: "g1", channelId: "1001" });

      expect(result.ok).toBe(true);
      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
      expect(entersStateMock).toHaveBeenCalledTimes(2);
      expect(firstConnection.destroy).toHaveBeenCalledTimes(1);
      expect(secondConnection.destroy).not.toHaveBeenCalled();
      expectConnectedStatus(manager, "1001");
    });

    it("does not retry an aborted voice connection readiness wait after the timeout budget is spent", async () => {
      const nowSpy = vi
        .spyOn(Date, "now")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(30_000);
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      entersStateMock.mockRejectedValueOnce(new Error("The operation was aborted"));
      const manager = createManager();

      try {
        const result = await manager.join({ guildId: "g1", channelId: "1001" });

        expect(result.ok).toBe(false);
        expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
        expect(entersStateMock).toHaveBeenCalledTimes(1);
        expect(connection.destroy).toHaveBeenCalledTimes(1);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("does not retry an aborted voice connection readiness wait after destroy", async () => {
      const firstConnection = createConnectionMock();
      const secondConnection = createConnectionMock();
      joinVoiceChannelMock
        .mockReturnValueOnce(firstConnection)
        .mockReturnValueOnce(secondConnection);
      entersStateMock.mockImplementationOnce(async () => {
        await manager.destroy();
        throw new Error("The operation was aborted");
      });
      const manager: InstanceType<typeof managerModule.DiscordVoiceManager> = createManager();

      const result = await manager.join({ guildId: "g1", channelId: "1001" });

      expect(result.ok).toBe(false);
      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
      expect(firstConnection.destroy).toHaveBeenCalledTimes(1);
      expect(secondConnection.destroy).not.toHaveBeenCalled();
    });

    it("closes realtime sessions when disconnected recovery destroys the connection", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const { manager } = await createJoinedAgentProxyFixture();

      entersStateMock.mockClear();
      entersStateMock.mockRejectedValueOnce(new Error("still disconnected"));
      entersStateMock.mockRejectedValueOnce(new Error("still disconnected"));

      const disconnected = connection.handlers.get("disconnected");
      expect(disconnected).toBeTypeOf("function");
      await disconnected?.();

      await vi.waitFor(() => expect(realtimeSessionMock.close).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(connection.destroy).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(manager.status()).toStrictEqual([]));
    });

    it("closes realtime sessions when Discord destroys the connection", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const { manager } = await createJoinedAgentProxyFixture();

      const destroyed = connection.handlers.get("destroyed");
      expect(destroyed).toBeTypeOf("function");
      // The SDK publishes terminal state before notifying Destroyed listeners.
      connection.state.status = "destroyed";
      destroyed?.();

      expect(realtimeSessionMock.close).toHaveBeenCalledTimes(1);
      expect(connection.destroy).not.toHaveBeenCalled();
      expect(manager.status()).toStrictEqual([]);
    });
  },
);
