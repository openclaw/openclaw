import { ChannelType, PermissionFlagsBits, Routes } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as discordRest from "../internal/rest.js";
import { createDiscordLoopbackRest } from "../send.test-harness.js";
import { handleDiscordMessageAction } from "./handle-action.js";

const cfg = { channels: { discord: { token: "token", groupPolicy: "open" } } } as OpenClawConfig;
const { ViewChannel, SendMessages, SendMessagesInThreads } = PermissionFlagsBits;

const defaultScenario = {
  denyView: false,
  guildPermissions: ViewChannel | SendMessages,
  locked: false,
  privateMember: true,
  type: ChannelType.GuildPublicThread as
    | ChannelType.GuildPrivateThread
    | ChannelType.GuildPublicThread,
};
const scenario = { ...defaultScenario };

let loopback: Awaited<ReturnType<typeof createDiscordLoopbackRest>>;

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
  return loopback.requests.filter((request) => request.method === "PATCH");
}

beforeAll(async () => {
  loopback = await createDiscordLoopbackRest({
    queueRequests: true,
    respond: (request) => {
      const isGet = request.method === "GET";
      if (isGet && request.path?.endsWith(Routes.channel("P1"))) {
        return {
          id: "P1",
          type: ChannelType.GuildText,
          guild_id: "G1",
          permission_overwrites: scenario.denyView
            ? [{ id: "sender-1", type: 1, deny: ViewChannel.toString() }]
            : [],
        };
      }
      if (isGet && request.path?.endsWith(Routes.guild("G1"))) {
        return {
          id: "G1",
          owner_id: "owner-1",
          roles: [{ id: "G1", permissions: scenario.guildPermissions.toString() }],
        };
      }
      if (isGet && request.path?.endsWith(Routes.guildMember("G1", "sender-1"))) {
        return { user: { id: "sender-1" }, roles: [] };
      }
      return {
        id: "T1",
        type: scenario.type,
        guild_id: "G1",
        parent_id: "P1",
        thread_metadata: { archived: true, locked: scenario.locked },
      };
    },
    status: (request) =>
      request.method === "GET" &&
      request.path?.endsWith(Routes.threadMembers("T1", "sender-1")) &&
      !scenario.privateMember
        ? 404
        : 200,
  });
  vi.spyOn(discordRest, "RequestClient").mockImplementation(function () {
    return loopback.rest;
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await loopback.close();
});

beforeEach(() => {
  loopback.requests.length = 0;
  Object.assign(scenario, defaultScenario);
});

describe("registered Discord channel-edit thread permissions", () => {
  it("reopens an accessible unlocked thread through the Discord PATCH owner", async () => {
    await expect(runReopen()).resolves.toMatchObject({ details: { ok: true } });

    expect(patchRequests()).toHaveLength(1);
    expect(JSON.parse(patchRequests()[0]?.body ?? "{}")).toEqual({ archived: false });
  });

  it.each([
    ["SendMessagesInThreads alone", { guildPermissions: ViewChannel | SendMessagesInThreads }, {}],
    [
      "private-thread nonmember",
      { type: ChannelType.GuildPrivateThread, privateMember: false },
      {},
    ],
    ["revoked target visibility", { denyView: true }, {}],
    ["explicit parent clear without ManageThreads", {}, { clearParent: true }],
    ["locked thread without ManageThreads", { locked: true }, {}],
  ] as const)("rejects %s before PATCH", async (_name, overrides, params) => {
    Object.assign(scenario, overrides);
    await expect(runReopen(params)).rejects.toThrow(/required permissions/);
    expect(patchRequests()).toHaveLength(0);
  });
});
