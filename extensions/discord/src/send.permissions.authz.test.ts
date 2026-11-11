import { ChannelType, PermissionFlagsBits as P, Routes } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./send.permissions.js";
import { EMPTY_DISCORD_TEST_OPTS as opts } from "./test-support/config.js";

const mockRest = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./client.js", () => ({ resolveDiscordRest: () => mockRest }));
const subject = ["guild-1", "user-1"] as const;
type Role = [id: string, permissions: bigint, position?: number];
type Fixture = {
  owner?: string;
  roles?: Role[];
  everyone?: bigint;
  member?: bigint;
  memberRoles?: string[];
  target?: string;
  targetRoles?: string[];
  channel?: {
    type?: ChannelType;
    parent_id?: string;
    permission_overwrites?: ReturnType<typeof deny>;
  };
  parentOverwrites?: ReturnType<typeof deny>;
};
const deny = (permission: bigint) => [{ id: "user-1", type: 1, deny: permission.toString() }];
const roleHierarchy = (
  senderPosition: number,
  targetPosition: number,
  targetPermissions = 0n,
): Role[] => [
  ["guild-1", 0n, 0],
  ["role-mod", P.ManageRoles, senderPosition],
  ["role-target", targetPermissions, targetPosition],
];

function mockGuild({
  owner = "owner-1",
  everyone = 0n,
  member,
  roles = member === undefined
    ? [["guild-1", everyone]]
    : [
        ["guild-1", everyone],
        ["role-mod", member],
      ],
  memberRoles = member === undefined ? [] : ["role-mod"],
  target,
  targetRoles = [],
  channel = {},
  parentOverwrites,
}: Fixture = {}) {
  const routes: Record<string, unknown> = {
    [Routes.guild("guild-1")]: {
      id: "guild-1",
      owner_id: owner,
      roles: roles.map(([id, bits, position = 0]) => ({
        id,
        permissions: bits.toString(),
        position,
      })),
    },
    [Routes.guildMember(...subject)]: { id: "user-1", roles: memberRoles },
    [Routes.channel("channel-1")]: { id: "channel-1", type: 0, guild_id: "guild-1", ...channel },
  };
  if (target) {
    routes[Routes.guildMember("guild-1", target)] = { id: target, roles: targetRoles };
  }
  if (channel.parent_id) {
    routes[Routes.channel(channel.parent_id)] = {
      id: channel.parent_id,
      type: 0,
      guild_id: "guild-1",
      permission_overwrites: parentOverwrites,
    };
  }
  mockRest.get.mockImplementation(async (route: string) => {
    if (!Object.hasOwn(routes, route)) {
      throw new Error(`Unexpected route: ${route}`);
    }
    return routes[route];
  });
}

describe("discord guild permission authorization", () => {
  beforeEach(() => void mockRest.get.mockReset());

  it("rejects managing a role above the sender", async () => {
    mockGuild({ roles: roleHierarchy(5, 10), memberRoles: ["role-mod"] });
    expect(await api.canManageGuildRoleDiscord(...subject, "role-target", opts)).toBe(false);
  });

  it.each<[string, Fixture, boolean, boolean?]>([
    ["allows higher sender", { roles: roleHierarchy(10, 4), targetRoles: ["role-target"] }, true],
    ["rejects lower sender", { roles: roleHierarchy(5, 10) }, false],
    ["rejects target owner", { roles: roleHierarchy(10, 4), target: "owner-1" }, false],
    ["enforces permission ceiling", { roles: roleHierarchy(10, 4, P.BanMembers) }, false, true],
  ])("%s", async (_name, fixture, allowed, ceiling = false) => {
    const target = fixture.target ?? "target-1";
    mockGuild({ memberRoles: ["role-mod"], target, ...fixture });
    expect(
      await api.canManageGuildMemberRoleDiscord(
        ...subject,
        target,
        "role-target",
        opts,
        ceiling ? { assignablePermissionCeiling: true } : undefined,
      ),
    ).toBe(allowed);
  });

  it("returns null when the guild member lookup fails", async () => {
    mockRest.get.mockRejectedValueOnce(new Error("404 Member not found"));
    expect(await api.fetchMemberGuildPermissionsDiscord(...subject, opts)).toBeNull();
  });

  it.each<[string, Fixture, bigint[], boolean]>([
    ["authorizes the guild owner without role bits", { owner: "user-1" }, [P.ManageChannels], true],
    ["authorizes a matching permission", { member: P.KickMembers }, [P.KickMembers], true],
    ["authorizes an administrator", { member: P.Administrator }, [P.KickMembers], true],
    ["denies missing bits", { everyone: P.ViewChannel }, [P.BanMembers, P.KickMembers], false],
  ])("hasAnyGuildPermissionDiscord %s", async (_name, fixture, required, allowed) => {
    mockGuild(fixture);
    expect(await api.hasAnyGuildPermissionDiscord(...subject, required, opts)).toBe(allowed);
  });

  it("hasAllGuildPermissionsDiscord rejects a member with only one required permission", async () => {
    mockGuild({ member: P.KickMembers });
    expect(
      await api.hasAllGuildPermissionsDiscord(...subject, [P.KickMembers, P.BanMembers], opts),
    ).toBe(false);
  });

  it.each<[string, Fixture, bigint, boolean]>([
    [
      "authorizes the owner despite a channel deny",
      { owner: "user-1", channel: { permission_overwrites: deny(P.ManageChannels) } },
      P.ManageChannels,
      true,
    ],
    [
      "applies parent overwrites for a thread",
      {
        everyone: P.ManageThreads,
        channel: { type: ChannelType.GuildPublicThread, parent_id: "parent-1" },
        parentOverwrites: deny(P.ManageThreads),
      },
      P.ManageThreads,
      false,
    ],
  ])("hasAnyChannelPermissionDiscord %s", async (_name, fixture, required, allowed) => {
    mockGuild(fixture);
    expect(
      await api.hasAnyChannelPermissionDiscord("guild-1", "channel-1", "user-1", [required], opts),
    ).toBe(allowed);
  });
});
