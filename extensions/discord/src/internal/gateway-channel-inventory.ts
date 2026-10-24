// Discord plugin module owns the authoritative gateway channel inventory.
import {
  GatewayDispatchEvents,
  type APIChannel,
  type ChannelType,
  type GatewayChannelDeleteDispatchData,
  type GatewayDispatchPayload,
  type GatewayGuildCreateDispatchData,
  type GatewayGuildDeleteDispatchData,
  type GatewayThreadDeleteDispatchData,
} from "discord-api-types/v10";

export type DiscordGatewayChannelInfo = {
  guildId?: string;
  name?: string;
  parentId?: string;
  /** The enum, not a bare number, so ChannelType comparisons stay type-checked. */
  type: ChannelType;
};

type ChannelLike = Partial<Pick<APIChannel, "id" | "type" | "name">> & {
  guild_id?: unknown;
  parent_id?: unknown;
};

function readChannel(
  value: ChannelLike | undefined,
): (DiscordGatewayChannelInfo & { id: string }) | null {
  if (typeof value?.id !== "string" || typeof value.type !== "number") {
    return null;
  }
  return {
    id: value.id,
    type: value.type,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.parent_id === "string" ? { parentId: value.parent_id } : {}),
    ...(typeof value.guild_id === "string" ? { guildId: value.guild_id } : {}),
  };
}

/** Session-scoped channel/thread inventory from gateway dispatches. A miss means "unknown". */
export class DiscordGatewayChannelInventory {
  private readonly channels = new Map<string, DiscordGatewayChannelInfo>();
  // Guilds READY announced whose GUILD_CREATE snapshot has not arrived yet.
  private readonly hydratingGuildIds = new Set<string>();

  clear(): void {
    this.channels.clear();
    this.hydratingGuildIds.clear();
  }

  get(channelId: string): DiscordGatewayChannelInfo | undefined {
    return this.channels.get(channelId);
  }

  /** True between READY naming the guild and the guild's GUILD_CREATE. */
  isGuildHydrating(guildId: string): boolean {
    return this.hydratingGuildIds.has(guildId);
  }

  apply(payload: GatewayDispatchPayload): void {
    if (payload.t === GatewayDispatchEvents.Ready) {
      // A new authoritative snapshot; RESUMED keeps the old one and replays deltas.
      this.clear();
      for (const guild of payload.d.guilds ?? []) {
        if (typeof guild?.id === "string") {
          this.hydratingGuildIds.add(guild.id);
        }
      }
      return;
    }
    if (payload.t === GatewayDispatchEvents.GuildCreate) {
      const guild: GatewayGuildCreateDispatchData = payload.d;
      this.hydratingGuildIds.delete(guild.id);
      this.deleteGuild(guild.id);
      if ("unavailable" in guild && guild.unavailable) {
        return;
      }
      // A partial snapshot leaves its channels unknown rather than throwing.
      for (const entry of [
        ...(Array.isArray(guild.channels) ? guild.channels : []),
        ...(Array.isArray(guild.threads) ? guild.threads : []),
      ]) {
        const channel = readChannel(entry);
        if (channel) {
          const { id, ...info } = channel;
          this.channels.set(id, { ...info, guildId: guild.id });
        }
      }
      return;
    }
    if (payload.t === GatewayDispatchEvents.GuildDelete) {
      const guild: GatewayGuildDeleteDispatchData = payload.d;
      this.hydratingGuildIds.delete(guild.id);
      this.deleteGuild(guild.id);
      return;
    }
    if (
      payload.t === GatewayDispatchEvents.ChannelCreate ||
      payload.t === GatewayDispatchEvents.ChannelUpdate ||
      payload.t === GatewayDispatchEvents.ThreadCreate ||
      payload.t === GatewayDispatchEvents.ThreadUpdate
    ) {
      const channel = readChannel(payload.d);
      if (channel) {
        const { id, ...info } = channel;
        this.channels.set(id, info);
      }
      return;
    }
    if (
      payload.t === GatewayDispatchEvents.ChannelDelete ||
      payload.t === GatewayDispatchEvents.ThreadDelete
    ) {
      const deleted: GatewayChannelDeleteDispatchData | GatewayThreadDeleteDispatchData = payload.d;
      this.channels.delete(deleted.id);
    }
  }

  private deleteGuild(guildId: string): void {
    for (const [channelId, channel] of this.channels) {
      if (channel.guildId === guildId) {
        this.channels.delete(channelId);
      }
    }
  }
}
