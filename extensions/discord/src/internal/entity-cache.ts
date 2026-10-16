import { GatewayDispatchEvents } from "discord-api-types/v10";
import { getGuild, getGuildMember } from "./api.guild.js";
import { getChannel } from "./api.messages.js";
import { getUser } from "./api.users.js";
import { Guild, GuildMember, User, channelFactory, type StructureClient } from "./structures.js";

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const DEFAULT_REST_CACHE_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

const INVALIDATION_KIND_BY_EVENT = new Map<
  string,
  "channel" | "guild" | "guild-emojis" | "member" | "session" | "guild-members" | "removed-guild"
>([
  [GatewayDispatchEvents.ChannelUpdate, "channel"],
  [GatewayDispatchEvents.ChannelDelete, "channel"],
  [GatewayDispatchEvents.ThreadUpdate, "channel"],
  [GatewayDispatchEvents.ThreadDelete, "channel"],
  [GatewayDispatchEvents.GuildUpdate, "guild"],
  [GatewayDispatchEvents.GuildEmojisUpdate, "guild-emojis"],
  [GatewayDispatchEvents.GuildMemberAdd, "member"],
  [GatewayDispatchEvents.GuildMemberRemove, "member"],
  [GatewayDispatchEvents.GuildMemberUpdate, "member"],
  [GatewayDispatchEvents.Ready, "session"],
  [GatewayDispatchEvents.Resumed, "session"],
  [GatewayDispatchEvents.GuildDelete, "removed-guild"],
  [GatewayDispatchEvents.GuildRoleUpdate, "guild-members"],
  [GatewayDispatchEvents.GuildRoleDelete, "guild-members"],
]);

export class DiscordEntityCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private lastSweepAt = 0;
  private readonly memberAuthorities = new Set<{ guildId: string; userIds: Set<string> }>();

  constructor(private readonly client: StructureClient) {}

  get size(): number {
    return this.entries.size;
  }

  async fetchUser(id: string): Promise<User> {
    return await this.fetchCached(`user:${id}`, async () => {
      const raw = await getUser(this.client.rest, id);
      return new User(this.client, raw);
    });
  }

  async fetchChannel(id: string) {
    return await this.fetchCached(`channel:${id}`, async () => {
      const raw = await getChannel(this.client.rest, id);
      return channelFactory(this.client, raw);
    });
  }

  async fetchGuild(id: string): Promise<Guild> {
    return await this.fetchCached(`guild:${id}`, async () => {
      const raw = await getGuild(this.client.rest, id);
      return new Guild(this.client, raw);
    });
  }

  async fetchMember(guildId: string, userId: string): Promise<GuildMember> {
    return await this.fetchCached(`member:${guildId}:${userId}`, async () => {
      const raw = await getGuildMember(this.client.rest, guildId, userId);
      return new GuildMember(this.client, raw);
    });
  }

  async fetchGuildEmojis<T>(guildId: string, fetcher: () => Promise<T>): Promise<T> {
    return await this.fetchCached(`guild-emojis:${guildId}`, fetcher);
  }

  /** Retain fresh REST membership facts only while their native event authority is live. */
  retainMemberAuthority(guildId: string, userIds: string[]) {
    const authority = { guildId, userIds: new Set(userIds) };
    this.memberAuthorities.add(authority);
    return {
      assertCurrent: () => {
        if (!this.memberAuthorities.has(authority)) {
          throw new Error("Discord member authority is no longer current");
        }
      },
      dispose: () => {
        this.memberAuthorities.delete(authority);
      },
    };
  }

  invalidateForGatewayEvent(type: string, data: unknown): void {
    const kind = INVALIDATION_KIND_BY_EVENT.get(type);
    if (!kind) {
      return;
    }
    if (kind === "session") {
      this.memberAuthorities.clear();
      return;
    }
    const raw = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const user = raw.user && typeof raw.user === "object" ? (raw.user as { id?: unknown }) : {};
    if (kind === "member" || kind === "removed-guild" || kind === "guild-members") {
      const guildId = kind === "removed-guild" ? raw.id : raw.guild_id;
      for (const authority of this.memberAuthorities) {
        if (
          authority.guildId === guildId &&
          (kind !== "member" || (typeof user.id === "string" && authority.userIds.has(user.id)))
        ) {
          this.memberAuthorities.delete(authority);
        }
      }
    }
    if (kind === "guild-members" || kind === "removed-guild") {
      return;
    }
    if (kind === "member") {
      const guildId = raw.guild_id;
      if (typeof guildId === "string" && typeof user.id === "string") {
        this.entries.delete(`member:${guildId}:${user.id}`);
        this.entries.delete(`user:${user.id}`);
      }
    } else {
      const id = kind === "guild-emojis" ? raw.guild_id : raw.id;
      if (typeof id === "string") {
        this.entries.delete(`${kind}:${id}`);
      }
    }
  }

  private async fetchCached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const cached = this.entries.get(key) as CacheEntry<T> | undefined;
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    if (cached) {
      this.entries.delete(key);
    }
    const value = await fetcher();
    this.maybeSweepExpired(now);
    this.entries.set(key, { expiresAt: now + DEFAULT_REST_CACHE_TTL_MS, value });
    if (this.entries.size > DEFAULT_MAX_ENTRIES) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    return value;
  }

  private maybeSweepExpired(now: number): void {
    if (now - this.lastSweepAt < DEFAULT_SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweepAt = now;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}
