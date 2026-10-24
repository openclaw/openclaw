import { GatewayDispatchEvents, type APIVoiceState } from "../internal/discord.js";
import { DiscordGatewayVoiceStateCache } from "../internal/gateway-voice-state-cache.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests((h) => {
  const { expect, it, vi } = h;
  const expectOccupancy = (listener: ReturnType<typeof vi.fn>, ...occupied: boolean[]) =>
    expect(listener.mock.calls).toEqual(occupied.map((value) => [{ occupied: value }]));
  const room = { guildId: "g1", channelId: "1001" };
  const voiceState = (userId: string, channelId: string | null, bot = false): APIVoiceState =>
    ({
      guild_id: "g1",
      user_id: userId,
      channel_id: channelId,
      member: { user: { id: userId, bot } },
    }) as APIVoiceState;

  const fixture = () => {
    const cache = new DiscordGatewayVoiceStateCache();
    const client = h.createClient();
    h.configureVoiceStateGateway(client, (guildId, channelId) =>
      cache.listVoiceChannelStates(String(guildId), String(channelId)),
    );
    const manager = h.createManager(h.makeAgentProxyConfig(), client, {}, "primary", "own-bot");
    const seed = (state: APIVoiceState) =>
      cache.apply({ t: GatewayDispatchEvents.VoiceStateUpdate, d: state } as never);
    const update = async (state: APIVoiceState) => {
      seed(state);
      await manager.handleVoiceStateUpdate(state);
    };
    return { cache, client, manager, seed, update };
  };

  it("reports ordered human transitions, ignores bots, and unsubscribes independently", async () => {
    const { manager, update } = fixture();
    const listener = vi.fn();
    const otherListener = vi.fn();
    const stop = manager.watchChannelOccupancy(room, listener);
    manager.watchChannelOccupancy(room, otherListener);
    await update(voiceState("helper-bot", "1001", true));
    await update(voiceState("own-bot", "1001"));
    expect(listener).toHaveBeenCalledExactlyOnceWith({ occupied: false });
    await update(voiceState("human-one", "1001"));
    await update(voiceState("human-two", "1001"));
    await update(voiceState("human-one", null));
    await update(voiceState("human-two", "1002"));
    expectOccupancy(listener, false, true, false);
    stop();
    await update(voiceState("human-one", "1001"));
    expect(listener).toHaveBeenCalledTimes(3);
    expectOccupancy(otherListener, false, true, false, true);
  });

  it.each(["Ready", "Resumed", "GuildCreate"] as const)(
    "waits for a known snapshot and reconciles on %s without conversational auto-join",
    async (event) => {
      const { cache, client, manager, seed } = fixture();
      const listener = vi.fn();
      manager.watchChannelOccupancy(room, listener);
      expect(listener).not.toHaveBeenCalled();
      seed(voiceState("human-one", "1001"));
      const listeners = {
        Ready: new h.listenersModule.DiscordVoiceReadyListener(manager),
        Resumed: new h.listenersModule.DiscordVoiceResumedListener(manager),
        GuildCreate: new h.listenersModule.DiscordVoiceGuildCreateListener(manager),
      };
      const reconcile = () =>
        listeners[event].handle({ id: "g1", unavailable: false } as never, client as never);
      await reconcile();
      expect(listener).toHaveBeenCalledExactlyOnceWith({ occupied: true });
      cache.clear();
      await reconcile();
      seed(voiceState("human-one", "1001"));
      await reconcile();
      expect(listener).toHaveBeenCalledExactlyOnceWith({ occupied: true });
      expect(manager.status()).toEqual([]);
    },
  );

  it("emits occupied on subscription, survives transcript join/leave, and clears on destroy", async () => {
    const { manager, update } = fixture();
    await update(voiceState("human-one", "1001"));
    const listener = vi.fn();
    manager.watchChannelOccupancy(room, listener);
    expect(listener).toHaveBeenCalledExactlyOnceWith({ occupied: true });
    for (const sessionId of ["first", "second"]) {
      await h.startTranscripts(manager, vi.fn(), sessionId, "1001", "primary");
      await h.stopTranscripts(sessionId, "1001", "primary");
    }
    await update(voiceState("human-one", null));
    await update(voiceState("human-one", "1001"));
    expectOccupancy(listener, true, false, true);
    expect(h.createRealtimeVoiceBridgeSessionMock).not.toHaveBeenCalled();
    await manager.destroy();
    await update(voiceState("human-one", null));
    manager.watchChannelOccupancy(room, listener);
    await update(voiceState("human-one", "1001"));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("returns the joined channel title without another channel lookup or starting realtime", async () => {
    const { manager, client } = fixture();
    const channel = {
      id: "1001",
      guildId: "g1",
      guild: { id: "g1", name: "Guild One" },
      type: h.ChannelType.GuildVoice,
      name: "Planning room",
    };
    client.fetchChannel.mockResolvedValue(channel);
    const result = await h.startTranscripts(manager, vi.fn(), "notes", "1001", "primary");
    expect(result).toMatchObject({ ok: true, session: { title: "Planning room" } });
    expect(client.fetchChannel).toHaveBeenCalledExactlyOnceWith("1001");
    expect(h.createRealtimeVoiceBridgeSessionMock).not.toHaveBeenCalled();
  });
});
