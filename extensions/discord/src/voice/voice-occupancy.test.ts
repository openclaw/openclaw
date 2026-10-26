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

  it.each(["Ready", "GuildCreate"] as const)(
    "waits for a known snapshot and reconciles on %s without conversational auto-join",
    async (event) => {
      const { cache, client, manager, seed } = fixture();
      const listener = vi.fn();
      manager.watchChannelOccupancy(room, listener);
      expect(listener).not.toHaveBeenCalled();
      seed(voiceState("human-one", "1001"));
      const listeners = {
        Ready: new h.listenersModule.DiscordVoiceReadyListener(manager),
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

  it("retains occupancy and channel title through transcript join/leave, then clears on destroy", async () => {
    const { manager, client, update } = fixture();
    const channel = client.fetchChannel.getMockImplementation()!;
    client.fetchChannel.mockImplementation(async (id) => ({
      ...h.expectDefined(await channel(id), "voice channel"),
      name: "Planning room",
    }));
    await update(voiceState("human-one", "1001"));
    const listener = vi.fn();
    manager.watchChannelOccupancy(room, listener);
    expect(listener).toHaveBeenCalledExactlyOnceWith({ occupied: true });
    for (const sessionId of ["first", "second"]) {
      expect(
        await h.startTranscripts(manager, vi.fn(), sessionId, "1001", "primary"),
      ).toMatchObject({ ok: true, session: { title: "Planning room" } });
      if (sessionId === "first") {
        expect(client.fetchChannel).toHaveBeenCalledExactlyOnceWith("1001");
      }
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
});
