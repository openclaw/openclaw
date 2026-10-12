// Discord tests prove a stale-ambient verdict never outlives the channel facts it read.
import { ChannelType, GatewayDispatchEvents } from "discord-api-types/v10";
import type { ChannelIngressQueueRecord } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { DiscordGatewayChannelInventory } from "../internal/gateway-channel-inventory.js";
import { createInternalTestClient } from "../internal/test-builders.test-support.js";
import type { DiscordGuildEntryResolved } from "./allow-list.js";
import { createDiscordStaleAmbientPendingDisposition } from "./ingress-stale-policy.js";
import type { DiscordLivePolicy } from "./live-policy.js";

const STALE_AT = 0;
const NOW = 60 * 60 * 1_000;
const BOT_ID = "bot-1";

function livePolicy(guildEntries: Record<string, DiscordGuildEntryResolved>): DiscordLivePolicy {
  return {
    isCurrent: () => true,
    isConfigCurrent: () => true,
    accountId: "default",
    cfg: {} as OpenClawConfig,
    discordConfig: {},
    guildEntries,
    // SAFETY: the stale policy reads only the published policy fields set above.
  } as unknown as DiscordLivePolicy;
}

function staleRow(): ChannelIngressQueueRecord<unknown> {
  return {
    id: "m1",
    channelId: "discord",
    accountId: "default",
    queueName: "discord:default",
    payload: {
      version: 1,
      receivedAt: STALE_AT,
      rawMessage: {
        id: "m1",
        channel_id: "c1",
        guild_id: "g1",
        content: "just chatting",
        timestamp: new Date(STALE_AT).toISOString(),
        mention_everyone: false,
        mentions: [],
        attachments: [],
        author: { id: "user-1", username: "alice" },
      },
    },
    receivedAt: STALE_AT,
    updatedAt: STALE_AT,
    laneKey: "channel:c1",
    attempts: 0,
  };
}

/** A real session inventory after READY + GUILD_CREATE: gated c1, unrelated c2, category k1. */
function hydratedInventory() {
  const inventory = new DiscordGatewayChannelInventory();
  const apply = (t: string, d: unknown) =>
    inventory.apply({ op: 0, s: 1, t, d } as Parameters<typeof inventory.apply>[0]);
  apply(GatewayDispatchEvents.Ready, { session_id: "s1", guilds: [{ id: "g1" }] });
  apply(GatewayDispatchEvents.GuildCreate, {
    id: "g1",
    channels: [
      { id: "c1", name: "general", type: ChannelType.GuildText },
      { id: "c2", name: "random", type: ChannelType.GuildText },
      { id: "k1", name: "lounge", type: ChannelType.GuildCategory },
    ],
    threads: [],
  });
  return { inventory, apply };
}

async function verdict(
  inventory: DiscordGatewayChannelInventory,
  guildEntries: Record<string, DiscordGuildEntryResolved>,
) {
  const disposition = createDiscordStaleAmbientPendingDisposition({
    botUserId: BOT_ID,
    client: createInternalTestClient(),
    readPolicy: async () => livePolicy(guildEntries),
    resolveChannelInfo: (channelId) => inventory.get(channelId),
    isChannelInventoryHydrating: (guildId) => inventory.isGuildHydrating(guildId),
  });
  const result = await disposition(staleRow(), { laneKey: "channel:c1", now: NOW });
  expect(result).toMatchObject({ kind: "fail", reason: "stale-ambient-backlog" });
  const guard = (result as { isStillValid?: () => boolean }).isStillValid;
  expect(guard?.()).toBe(true);
  return guard!;
}

// The configured direct-open targets: by name, and by parent category.
const OPEN_BY_NAME = { g1: { channels: { concierge: { requireMention: false } } } };
const OPEN_BY_PARENT = { g1: { channels: { k1: { requireMention: false } } } };

describe("discord stale ambient verdict channel-facts fence", () => {
  it("invalidates the verdict when the gated channel is renamed into a direct-open name", async () => {
    // ClawSweeper rev 22: the rename lands after the verdict, before the fail commit.
    const { inventory, apply } = hydratedInventory();
    const isStillValid = await verdict(inventory, OPEN_BY_NAME);
    apply(GatewayDispatchEvents.ChannelUpdate, {
      id: "c1",
      guild_id: "g1",
      name: "concierge",
      type: ChannelType.GuildText,
    });
    expect(isStillValid()).toBe(false);
  });

  it("invalidates the verdict when the gated channel moves under a direct-open parent", async () => {
    const { inventory, apply } = hydratedInventory();
    const isStillValid = await verdict(inventory, OPEN_BY_PARENT);
    apply(GatewayDispatchEvents.ChannelUpdate, {
      id: "c1",
      guild_id: "g1",
      name: "general",
      parent_id: "k1",
      type: ChannelType.GuildText,
    });
    expect(isStillValid()).toBe(false);
  });

  it("invalidates the verdict on a type change, a delete, or a new session", async () => {
    for (const change of [
      (apply: ReturnType<typeof hydratedInventory>["apply"]) =>
        apply(GatewayDispatchEvents.ChannelUpdate, {
          id: "c1",
          guild_id: "g1",
          name: "general",
          type: ChannelType.GuildForum,
        }),
      (apply: ReturnType<typeof hydratedInventory>["apply"]) =>
        apply(GatewayDispatchEvents.ChannelDelete, { id: "c1", guild_id: "g1", type: 0 }),
      // A fresh READY replaces the session snapshot; the guild is hydrating again.
      (apply: ReturnType<typeof hydratedInventory>["apply"]) =>
        apply(GatewayDispatchEvents.Ready, { session_id: "s2", guilds: [{ id: "g1" }] }),
    ]) {
      const { inventory, apply } = hydratedInventory();
      const isStillValid = await verdict(inventory, OPEN_BY_NAME);
      change(apply);
      expect(isStillValid()).toBe(false);
    }
  });

  it("keeps the verdict when the channel facts it read are unchanged", async () => {
    const { inventory, apply } = hydratedInventory();
    const isStillValid = await verdict(inventory, OPEN_BY_NAME);
    // An unrelated channel is renamed into the direct-open name.
    apply(GatewayDispatchEvents.ChannelUpdate, {
      id: "c2",
      guild_id: "g1",
      name: "concierge",
      type: ChannelType.GuildText,
    });
    // The gated channel itself is updated without changing name, parent or type.
    apply(GatewayDispatchEvents.ChannelUpdate, {
      id: "c1",
      guild_id: "g1",
      name: "general",
      type: ChannelType.GuildText,
      topic: "new topic",
    });
    expect(isStillValid()).toBe(true);
    // A new session that re-delivers identical facts reaches the same verdict.
    apply(GatewayDispatchEvents.Ready, { session_id: "s2", guilds: [{ id: "g1" }] });
    apply(GatewayDispatchEvents.GuildCreate, {
      id: "g1",
      channels: [{ id: "c1", name: "general", type: ChannelType.GuildText }],
      threads: [],
    });
    expect(isStillValid()).toBe(true);
  });
});
