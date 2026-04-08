import type { RequestClient } from "@buape/carbon";
import type { APIChannel, APIGuild, APIGuildMember, APIRole } from "discord-api-types/v10";
import { ChannelType, PermissionFlagsBits, Routes } from "discord-api-types/v10";
import { createDiscordRestClient, resolveDiscordRest } from "./client.js";
import type { DiscordPermissionsSummary, DiscordReactOpts } from "./send.types.js";

const PERMISSION_ENTRIES = Object.entries(PermissionFlagsBits).filter(
  ([, value]) => typeof value === "bigint",
);
const ALL_PERMISSIONS = PERMISSION_ENTRIES.reduce((acc, [, value]) => acc | value, 0n);
const ADMINISTRATOR_BIT = PermissionFlagsBits.Administrator;
const DISCORD_PERMISSION_CACHE_TTL_MS = 30_000;

type DiscordGuildPermissionContext = {
  botId: string;
  member: APIGuildMember;
  rolesById: Map<string, APIRole>;
};

type DiscordTimedCacheEntry<T> = {
  expiresAt: number;
  value?: T;
  promise?: Promise<T>;
};

const discordBotIdCache = new Map<string, DiscordTimedCacheEntry<string>>();
const discordGuildPermissionContextCache = new Map<
  string,
  DiscordTimedCacheEntry<DiscordGuildPermissionContext>
>();

function addPermissionBits(base: bigint, add?: string) {
  if (!add) {
    return base;
  }
  return base | BigInt(add);
}

function removePermissionBits(base: bigint, deny?: string) {
  if (!deny) {
    return base;
  }
  return base & ~BigInt(deny);
}

function bitfieldToPermissions(bitfield: bigint) {
  return PERMISSION_ENTRIES.filter(([, value]) => (bitfield & value) === value)
    .map(([name]) => name)
    .toSorted();
}

function hasAdministrator(bitfield: bigint) {
  return (bitfield & ADMINISTRATOR_BIT) === ADMINISTRATOR_BIT;
}

function hasPermissionBit(bitfield: bigint, permission: bigint) {
  return (bitfield & permission) === permission;
}

export function isThreadChannelType(channelType?: number) {
  return (
    channelType === ChannelType.GuildNewsThread ||
    channelType === ChannelType.GuildPublicThread ||
    channelType === ChannelType.GuildPrivateThread
  );
}

async function fetchBotUserId(rest: RequestClient) {
  const me = (await rest.get(Routes.user("@me"))) as { id?: string };
  if (!me?.id) {
    throw new Error("Failed to resolve bot user id");
  }
  return me.id;
}

function getDiscordGuildPermissionCacheKey(token: string, guildId: string) {
  return `${token}\u0000${guildId}`;
}

async function getOrLoadDiscordTimedCacheEntry<T>(
  cache: Map<string, DiscordTimedCacheEntry<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    if (cached.value !== undefined) {
      return cached.value;
    }
    if (cached.promise) {
      return await cached.promise;
    }
  }

  const promise = load()
    .then((value) => {
      cache.set(key, {
        expiresAt: Date.now() + DISCORD_PERMISSION_CACHE_TTL_MS,
        value,
      });
      return value;
    })
    .catch((err) => {
      if (cache.get(key)?.promise === promise) {
        cache.delete(key);
      }
      throw err;
    });

  cache.set(key, {
    expiresAt: now + DISCORD_PERMISSION_CACHE_TTL_MS,
    promise,
  });
  return await promise;
}

async function fetchDiscordGuildPermissionContext(
  rest: RequestClient,
  token: string,
  guildId: string,
): Promise<DiscordGuildPermissionContext> {
  return await getOrLoadDiscordTimedCacheEntry(
    discordGuildPermissionContextCache,
    getDiscordGuildPermissionCacheKey(token, guildId),
    async () => {
      const botId = await getOrLoadDiscordTimedCacheEntry(
        discordBotIdCache,
        token,
        async () => await fetchBotUserId(rest),
      );
      const [guild, member] = await Promise.all([
        rest.get(Routes.guild(guildId)) as Promise<APIGuild>,
        rest.get(Routes.guildMember(guildId, botId)) as Promise<APIGuildMember>,
      ]);
      return {
        botId,
        member,
        rolesById: new Map<string, APIRole>((guild.roles ?? []).map((role) => [role.id, role])),
      };
    },
  );
}

export function __resetDiscordPermissionCacheForTest() {
  discordBotIdCache.clear();
  discordGuildPermissionContextCache.clear();
}

/**
 * Fetch guild-level permissions for a user. This does not include channel-specific overwrites.
 */
