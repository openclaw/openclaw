import { ChannelType, PermissionFlagsBits as P, Routes } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./send.permissions.js";
import { EMPTY_DISCORD_TEST_OPTS as opts } from "./test-support/config.js";

const mockRest = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./client.js", () => ({ resolveDiscordRest: () => mockRest }));
type Role = [id: string, permissions: bigint, position?: number];
type Fixture = {
  owner?: string;
  roles?: Role[];
  everyone?: bigint;
  member?: bigint;
  memberRoles?: string[];
  target?: string;
  targetRoles?: string[];
  channel?: Partial<{
    guild_id: string;
    type: ChannelType;
    parent_id: string;
    permission_overwrites: ReturnType<typeof deny>;
  }>;
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
  const routes = new Map<string, unknown>([
    [
      Routes.guild("guild-1"),
      {
        id: "guild-1",
        owner_id: owner,
        roles: roles.map(([id, bits, position = 0]) => ({
          id,
          permissions: bits.toString(),
          position,
        })),
      },
    ],
    [Routes.guildMember("guild-1", "user-1"), { id: "user-1", roles: memberRoles }],
    [Routes.channel("channel-1"), { id: "channel-1", type: 0, guild_id: "guild-1", ...channel }],
  ]);
  if (target) {
    routes.set(Routes.guildMember("guild-1", target), { id: target, roles: targetRoles });
  }
  if (channel.parent_id) {
    routes.set(Routes.channel(channel.parent_id), {
      id: channel.parent_id,
      type: 0,
      guild_id: "guild-1",
      permission_overwrites: parentOverwrites,
    });
  }
  mockRest.get.mockImplementation(async (route: string) => {
    if (!routes.has(route)) {
      throw new Error(`Unexpected route: ${route}`);
    }
    return routes.get(route);
  });
}

describe("discord guild permission authorization", () => {
  beforeEach(() => {
    mockRest.get.mockReset();
  });

  it("rejects managing a role above the sender", async () => {
    mockGuild({ roles: roleHierarchy(5, 10), memberRoles: ["role-mod"] });
    expect(await api.canManageGuildRoleDiscord("guild-1", "user-1", "role-target", opts)).toBe(
      false,
    );
  });

  it.each<[string, Fixture, string, boolean, boolean]>([
    [
      "allows a sender above the changed role and target member",
      { roles: roleHierarchy(10, 4), targetRoles: ["role-target"] },
      "role-target",
      false,
      true,
    ],
    [
      "rejects a sender below the changed role",
      { roles: roleHierarchy(5, 10) },
      "role-target",
      false,
      false,
    ],
    [
      "rejects changing the guild owner",
      {
        roles: [
          ["guild-1", 0n],
          ["role-mod", P.ManageRoles, 10],
        ],
        target: "owner-1",
      },
      "role-mod",
      false,
      false,
    ],
    [
      "rejects assigning permission bits the sender lacks",
      { roles: roleHierarchy(10, 4, P.BanMembers) },
      "role-target",
      true,
      false,
    ],
  ])("%s", async (_name, fixture, role, ceiling, allowed) => {
    const target = fixture.target ?? "target-1";
    mockGuild({ memberRoles: ["role-mod"], target, ...fixture });
    expect(
      await api.canManageGuildMemberRoleDiscord(
        "guild-1",
        "user-1",
        target,
        role,
        opts,
        ceiling ? { assignablePermissionCeiling: true } : undefined,
      ),
    ).toBe(allowed);
  });

  it("returns null when the guild member lookup fails", async () => {
    mockRest.get.mockRejectedValueOnce(new Error("404 Member not found"));
    expect(await api.fetchMemberGuildPermissionsDiscord("guild-1", "user-1", opts)).toBeNull();
  });

  it("combines everyone and member-role permissions", async () => {
    mockGuild({ everyone: P.ViewChannel, member: P.KickMembers });
    expect(await api.fetchMemberGuildPermissionsDiscord("guild-1", "user-1", opts)).toBe(
      P.ViewChannel | P.KickMembers,
    );
  });

  it.each<[string, Fixture, bigint[], boolean]>([
    ["authorizes the guild owner without role bits", { owner: "user-1" }, [P.ManageChannels], true],
    ["authorizes a matching permission", { member: P.KickMembers }, [P.KickMembers], true],
    ["authorizes an administrator", { member: P.Administrator }, [P.KickMembers], true],
    [
      "rejects when no required permission matches",
      { everyone: P.ViewChannel },
      [P.BanMembers, P.KickMembers],
      false,
    ],
  ])("hasAnyGuildPermissionDiscord %s", async (_name, fixture, required, allowed) => {
    mockGuild(fixture);
    expect(await api.hasAnyGuildPermissionDiscord("guild-1", "user-1", required, opts)).toBe(
      allowed,
    );
  });

  it.each<[string, bigint, boolean]>([
    ["rejects a member with only one required permission", P.KickMembers, false],
    ["authorizes an administrator", P.Administrator, true],
  ])("hasAllGuildPermissionsDiscord %s", async (_name, bits, allowed) => {
    mockGuild({ member: bits });
    expect(
      await api.hasAllGuildPermissionsDiscord(
        "guild-1",
        "user-1",
        [P.KickMembers, P.BanMembers],
        opts,
      ),
    ).toBe(allowed);
  });

  it.each<[string, Fixture, bigint, boolean]>([
    [
      "authorizes the owner despite a channel deny",
      { owner: "user-1", channel: { permission_overwrites: deny(P.ManageChannels) } },
      P.ManageChannels,
      true,
    ],
    [
      "applies channel overwrites",
      {
        everyone: P.ManageChannels,
        channel: { permission_overwrites: deny(P.ManageChannels) },
      },
      P.ManageChannels,
      false,
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
    [
      "rejects a channel from another guild",
      { everyone: P.ManageChannels, channel: { guild_id: "guild-2" } },
      P.ManageChannels,
      false,
    ],
  ])("hasAnyChannelPermissionDiscord %s", async (_name, fixture, required, allowed) => {
    mockGuild(fixture);
    expect(
      await api.hasAnyChannelPermissionDiscord("guild-1", "channel-1", "user-1", [required], opts),
    ).toBe(allowed);
  });
});
