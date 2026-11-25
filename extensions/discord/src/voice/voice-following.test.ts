import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests((h) => {
  const { expect, it, vi } = h;
  const voiceState = (
    userId: string,
    name: string,
    username = name.toLowerCase(),
    channelId: string | null = "1001",
  ) => ({
    guild_id: "g1",
    user_id: userId,
    channel_id: channelId,
    member: { nick: name, user: { id: userId, username, global_name: name } },
  });
  const slowMember = {
    nickname: "Slow User",
    roles: [],
    user: { id: "u-slow", username: "slow", globalName: "Slow User", discriminator: "0" },
  };
  const eventText = (index: number) => String(h.enqueueSystemEventMock.mock.calls[index]?.[0]);
  const allowedChannels = ["1001", "1002"].map((channelId) => ({ guildId: "g1", channelId }));
  const rosterFixture = async (
    states: () => Array<Record<string, unknown>>,
    client = h.createClient(),
    botUserId?: string,
  ) => {
    h.configureVoiceStateGateway(client, states);
    const manager = h.createManager(undefined, client, {}, "default", botUserId);
    await manager.join({ guildId: "g1", channelId: "1001" });
    await vi.waitFor(() => expect(h.enqueueSystemEventMock).toHaveBeenCalledOnce());
    return manager;
  };
  it("refreshes an active roster from a new gateway guild snapshot", async () => {
    let voiceStates = [voiceState("u-before", "Before")];
    const manager = await rosterFixture(() => voiceStates);
    h.enqueueSystemEventMock.mockClear();

    voiceStates = [voiceState("u-after", "After")];
    manager.refreshGuildRoster("g1");

    await vi.waitFor(() => expect(h.enqueueSystemEventMock).toHaveBeenCalledOnce());
    const refreshed = eventText(0);
    expect(refreshed).toContain("Discord voice session roster");
    expect(refreshed).toContain('user_id="u-after"');
    expect(refreshed).not.toContain('user_id="u-before"');
  });

  it("does not retain full membership state for very large voice rosters", async () => {
    let voiceStates = Array.from({ length: 5_000 }, (_, index) => ({
      guild_id: "g1",
      user_id: `u-${String(index).padStart(4, "0")}`,
      channel_id: "1001",
    }));
    const manager = await rosterFixture(() => voiceStates);

    const text = eventText(0);
    expect(text.match(/^- user_id=/gm)).toHaveLength(20);
    expect(text).toContain("- 4980 more participant(s)");
    const membership = manager["membership"]["states"].get(h.getSessionEntry(manager));
    expect(membership?.inferredUserIds.size).toBe(0);

    const overflowParticipant = h.expectDefined(
      voiceStates.at(-1),
      "overflow participant test invariant",
    );
    await manager.handleVoiceStateUpdate(
      { ...overflowParticipant, self_mute: true } as never,
      overflowParticipant as never,
    );
    expect(h.enqueueSystemEventMock).toHaveBeenCalledOnce();

    voiceStates = voiceStates.slice(0, -1);
    await manager.handleVoiceStateUpdate(
      { ...overflowParticipant, channel_id: null } as never,
      overflowParticipant as never,
    );
    expect(h.enqueueSystemEventMock).toHaveBeenCalledTimes(2);
    expect(eventText(1)).toContain("A participant left");
    expect(eventText(1)).toContain('user_id="u-4999"');
  });

  it("enqueues only real participant joins and leaves for the active voice channel", async () => {
    const client = h.createClient();
    let voiceStates: Array<Record<string, unknown>> = [
      voiceState("u-present", "Present"),
      { guild_id: "g1", user_id: "bot-user", channel_id: "1001" },
    ];
    client.fetchMember.mockImplementation(async (_guildId: string, userId: string) => ({
      nickname: userId === "u-present" ? "Present" : "New Friend",
      roles: [],
      user: { id: userId, username: userId, globalName: undefined, discriminator: "0" },
    }));
    const manager = await rosterFixture(() => voiceStates, client, "bot-user");
    h.enqueueSystemEventMock.mockClear();

    const joinedState = voiceState("u-new", "New Friend", "new");
    voiceStates = [...voiceStates, joinedState];
    await manager.handleVoiceStateUpdate(joinedState as never, null);

    await manager.handleVoiceStateUpdate(
      { guild_id: "g1", user_id: "u-new", channel_id: "1001", self_mute: true } as never,
      joinedState as never,
    );

    voiceStates = voiceStates.filter((state) => state.user_id !== "u-new");
    await manager.handleVoiceStateUpdate(
      voiceState("u-new", "New Friend", "new", null) as never,
      joinedState as never,
    );

    await h.updateVoiceState(manager, "u-new", null);
    await h.updateVoiceState(manager, "u-elsewhere", "1002");
    await h.updateVoiceState(manager, "bot-user", "1001");

    await vi.waitFor(() => expect(h.enqueueSystemEventMock).toHaveBeenCalledTimes(2));
    expect(h.enqueueSystemEventMock).toHaveBeenCalledTimes(2);
    const texts = h.enqueueSystemEventMock.mock.calls.map(([text]) => String(text));
    expect(texts[0]).toContain("A participant joined");
    expect(texts[0]).toContain('display_name="New Friend"');
    expect(texts[0]).toContain("Current participants other than the agent after this update");
    expect(texts[0]).toContain('user_id="u-present"');
    expect(texts[0]).toContain("This roster snapshot supersedes prior voice membership context");
    expect(texts[1]).toContain("A participant left");
    expect(texts[1]).toContain('user_id="u-new"');
    expect(texts[1]).toContain("Current participants other than the agent after this update");
    expect(texts[1]).toContain('user_id="u-present"');
    expect(texts[1]).toContain("This roster snapshot supersedes prior voice membership context");
    for (const call of h.enqueueSystemEventMock.mock.calls) {
      expect(call[1]).toEqual({
        sessionKey: "discord:g1:c1",
        contextKey: "discord:voice-membership:default:g1",
        replace: true,
      });
    }
  });

  it("keeps cache-race speakers in the roster until their leave events", async () => {
    const manager = await rosterFixture(() => []);
    h.enqueueSystemEventMock.mockClear();
    const entry = h.getSessionEntry(manager);

    await h.handleSpeakingStart(manager, entry, "u-raced-first");
    await h.handleSpeakingStart(manager, entry, "u-raced-second");
    await manager.handleVoiceStateUpdate(
      voiceState("u-raced-second", "Raced User", "raced", null) as never,
    );
    await vi.waitFor(() => expect(h.enqueueSystemEventMock).toHaveBeenCalledTimes(3));

    expect(eventText(1)).toContain("Voice activity established that a participant is present");
    expect(eventText(1)).toContain('user_id="u-raced-first"');
    expect(eventText(1)).toContain('user_id="u-raced-second"');
    expect(eventText(2)).toContain("A participant left");
    expect(eventText(2)).toContain('user_id="u-raced-first"');
  });

  it("publishes a membership change while startup label resolution is still pending", async () => {
    const client = h.createClient();
    const voiceStates: Array<Record<string, unknown>> = [
      { guild_id: "g1", user_id: "u-slow", channel_id: "1001" },
    ];
    h.configureVoiceStateGateway(client, () => voiceStates);
    const member = Promise.withResolvers<unknown>();
    client.fetchMember.mockReturnValue(member.promise);
    const manager = h.createManager(undefined, client);
    await manager.join({ guildId: "g1", channelId: "1001" });
    await vi.waitFor(() => expect(client.fetchMember).toHaveBeenCalledOnce());

    const joinedState = voiceState("u-new", "New Friend", "new");
    voiceStates.push(joinedState);
    await manager.handleVoiceStateUpdate(joinedState as never, null);

    expect(h.enqueueSystemEventMock).toHaveBeenCalledTimes(2);
    expect(eventText(1)).toContain("A participant joined");
    member.resolve(slowMember);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(h.enqueueSystemEventMock).toHaveBeenCalledTimes(2);
  });

  it("keeps joins and followed-user moves independent from roster label resolution", async () => {
    const client = h.createClient();
    h.configureVoiceStateGateway(client, (_guildId: unknown, channelId: unknown) =>
      channelId === "1001" ? [{ guild_id: "g1", user_id: "u-slow", channel_id: "1001" }] : [],
    );
    const member = Promise.withResolvers<unknown>();
    client.fetchMember.mockReturnValue(member.promise);
    const manager = h.createFollowManager({ allowedChannels }, client);

    const result = await manager.join({ guildId: "g1", channelId: "1001" });
    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(client.fetchMember).toHaveBeenCalledOnce());

    await manager.handleVoiceStateUpdate(
      { guild_id: "g1", user_id: "u-owner", channel_id: "1002" } as never,
      { guild_id: "g1", user_id: "u-owner", channel_id: "1001" } as never,
    );

    h.expectConnectedStatus(manager, "1002");
    expect(h.enqueueSystemEventMock).toHaveBeenCalledTimes(4);
    expect(eventText(2)).toContain("Discord voice session ended");
    expect(eventText(3)).toContain("Discord voice session roster");
    member.resolve(slowMember);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(h.enqueueSystemEventMock).toHaveBeenCalledTimes(4);

    const texts = h.enqueueSystemEventMock.mock.calls.map(([text]) => String(text));
    expect(texts[0]).toContain("Discord voice session roster");
    expect(texts[0]).toContain('channel_id="1001"');
    expect(texts[1]).toContain("A participant left");
    expect(texts[2]).toContain("Discord voice session ended");
    expect(texts[2]).toContain('channel_id="1001"');
    expect(texts[3]).toContain("Discord voice session roster");
    expect(texts[3]).toContain('channel_id="1002"');
    expect(texts.slice(2).some((text) => text.includes('user_id="u-slow"'))).toBe(false);
  });

  it("preserves follow ownership when a bot voice move rebuilds the session", async () => {
    const manager = h.createFollowManager({}, undefined, {}, "bot-user");

    await h.updateVoiceState(manager, "u-owner", "1001");
    await h.updateVoiceState(manager, "bot-user", "1002");
    await h.updateVoiceState(manager, "u-owner", null);

    expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(2);
    expect(manager.status()).toEqual([]);
  });

  it.each([false, true])("hands off to another followed user (lookup fails=%s)", async (fails) => {
    const client = h.createClient();
    const fetchChannel = h.expectDefined(
      client.fetchChannel.getMockImplementation(),
      "channel lookup",
    );
    let backupFetches = 0;
    client.fetchChannel.mockImplementation(async (channelId) => {
      if (channelId === "1002" && ++backupFetches > 1 && fails) {
        throw new Error("followed channel unavailable");
      }
      return fetchChannel(channelId);
    });
    const manager = h.createFollowManager(
      { allowedChannels, followUsers: ["u-owner", "u-backup"] },
      client,
    );
    await h.updateVoiceState(manager, "u-backup", "1002");
    await h.updateVoiceState(manager, "u-owner", "1001");
    await h.updateVoiceState(manager, "u-owner", null);
    if (fails) {
      expect(manager.status()).toEqual([]);
    } else {
      expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(3);
      h.expectConnectedStatus(manager, "1002");
    }
  });

  it.each([
    { followUsersEnabled: false },
    { allowedChannels: [{ guildId: "g1", channelId: "1001" }] },
  ])("does not follow users when policy denies the target (%j)", async (policy) => {
    const manager = h.createFollowManager(policy);
    await h.updateVoiceState(manager, "u-owner", "1002");
    expect(h.joinVoiceChannelMock).not.toHaveBeenCalled();
    expect(manager.status()).toEqual([]);
  });

  it("bounds followed user reconciliation REST lookups", async () => {
    const client = h.createClient();
    client.rest.get.mockRejectedValue(new Error("Unknown Voice State"));
    const guilds = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`g${index + 1}`, {}]),
    );
    const manager = h.createFollowManager(
      { followUsers: ["u1", "u2", "u3", "u4", "u5"] },
      client,
      { guilds },
      "bot-user",
    );

    await manager.autoJoin();
    expect(client.rest.get).toHaveBeenCalledTimes(24);
    for (let pass = 0; pass < 2; pass += 1) {
      const before = client.rest.get.mock.calls.length;
      await manager.autoJoin();
      const calls = client.rest.get.mock.calls.slice(before);
      expect(calls.length).toBeLessThanOrEqual(32);
      expect(new Set(calls.map(([path]) => String(path).split("/")[2])).size).toBeLessThanOrEqual(
        4,
      );
    }
    const visitedGuilds = new Set(
      client.rest.get.mock.calls.map(([path]) => String(path).split("/")[2]),
    );
    expect(visitedGuilds.size).toBe(10);
    await manager.destroy();
  });

  it("keeps followed voice state when reconciliation hits a transient REST failure", async () => {
    const client = h.createClient();
    const manager = h.createFollowManager({}, client, { guilds: { g1: {} } });

    await h.updateVoiceState(manager, "u-owner", "1001");
    client.rest.get.mockRejectedValue(new Error("Discord API failed (500): fetch failed"));

    await manager.autoJoin();

    h.expectConnectedStatus(manager, "1001");
    expect(h.updateVoiceStateMock).not.toHaveBeenCalled();
    await manager.destroy();
  });

  it("does not reconnect from an in-flight followed user reconciliation after destroy", async () => {
    const client = h.createClient();
    const requested = Promise.withResolvers<void>();
    const response = Promise.withResolvers<unknown>();
    client.rest.get.mockImplementation(() => {
      requested.resolve();
      return response.promise;
    });
    const manager = h.createFollowManager({}, client, { guilds: { g1: {} } });

    const autoJoinPromise = manager.autoJoin();
    await requested.promise;
    let destroyed = false;
    const destroying = manager.destroy().then(() => {
      destroyed = true;
    });
    await Promise.resolve();
    expect(destroyed).toBe(false);
    response.resolve({ guild_id: "g1", user_id: "u-owner", channel_id: "1001" });
    await Promise.all([destroying, autoJoinPromise]);

    expect(h.joinVoiceChannelMock).not.toHaveBeenCalled();
    expect(manager.status()).toEqual([]);
  });

  it("pages followed user reconciliation when the user list exceeds the REST budget", async () => {
    const client = h.createClient();
    client.rest.get.mockImplementation(async (path: string) => {
      if (path.endsWith("/u39")) {
        return { guild_id: "g1", user_id: "u39", channel_id: "1001" };
      }
      throw new Error("Unknown Voice State");
    });
    const manager = h.createFollowManager(
      { followUsers: Array.from({ length: 40 }, (_, index) => `u${index + 1}`) },
      client,
      { guilds: { g1: {} } },
      "bot-user",
    );

    await manager.autoJoin();
    expect(client.rest.get).toHaveBeenCalledTimes(32);
    expect(h.joinVoiceChannelMock).not.toHaveBeenCalled();

    await manager.autoJoin();
    await manager.destroy();

    // The bot slot needs no REST lookup after the followed user was found.
    expect(client.rest.get).toHaveBeenCalledTimes(63);
    expect(h.joinVoiceChannelMock).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: "g1", channelId: "1001" }),
    );
  });

  it("rotates followed user reconciliation bot voice checks when only some fit the REST budget", async () => {
    const client = h.createClient();
    client.rest.get.mockImplementation(async (path: string) => {
      if (path.includes("/guilds/g3/") && path.endsWith("/bot-user")) {
        return { guild_id: "g3", user_id: "bot-user", channel_id: "3001" };
      }
      throw new Error("Unknown Voice State");
    });
    const manager = h.createFollowManager(
      { followUsers: Array.from({ length: 10 }, (_, index) => `u${index + 1}`) },
      client,
      { guilds: { g1: {}, g2: {}, g3: {} } },
      "bot-user",
    );

    await manager.autoJoin();
    expect(client.rest.get).toHaveBeenCalledTimes(32);
    expect(h.updateVoiceStateMock).not.toHaveBeenCalled();

    await manager.autoJoin();
    await manager.destroy();

    expect(client.rest.get).toHaveBeenCalledTimes(64);
    expect(h.updateVoiceStateMock).toHaveBeenCalledWith({
      guild_id: "g3",
      channel_id: null,
      self_mute: false,
      self_deaf: false,
    });
  });

  it("treats an empty allowed voice channel list as deny-all", async () => {
    const manager = h.createManager(h.makeVoiceConfig({ allowedChannels: [] }));

    const result = await manager.join({ guildId: "g1", channelId: "1001" });

    expect(result.ok).toBe(false);
    expect(h.joinVoiceChannelMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "handles a bot move outside its configured target (occupancy-managed=%s)",
    async (whenOccupied) => {
      const manager = h.createManager(
        h.makeVoiceConfig({
          autoJoin: [
            { guildId: "g1", channelId: "1001", ...(whenOccupied ? { whenOccupied } : {}) },
          ],
          allowedChannels: [{ guildId: "g1", channelId: "1001" }],
        }),
        undefined,
        {},
        "default",
        "bot-user",
      );
      await manager.join({ guildId: "g1", channelId: "1001" });
      await h.updateVoiceState(manager, "bot-user", "1002");
      expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(whenOccupied ? 1 : 2);
      if (whenOccupied) {
        expect(manager.status()).toEqual([]);
      } else {
        h.expectConnectedStatus(manager, "1001");
      }
    },
  );
});
