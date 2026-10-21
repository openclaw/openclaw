import { setImmediate as waitImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { DiscordError } from "../internal/discord.js";
import type { MockCallSource } from "./manager.e2e.test-support.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests((h) => {
  const { expect, it, vi } = h;
  const bargeInFixture = () =>
    h.createJoinedBidiFixture({
      allowFrom: ["discord:u1"],
      voice: {
        realtime: {
          bargeIn: true,
          providers: { openai: { interruptResponseOnInputAudio: false } },
        },
      },
    });
  it("rejects joins when Discord voice config is absent", async () => {
    const manager = h.createManager({});

    const result = await manager.join({ guildId: "g1", channelId: "1001" });
    expect(result).toMatchObject({
      ok: false,
      message: "Discord voice is disabled (channels.discord.voice.enabled).",
    });

    expect(h.joinVoiceChannelMock).not.toHaveBeenCalled();
  });

  it.each(["disconnected", "destroyed"])(
    "keeps the new session when an old %s handler fires",
    async (event) => {
      const oldConnection = h.useConnection();
      h.useConnection();
      if (event === "disconnected") {
        h.entersStateMock.mockImplementation(async (target, status) => {
          if (target === oldConnection && (status === "signalling" || status === "connecting")) {
            throw new Error("old disconnected");
          }
          return undefined;
        });
      }
      const manager = h.createManager();
      await manager.join({ guildId: "g1", channelId: "1001" });
      await manager.join({ guildId: "g1", channelId: "1002" });
      const handler = oldConnection.handlers.get(event);
      expect(handler).toBeTypeOf("function");
      await handler?.();
      h.expectConnectedStatus(manager, "1002");
    },
  );

  it.each(["leave", "destroy"] as const)(
    "does not spawn a replacement worker after %s wins socket shutdown",
    async (boundary) => {
      const manager = h.createManager();
      const stop = vi.spyOn(manager["voiceSessions"], "stopTransport");
      const { entered, release } = h.blockOperation(stop);
      const joining = manager.join({ guildId: "g1", channelId: "1001" });
      await entered;
      if (boundary === "leave") {
        await manager.leave({ guildId: "g1" });
      } else {
        await manager.destroy();
      }
      release();
      expect((await joining).ok).toBe(false);
      expect(h.joinVoiceChannelMock).not.toHaveBeenCalled();
      expect(h.createAudioPlayerMock).not.toHaveBeenCalled();
      stop.mockRestore();
    },
  );

  it("keeps a departing worker as the join barrier until physical shutdown settles", async () => {
    const manager = h.createManager();
    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = h.getSessionEntry(manager);
    const release = createDeferred<void>();
    const originalStop = entry.audio.stop.bind(entry.audio);
    const physicalStop = release.promise.then(originalStop);
    vi.spyOn(entry.audio, "stop").mockReturnValue(physicalStop);
    const leaving = manager.leave({ guildId: "g1" });
    const joining = manager.join({ guildId: "g1", channelId: "1002" });
    try {
      await waitImmediate();
      expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(1);
      release.resolve();
      await leaving;
      expect((await joining).ok).toBe(true);
      h.expectConnectedStatus(manager, "1002");
    } finally {
      release.resolve();
      await Promise.allSettled([leaving, joining]);
    }
  });

  it("isolates voice connections by Discord account", async () => {
    const firstManager = h.createManager(undefined, undefined, undefined, "first");
    const secondManager = h.createManager(undefined, undefined, undefined, "second");

    await firstManager.join({ guildId: "g1", channelId: "1001" });
    await secondManager.join({ guildId: "g1", channelId: "1002" });

    expect(h.joinVoiceChannelMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ group: "openclaw:first" }),
    );
    expect(h.joinVoiceChannelMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ group: "openclaw:second" }),
    );
  });

  const missingAccessError = new DiscordError(new Response(null, { status: 403 }), {
    message: "Missing Access",
    code: 50001,
  });
  it.each([
    {
      name: "rejects a fetched GuildText channel",
      response: { id: "1001", guildId: "g1", type: h.ChannelType.GuildText },
      expected: { ok: false, message: "Channel 1001 is not a voice channel." },
    },
    {
      name: "accepts a fetched GuildStageVoice channel",
      response: { id: "1001", guildId: "g1", type: h.ChannelType.GuildStageVoice },
      expected: {
        ok: true,
        message: "Joined <#1001>.",
        guildId: "g1",
        channelId: "1001",
      },
    },
  ])("$name", async ({ response, expected }) => {
    const client = h.createClient();
    client.fetchChannel.mockImplementationOnce(async () => {
      return response as never;
    });
    const manager = h.createManager(undefined, client);

    await expect(manager.join({ guildId: "g1", channelId: "1001" })).resolves.toEqual(expected);
  });

  it("keeps cancellation authoritative when channel lookup later rejects", async () => {
    const lookup = createDeferred<never>();
    const client = h.createClient();
    client.fetchChannel.mockReturnValueOnce(lookup.promise);
    const manager = h.createManager(undefined, client);

    const join = manager.join({ guildId: "g1", channelId: "1001" });
    await vi.waitFor(() => expect(client.fetchChannel).toHaveBeenCalledOnce());
    await manager.leave({ guildId: "g1" });
    lookup.reject(missingAccessError);

    await expect(join).resolves.toEqual({
      ok: false,
      message: "Discord voice join was cancelled.",
      guildId: "g1",
      channelId: "1001",
    });
  });

  it("waits for decoded speech before interrupting realtime playback", async () => {
    const connection = h.useConnection();
    const { bridgeParams, entry, manager, player } = await bargeInFixture();
    player.state.status = "playing";
    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));

    await h.handleSpeakingStart(manager, entry, "u1");

    expect(h.realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
    expect(player.stop).not.toHaveBeenCalled();
    const subscribeCall = h.lastMockCall(
      connection.receiver.subscribe as unknown as MockCallSource,
      "receiver subscribe",
    );
    expect(subscribeCall?.[0]).toBe("u1");
    expect(h.requireRecord(subscribeCall?.[1], "subscribe options").end).toBeTypeOf("object");
    bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
  });

  it("qualifies decoded input before barge-in", async () => {
    h.useConnection();
    const { bridgeParams, entry, player } = await bargeInFixture();
    const turn = h.beginSpeakerTurn(entry, { userId: "u1", initialAudio: null });

    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
    const input = Buffer.alloc(3840);
    for (let offset = 0; offset < input.length; offset += 2) {
      input.writeInt16LE(32, offset);
    }
    turn.sendInputAudio(input);

    expect(h.realtimeSessionMock.setMediaTimestamp).toHaveBeenCalledWith(0);
    expect(h.realtimeSessionMock.handleBargeIn).toHaveBeenCalledOnce();
    expect(h.realtimeSessionMock.setMediaTimestamp).toHaveBeenCalledWith(10);
    const lastTimestampCall =
      h.realtimeSessionMock.setMediaTimestamp.mock.invocationCallOrder.at(-1);
    const firstBargeInCall = h.realtimeSessionMock.handleBargeIn.mock.invocationCallOrder[0];
    expect(h.expectDefined(lastTimestampCall, "last media timestamp invocation")).toBeLessThan(
      h.expectDefined(firstBargeInCall, "first barge-in invocation"),
    );
    expect(player.stop).not.toHaveBeenCalled();
    expect(h.realtimeSessionMock.sendAudio).toHaveBeenCalled();
    bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
  });

  it("retries ongoing speech when the provider declines the first interruption", async () => {
    const { bridgeParams, entry, player } = await bargeInFixture();
    const turn = h.beginSpeakerTurn(entry, { userId: "u1", initialAudio: null });
    bridgeParams.audioSink?.sendAudio(Buffer.alloc(48_000));
    h.realtimeSessionMock.handleBargeIn
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => bridgeParams.audioSink?.clearAudio?.());
    const speech = Buffer.alloc(3840, 1);

    turn.sendInputAudio(speech);
    expect(h.realtimeSessionMock.handleBargeIn).toHaveBeenCalledOnce();
    expect(player.stop).not.toHaveBeenCalled();

    turn.sendInputAudio(speech);
    expect(h.realtimeSessionMock.handleBargeIn).toHaveBeenCalledTimes(2);
    expect(player.stop).toHaveBeenCalledWith(true);
    turn.sendInputAudio(speech);
    expect(h.realtimeSessionMock.handleBargeIn).toHaveBeenCalledTimes(2);
    turn.close();
  });

  it("does not interrupt new playback with speech retained in the input filter", async () => {
    const { bridgeParams, entry } = await bargeInFixture();
    const turn = h.beginSpeakerTurn(entry, { userId: "u1", initialAudio: Buffer.alloc(3840, 1) });
    bridgeParams.audioSink?.sendAudio(Buffer.alloc(48_000));

    turn.sendInputAudio(Buffer.alloc(3840));

    expect(h.realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
    expect(h.realtimeSessionMock.sendAudio).toHaveBeenCalledTimes(2);
    turn.close();
  });

  it("sends trailing realtime silence when a speaker turn closes", async () => {
    const { entry } = await h.createJoinedBidiFixture({
      allowFrom: ["discord:u1"],
      voice: { realtime: { providers: { openai: { silenceDurationMs: 450 } } } },
    });
    const turn = h.beginSpeakerTurn(entry, { userId: "u1", initialAudio: Buffer.alloc(3840) });
    turn.close();

    const trailingSilence = h.realtimeSessionMock.sendAudio.mock.calls.at(-1)?.[0] as
      | Buffer
      | undefined;
    expect(trailingSilence).toStrictEqual(Buffer.alloc(33_600));
  });

  it("ignores realtime capture during playback when barge-in is disabled", async () => {
    const connection = h.useConnection();
    const { entry, manager, player } = await h.createJoinedBidiFixture({
      allowFrom: ["discord:u1"],
      voice: { realtime: { bargeIn: false } },
    });
    player.state.status = "playing";

    await h.handleSpeakingStart(manager, entry, "u1");

    expect(h.realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
    expect(player.stop).not.toHaveBeenCalled();
    expect(connection.receiver.subscribe).not.toHaveBeenCalled();
  });

  it("passes DAVE options to joinVoiceChannel", async () => {
    const manager = h.createManager({
      voice: { daveEncryption: false, decryptionFailureTolerance: 8 },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });

    expect(h.mockCall(h.joinVoiceChannelMock, 0, "join voice call")[0]).toMatchObject({
      daveEncryption: false,
      decryptionFailureTolerance: 8,
    });
  });

  it.each([false, true])("settles concurrent joins when destroy=%s", async (destroyed) => {
    const connection = h.useConnection();
    const { entered, release } = h.blockOperation(h.entersStateMock);
    const manager = h.createManager();
    const first = manager.join({ guildId: "g1", channelId: "1001" });
    const second = manager.join({ guildId: "g1", channelId: destroyed ? "1002" : "1001" });
    await entered;
    try {
      if (destroyed) {
        await manager.destroy();
      } else {
        expect(h.joinVoiceChannelMock).toHaveBeenCalledOnce();
      }
    } finally {
      release();
    }
    expect(await Promise.all([first, second])).toMatchObject([
      { ok: !destroyed },
      { ok: !destroyed },
    ]);
    expect(h.joinVoiceChannelMock).toHaveBeenCalledOnce();
    if (destroyed) {
      expect(connection.destroy).toHaveBeenCalledOnce();
    } else {
      expect(h.entersStateMock).toHaveBeenCalledOnce();
    }
  });

  it("serializes queued joins after an active guild join settles", async () => {
    for (let index = 0; index < 3; index++) {
      h.useConnection();
    }
    const first = h.blockOperation(h.entersStateMock);
    const second = h.blockOperation(h.entersStateMock);
    const third = h.blockOperation(h.entersStateMock);
    const manager = h.createManager();

    const firstJoin = manager.join({ guildId: "g1", channelId: "1001" });
    const secondJoin = manager.join({ guildId: "g1", channelId: "1002" });
    const thirdJoin = manager.join({ guildId: "g1", channelId: "1003" });
    await first.entered;

    try {
      expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(1);

      first.release();
      await firstJoin;
      await vi.waitFor(() => expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(2));
      expect(h.entersStateMock).toHaveBeenCalledTimes(2);

      second.release();
      await vi.waitFor(() => expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(3));
      third.release();
      const [secondResult, thirdResult] = await Promise.all([secondJoin, thirdJoin]);

      expect([secondResult, thirdResult]).toMatchObject([{ ok: true }, { ok: true }]);
      expect(h.entersStateMock).toHaveBeenCalledTimes(3);
    } finally {
      first.release();
      second.release();
      third.release();
      await Promise.all([firstJoin, secondJoin, thirdJoin]);
    }
  });

  it("serializes a join requested synchronously by channel lookup", async () => {
    const client = h.createClient();
    const fetchChannel = h.expectDefined(
      client.fetchChannel.getMockImplementation(),
      "channel lookup",
    );
    const manager = h.createManager(undefined, client);
    let secondJoin: ReturnType<typeof manager.join> | undefined;
    client.fetchChannel.mockImplementationOnce((channelId) => {
      secondJoin = manager.join({ guildId: "g1", channelId: "1002" });
      return fetchChannel(channelId);
    });

    const firstResult = await manager.join({ guildId: "g1", channelId: "1001" });
    const secondResult = await h.expectDefined(secondJoin, "reentrant join");

    expect([firstResult, secondResult]).toMatchObject([{ ok: true }, { ok: true }]);
    expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(2);
    h.expectConnectedStatus(manager, "1002");
  });

  it("retains prior shutdown when leave immediately cancels a replacement join", async () => {
    const manager = h.createManager({
      voice: { enabled: true, mode: "agent-proxy", realtime: { provider: "openai" } },
    });
    await manager.join({ guildId: "g1", channelId: "1001" });
    const closing = h.blockOperation(h.realtimeSessionMock.close);

    const replacement = manager.join({ guildId: "g1", channelId: "1002" });
    const leaving = manager.leave({ guildId: "g1" });
    const successor = manager.join({ guildId: "g1", channelId: "1003" });
    try {
      await closing.entered;
      await waitImmediate();
      expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(1);
      closing.release();
      const [replacementResult, , successorResult] = await Promise.all([
        replacement,
        leaving,
        successor,
      ]);
      expect(replacementResult.ok).toBe(false);
      expect(successorResult.ok).toBe(true);
      expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(2);
      h.expectConnectedStatus(manager, "1003");
    } finally {
      closing.release();
      await Promise.allSettled([replacement, leaving, successor]);
    }
  });

  it.each(["occupancy-loss", "cancelled"] as const)(
    "keeps queued joins behind physical cleanup after %s during startup",
    async (reason) => {
      const client = h.createClient();
      let voiceStates: Array<Record<string, unknown>> = [
        {
          guild_id: "g1",
          user_id: "human",
          channel_id: "1001",
          member: { user: { id: "human", bot: false } },
        },
      ];
      h.configureVoiceStateGateway(client, () => voiceStates);
      const connecting = h.blockOperation(h.realtimeSessionMock.connect);
      const closing = h.blockOperation(h.realtimeSessionMock.close);
      const manager = h.createManager(
        { voice: { enabled: true, mode: "agent-proxy", realtime: { provider: "openai" } } },
        client,
      );
      // Bound the original microtask starvation so its regression failure can finish cleanup.
      let waits = 0;
      h.logVerboseMock.mockImplementation((message: string) => {
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
        await connecting.entered;
        if (reason === "occupancy-loss") {
          voiceStates = [];
        } else {
          leaving = manager.leave({ guildId: "g1", channelId: "1001" });
        }
        connecting.release();
        await closing.entered;
        const second = manager.join({ guildId: "g1", channelId: "1002" });
        const third = manager.join({ guildId: "g1", channelId: "1003" });
        const joined = Promise.all([first, second, third]);
        joins = joined;
        void joined.catch(() => undefined);
        await waitImmediate();
        expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(1);
        closing.release();
        const [firstResult, secondResult, thirdResult] = await joined;
        await leaving;
        expect(firstResult.ok).toBe(reason === "occupancy-loss");
        expect([secondResult, thirdResult]).toMatchObject([{ ok: true }, { ok: true }]);
        expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(3);
        h.expectConnectedStatus(manager, "1003");
      } finally {
        connecting.release();
        closing.release();
        h.logVerboseMock.mockReset();
        await Promise.allSettled([first, leaving, joins]);
      }
    },
  );

  it.each(["early-abort", "timeout", "destroyed"] as const)(
    "fails aborted readiness after %s without another join",
    async (outcome) => {
      const firstConnection = h.useConnection();
      const secondConnection = outcome === "timeout" ? undefined : h.useConnection();
      const now =
        outcome === "timeout"
          ? vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(30_000)
          : undefined;
      const manager = h.createManager();
      h.entersStateMock.mockImplementationOnce(async () => {
        if (outcome === "destroyed") {
          await manager.destroy();
        }
        throw new Error("The operation was aborted");
      });
      try {
        expect((await manager.join({ guildId: "g1", channelId: "1001" })).ok).toBe(false);
        expect(h.joinVoiceChannelMock).toHaveBeenCalledOnce();
        if (outcome !== "destroyed") {
          expect(h.entersStateMock).toHaveBeenCalledOnce();
        }
        expect(firstConnection.destroy).toHaveBeenCalledOnce();
        if (secondConnection) {
          expect(secondConnection.destroy).not.toHaveBeenCalled();
        }
      } finally {
        now?.mockRestore();
      }
    },
  );

  it.each([
    { configured: true, connectTimeoutMs: 45_000, reconnectGraceMs: 20_000 },
    { configured: false, connectTimeoutMs: 30_000, reconnectGraceMs: 15_000 },
  ])(
    "uses connection and reconnect timeouts before destroying disconnected sessions (configured=$configured)",
    async ({ configured, connectTimeoutMs, reconnectGraceMs }) => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      try {
        const connection = h.useConnection();
        const manager = h.createManager({
          voice: {
            mode: "agent-proxy",
            ...(configured ? { connectTimeoutMs, reconnectGraceMs } : {}),
          },
        });
        await manager.join({ guildId: "g1", channelId: "1001" });
        const readyCall = h.entersStateMock.mock.calls[0];
        expect(readyCall?.[0]).toBe(connection);
        expect(readyCall?.[1]).toBe("ready");
        expect(timeout.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(connectTimeoutMs - 100);
        expect(timeout.mock.calls[0]?.[0]).toBeLessThanOrEqual(connectTimeoutMs);

        expect(readyCall?.[2]).toMatchObject({ aborted: false });

        if (!configured) {
          connection.handlers.get("disconnected")?.();
          await vi.waitFor(() =>
            expect(h.entersStateMock).toHaveBeenCalledWith(
              connection,
              "connecting",
              expect.any(AbortSignal),
            ),
          );
        }
        h.entersStateMock.mockClear();
        h.entersStateMock.mockRejectedValueOnce(new Error("still disconnected"));
        h.entersStateMock.mockRejectedValueOnce(new Error("still disconnected"));
        const disconnected = connection.handlers.get("disconnected");
        expect(disconnected).toBeTypeOf("function");
        await disconnected?.();
        expect(timeout).toHaveBeenLastCalledWith(reconnectGraceMs);
        for (const state of ["signalling", "connecting"]) {
          expect(h.entersStateMock).toHaveBeenCalledWith(
            connection,
            state,
            expect.any(AbortSignal),
          );
        }
        await vi.waitFor(() => expect(connection.destroy).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(manager.status()).toStrictEqual([]));
        expect(readyCall?.[2]).toMatchObject({ aborted: true });
        expect(h.realtimeSessionMock.close).toHaveBeenCalledOnce();
      } finally {
        timeout.mockRestore();
      }
    },
  );
});