export async function fetchMemberGuildPermissionsDiscord(
  guildId: string,
  userId: string,
  opts: DiscordReactOpts = {},
): Promise<bigint | null> {
  const rest = resolveDiscordRest(opts);
  try {
    const [guild, member] = await Promise.all([
      rest.get(Routes.guild(guildId)) as Promise<APIGuild>,
      rest.get(Routes.guildMember(guildId, userId)) as Promise<APIGuildMember>,
    ]);
    const rolesById = new Map<string, APIRole>((guild.roles ?? []).map((role) => [role.id, role]));
    const everyoneRole = rolesById.get(guildId);
    let permissions = 0n;
    if (everyoneRole?.permissions) {
      permissions = addPermissionBits(permissions, everyoneRole.permissions);
    }
    for (const roleId of member.roles ?? []) {
      const role = rolesById.get(roleId);
      if (role?.permissions) {
        permissions = addPermissionBits(permissions, role.permissions);
      }
    }
    return permissions;
  } catch {
    // Not a guild member, guild not found, or API failure.
    return null;
  }
}

/**
 * Returns true when the user has ADMINISTRATOR or required permission bits
 * matching the provided predicate.
 */
async function hasGuildPermissionsDiscord(
  guildId: string,
  userId: string,
  requiredPermissions: bigint[],
  check: (permissions: bigint, requiredPermissions: bigint[]) => boolean,
  opts: DiscordReactOpts = {},
): Promise<boolean> {
  const permissions = await fetchMemberGuildPermissionsDiscord(guildId, userId, opts);
  if (permissions === null) {
    return false;
  }
  if (hasAdministrator(permissions)) {
    return true;
  }
  return check(permissions, requiredPermissions);
}

/**
 * Returns true when the user has ADMINISTRATOR or any required permission bit.
 */
export async function hasAnyGuildPermissionDiscord(
  guildId: string,
  userId: string,
  requiredPermissions: bigint[],
  opts: DiscordReactOpts = {},
): Promise<boolean> {
  return await hasGuildPermissionsDiscord(
    guildId,
    userId,
    requiredPermissions,
    (permissions, required) =>
      required.some((permission) => hasPermissionBit(permissions, permission)),
    opts,
  );
}

/**
 * Returns true when the user has ADMINISTRATOR or all required permission bits.
 */
export async function hasAllGuildPermissionsDiscord(
  guildId: string,
  userId: string,
  requiredPermissions: bigint[],
  opts: DiscordReactOpts = {},
): Promise<boolean> {
  return await hasGuildPermissionsDiscord(
    guildId,
    userId,
    requiredPermissions,
    (permissions, required) =>
      required.every((permission) => hasPermissionBit(permissions, permission)),
    opts,
  );
}

/**
 * @deprecated Prefer hasAnyGuildPermissionDiscord or hasAllGuildPermissionsDiscord for clarity.
 */
export const hasGuildPermissionDiscord = hasAnyGuildPermissionDiscord;

export async function fetchChannelPermissionsDiscord(
  channelId: string,
  opts: DiscordReactOpts = {},
): Promise<DiscordPermissionsSummary> {
  const { rest, token } = createDiscordRestClient(opts, opts.cfg);
  const channel = (await rest.get(Routes.channel(channelId))) as APIChannel;
  const channelType = "type" in channel ? channel.type : undefined;
  const guildId = "guild_id" in channel ? channel.guild_id : undefined;
  if (!guildId) {
    return {
      channelId,
      permissions: [],
      raw: "0",
      isDm: true,
      channelType,
    };
  }

  const { botId, member, rolesById } = await fetchDiscordGuildPermissionContext(
    rest,
    token,
    guildId,
  );
  const everyoneRole = rolesById.get(guildId);
  let base = 0n;
  if (everyoneRole?.permissions) {
    base = addPermissionBits(base, everyoneRole.permissions);
  }
  for (const roleId of member.roles ?? []) {
    const role = rolesById.get(roleId);
    if (role?.permissions) {
      base = addPermissionBits(base, role.permissions);
    }
  }

  if (hasAdministrator(base)) {
    return {
      channelId,
      guildId,
      permissions: bitfieldToPermissions(ALL_PERMISSIONS),
      raw: ALL_PERMISSIONS.toString(),
      isDm: false,
      channelType,
    };
  }

  let permissions = base;
  const overwrites =
    "permission_overwrites" in channel ? (channel.permission_overwrites ?? []) : [];
  for (const overwrite of overwrites) {
    if (overwrite.id === guildId) {
      permissions = removePermissionBits(permissions, overwrite.deny ?? "0");
      permissions = addPermissionBits(permissions, overwrite.allow ?? "0");
    }
  }
  for (const overwrite of overwrites) {
    if (member.roles?.includes(overwrite.id)) {
      permissions = removePermissionBits(permissions, overwrite.deny ?? "0");
      permissions = addPermissionBits(permissions, overwrite.allow ?? "0");
    }
  }
  for (const overwrite of overwrites) {
    if (overwrite.id === botId) {
      permissions = removePermissionBits(permissions, overwrite.deny ?? "0");
      permissions = addPermissionBits(permissions, overwrite.allow ?? "0");
    }
  }

  return {
    channelId,
    guildId,
    permissions: bitfieldToPermissions(permissions),
    raw: permissions.toString(),
    isDm: false,
    channelType,
  };
}
