import { ChannelType, GatewayDispatchEvents } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { GatewayPlugin } from "./gateway.js";

function createGateway() {
  const gateway = new GatewayPlugin({ autoInteractions: false });
  // SAFETY: the inventory is rebuilt from dispatches, so the fixture injects a
  // listener-free client instead of opening a gateway socket.
  (gateway as unknown as { client: unknown }).client = {
    dispatchGatewayEvent: vi.fn(async () => {}),
    getPlugin: vi.fn(() => undefined),
  };
  const handleDispatch = (t: string, d: unknown): Promise<void> =>
    (
      gateway as unknown as {
        handleDispatch(payload: { t: string; d: unknown }): Promise<void>;
      }
    ).handleDispatch({ t, d });
  return { gateway, handleDispatch };
}

describe("discord gateway channel inventory", () => {
  it("rebuilds guild channels and threads from the gateway snapshot", async () => {
    const { gateway, handleDispatch } = createGateway();

    await handleDispatch(GatewayDispatchEvents.GuildCreate, {
      id: "g1",
      voice_states: [],
      channels: [
        { id: "c1", name: "general", type: ChannelType.GuildText, parent_id: "cat1" },
        { id: "cat1", name: "Ops", type: ChannelType.GuildCategory },
      ],
      threads: [{ id: "t1", name: "triage", type: ChannelType.PublicThread, parent_id: "c1" }],
    });

    expect(gateway.getGatewayChannelInfo("c1")).toEqual({
      guildId: "g1",
      name: "general",
      parentId: "cat1",
      type: ChannelType.GuildText,
    });
    expect(gateway.getGatewayChannelInfo("t1")).toEqual({
      guildId: "g1",
      name: "triage",
      parentId: "c1",
      type: ChannelType.PublicThread,
    });
    expect(gateway.getGatewayChannelInfo("unknown")).toBeUndefined();
  });

  it("applies incremental channel and thread lifecycle events", async () => {
    const { gateway, handleDispatch } = createGateway();
    await handleDispatch(GatewayDispatchEvents.GuildCreate, {
      id: "g1",
      voice_states: [],
      channels: [{ id: "c1", name: "general", type: ChannelType.GuildText }],
      threads: [],
    });

    await handleDispatch(GatewayDispatchEvents.ChannelUpdate, {
      id: "c1",
      guild_id: "g1",
      name: "renamed",
      type: ChannelType.GuildText,
    });
    expect(gateway.getGatewayChannelInfo("c1")?.name).toBe("renamed");

    await handleDispatch(GatewayDispatchEvents.ThreadCreate, {
      id: "t2",
      guild_id: "g1",
      name: "spike",
      parent_id: "c1",
      type: ChannelType.PrivateThread,
    });
    expect(gateway.getGatewayChannelInfo("t2")?.type).toBe(ChannelType.PrivateThread);

    await handleDispatch(GatewayDispatchEvents.ThreadDelete, { id: "t2", guild_id: "g1" });
    expect(gateway.getGatewayChannelInfo("t2")).toBeUndefined();

    await handleDispatch(GatewayDispatchEvents.ChannelDelete, {
      id: "c1",
      guild_id: "g1",
      type: ChannelType.GuildText,
    });
    expect(gateway.getGatewayChannelInfo("c1")).toBeUndefined();
  });

  it("drops a guild's channels on GUILD_DELETE and the session's on READY", async () => {
    const { gateway, handleDispatch } = createGateway();
    await handleDispatch(GatewayDispatchEvents.GuildCreate, {
      id: "g1",
      voice_states: [],
      channels: [{ id: "c1", name: "general", type: ChannelType.GuildText }],
      threads: [],
    });
    await handleDispatch(GatewayDispatchEvents.GuildCreate, {
      id: "g2",
      voice_states: [],
      channels: [{ id: "c2", name: "other", type: ChannelType.GuildText }],
      threads: [],
    });

    await handleDispatch(GatewayDispatchEvents.GuildDelete, { id: "g1" });
    expect(gateway.getGatewayChannelInfo("c1")).toBeUndefined();
    expect(gateway.getGatewayChannelInfo("c2")?.name).toBe("other");

    await handleDispatch(GatewayDispatchEvents.Ready, { session_id: "s1" });
    expect(gateway.getGatewayChannelInfo("c2")).toBeUndefined();
  });

  it("reports a guild as hydrating between READY and its GUILD_CREATE", async () => {
    const { gateway, handleDispatch } = createGateway();
    // No session yet: the gateway cannot answer for any guild.
    expect(gateway.isGatewayChannelInventoryHydrating("g1")).toBe(true);

    await handleDispatch(GatewayDispatchEvents.Ready, {
      session_id: "s1",
      guilds: [
        { id: "g1", unavailable: true },
        { id: "g2", unavailable: true },
      ],
    });
    expect(gateway.isGatewayChannelInventoryHydrating("g1")).toBe(true);
    expect(gateway.isGatewayChannelInventoryHydrating("g2")).toBe(true);
    // A guild this session never announced is resolved, not hydrating.
    expect(gateway.isGatewayChannelInventoryHydrating("g3")).toBe(false);

    await handleDispatch(GatewayDispatchEvents.GuildCreate, {
      id: "g1",
      voice_states: [],
      channels: [{ id: "c1", name: "general", type: ChannelType.GuildText }],
      threads: [],
    });
    expect(gateway.isGatewayChannelInventoryHydrating("g1")).toBe(false);
    expect(gateway.isGatewayChannelInventoryHydrating("g2")).toBe(true);

    // An unavailable guild resolves through GUILD_DELETE rather than hanging.
    await handleDispatch(GatewayDispatchEvents.GuildDelete, { id: "g2", unavailable: true });
    expect(gateway.isGatewayChannelInventoryHydrating("g2")).toBe(false);
  });

  it("re-enters hydration on a fresh READY after a reconnect", async () => {
    const { gateway, handleDispatch } = createGateway();
    await handleDispatch(GatewayDispatchEvents.Ready, {
      session_id: "s1",
      guilds: [{ id: "g1", unavailable: true }],
    });
    await handleDispatch(GatewayDispatchEvents.GuildCreate, {
      id: "g1",
      voice_states: [],
      channels: [{ id: "c1", name: "general", type: ChannelType.GuildText }],
      threads: [],
    });
    expect(gateway.isGatewayChannelInventoryHydrating("g1")).toBe(false);

    await handleDispatch(GatewayDispatchEvents.Ready, {
      session_id: "s2",
      guilds: [{ id: "g1", unavailable: true }],
    });
    expect(gateway.isGatewayChannelInventoryHydrating("g1")).toBe(true);
    expect(gateway.getGatewayChannelInfo("c1")).toBeUndefined();
  });

  it("leaves unreadable and unavailable snapshots unknown rather than guessing", async () => {
    const { gateway, handleDispatch } = createGateway();
    await handleDispatch(GatewayDispatchEvents.GuildCreate, {
      id: "g1",
      voice_states: [],
      channels: [
        { id: "c1", name: "general" },
        { name: "no-id", type: ChannelType.GuildText },
        { id: "c2", name: "voice", type: ChannelType.GuildVoice },
      ],
      threads: [],
    });
    expect(gateway.getGatewayChannelInfo("c1")).toBeUndefined();
    expect(gateway.getGatewayChannelInfo("c2")?.type).toBe(ChannelType.GuildVoice);

    await handleDispatch(GatewayDispatchEvents.GuildCreate, { id: "g1", unavailable: true });
    expect(gateway.getGatewayChannelInfo("c2")).toBeUndefined();
  });
});
