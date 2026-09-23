import { ChannelType, PermissionFlagsBits, Routes } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as discordRequestClient from "../proxy-request-client.js";
import { createDiscordLoopbackRest } from "../send.test-harness.js";
import { handleDiscordMessageAction } from "./handle-action.js";

const cfg = {
  channels: { discord: { token: "token", groupPolicy: "open" } },
} as OpenClawConfig;

const scenario = {
  denyView: false,
  guildPermissions: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages,
  locked: false,
  privateMember: true,
  type: ChannelType.GuildPublicThread as
    | ChannelType.GuildPrivateThread
    | ChannelType.GuildPublicThread,
};

let closeLoopback = async () => {};
let requests: Awaited<ReturnType<typeof createDiscordLoopbackRest>>["requests"] = [];

function isRoute(path: string | undefined, route: string) {
  return path?.endsWith(route) === true;
}

function threadResponse() {
  return {
    id: "T1",
    type: scenario.type,
    name: "archived-thread",
    guild_id: "G1",
    parent_id: "P1",
    thread_metadata: {
      archived: true,
      auto_archive_duration: 1440,
      archive_timestamp: "2026-09-16T00:00:00.000Z",
      locked: scenario.locked,
    },
  };
}

function runReopen(params: Record<string, unknown> = {}) {
  return handleDiscordMessageAction({
    action: "channel-edit",
    params: { channelId: "T1", archived: false, ...params },
    cfg,
    requesterSenderId: "sender-1",
    toolContext: { currentChannelProvider: "discord" },
  });
}

function patchRequests() {
  return requests.filter((request) => request.method === "PATCH");
}

beforeAll(async () => {
  const loopback = await createDiscordLoopbackRest({
    queueRequests: true,
    respond: (request) => {
      if (request.method === "GET" && isRoute(request.path, Routes.channel("T1"))) {
        return threadResponse();
      }
      if (request.method === "GET" && isRoute(request.path, Routes.channel("P1"))) {
        return {
          id: "P1",
          type: ChannelType.GuildText,
          guild_id: "G1",
          permission_overwrites: scenario.denyView
            ? [{ id: "sender-1", type: 1, deny: PermissionFlagsBits.ViewChannel.toString() }]
            : [],
        };
      }
      if (request.method === "GET" && isRoute(request.path, Routes.guild("G1"))) {
        return {
          id: "G1",
          owner_id: "owner-1",
          roles: [{ id: "G1", permissions: scenario.guildPermissions.toString() }],
        };
      }
      if (request.method === "GET" && isRoute(request.path, Routes.guildMember("G1", "sender-1"))) {
        return { user: { id: "sender-1" }, roles: [] };
      }
      return threadResponse();
    },
    status: (request) =>
      request.method === "GET" &&
      isRoute(request.path, Routes.threadMembers("T1", "sender-1")) &&
      !scenario.privateMember
        ? 404
        : 200,
  });
  requests = loopback.requests;
  closeLoopback = loopback.close;
  vi.spyOn(discordRequestClient, "createDiscordRequestClient").mockReturnValue(loopback.rest);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await closeLoopback();
});

beforeEach(() => {
  requests.length = 0;
  scenario.denyView = false;
  scenario.guildPermissions = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages;
  scenario.locked = false;
  scenario.privateMember = true;
  scenario.type = ChannelType.GuildPublicThread;
});

describe("registered Discord channel-edit thread permissions", () => {
  it("reopens an accessible unlocked thread through the Discord PATCH owner", async () => {
    await expect(runReopen()).resolves.toMatchObject({ details: { ok: true } });

    expect(patchRequests()).toHaveLength(1);
    expect(JSON.parse(patchRequests()[0]?.body ?? "{}")).toEqual({ archived: false });
  });

  it("does not treat SendMessagesInThreads as reopen permission", async () => {
    scenario.guildPermissions =
      PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessagesInThreads;

    await expect(runReopen()).rejects.toThrow(/required permissions/);
    expect(patchRequests()).toHaveLength(0);
  });

  it("rejects a private-thread nonmember before the Discord PATCH", async () => {
    scenario.type = ChannelType.GuildPrivateThread;
    scenario.privateMember = false;

    await expect(runReopen()).rejects.toThrow(/required permissions/);
    expect(patchRequests()).toHaveLength(0);
  });

  it("rejects revoked target visibility before the Discord PATCH", async () => {
    scenario.denyView = true;

    await expect(runReopen()).rejects.toThrow(/required permissions/);
    expect(patchRequests()).toHaveLength(0);
  });

  it.each([
    ["an explicit unlock", { locked: false }],
    ["an explicit flag edit", { nsfw: false }],
    ["an explicit parent clear", { clearParent: true }],
    ["a forum tag edit", { availableTags: [{ name: "status" }] }],
  ])("keeps ManageThreads required for %s during reopen", async (_label, params) => {
    await expect(runReopen(params)).rejects.toThrow(/required permissions/);
    expect(patchRequests()).toHaveLength(0);
  });

  it("keeps ManageThreads required to reopen a locked thread", async () => {
    scenario.locked = true;

    await expect(runReopen()).rejects.toThrow(/required permissions/);
    expect(patchRequests()).toHaveLength(0);
  });
});
