import { ChannelType } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayPlugin } from "../internal/gateway.js";
import * as discordRest from "../internal/rest.js";
import { clearGateways, registerGateway } from "../monitor/gateway-registry.js";
import { createDiscordLoopbackRest } from "../send.test-harness.js";
import { handleDiscordMessageAction } from "./handle-action.js";
import { handleDiscordAction } from "./runtime.js";

type DiscordActionContext = Parameters<typeof handleDiscordMessageAction>[0];

const cfg: OpenClawConfig = {
  channels: {
    discord: {
      defaultAccount: "work",
      accounts: { work: { token: "test-token", groupPolicy: "allowlist" } },
    },
  },
};
const currentDmContext = {
  currentChannelProvider: "discord",
  currentChannelId: "111",
  currentChatType: "direct",
  currentMessagingTarget: "user:222",
} satisfies DiscordActionContext["toolContext"];

function dmContext(overrides: Partial<NonNullable<DiscordActionContext["toolContext"]>>) {
  return { toolContext: { ...currentDmContext, ...overrides } };
}

function readReactions(overrides: Partial<DiscordActionContext> = {}) {
  return handleDiscordMessageAction({
    action: "reactions",
    params: { to: "user:222", messageId: "444" },
    cfg,
    accountId: "work",
    requesterAccountId: "work",
    conversationReadOrigin: "delegated",
    toolContext: currentDmContext,
    ...overrides,
  });
}

describe("Discord reaction read target resolution", () => {
  let loopback: Awaited<ReturnType<typeof createDiscordLoopbackRest>>;

  beforeEach(async () => {
    loopback = await createDiscordLoopbackRest({
      respond: ({ method, path, body }) => {
        if (method === "POST" && path === "/v10/users/@me/channels") {
          const recipient = JSON.parse(body) as { recipient_id: string };
          return { id: recipient.recipient_id === "222" ? "111" : "333" };
        }
        if (path === "/v10/channels/111" || path === "/v10/channels/333") {
          return { id: path.split("/")[3], type: ChannelType.DM };
        }
        return { id: "444", reactions: [] };
      },
    });
    vi.spyOn(discordRest, "RequestClient").mockImplementation(function () {
      return loopback.rest;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await loopback.close();
  });

  it("reads reactions for the current DM user mention without creating it", async () => {
    const result = await readReactions({ params: { to: "<@222>", messageId: "444" } });

    expect(result.details).toEqual({ ok: true, reactions: [] });
    expect(loopback.requests.map(({ method, path }) => [method, path])).toEqual([
      ["GET", "/v10/channels/111"],
      ["GET", "/v10/channels/111/messages/444"],
    ]);
  });

  it.each<[string, Partial<DiscordActionContext>]>([
    ["a user outside the current conversation", { params: { to: "user:999", messageId: "444" } }],
    ["another account's current conversation", { requesterAccountId: "other" }],
    ["another provider's current conversation", dmContext({ currentChannelProvider: "slack" })],
    ["a group conversation", dmContext({ currentChatType: "group" })],
    ["a context without the native channel ID", dmContext({ currentChannelId: "user:222" })],
    ["a context without the current user target", dmContext({ currentMessagingTarget: undefined })],
    [
      "an unattested user target",
      { conversationReadOrigin: undefined, requesterAccountId: undefined, toolContext: undefined },
    ],
  ])("rejects %s before resolving a Discord DM", async (_name, overrides) => {
    const error = await readReactions(overrides).catch((caught: unknown) => caught);
    expect(loopback.requests).toEqual([]);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "Discord channel id is required (use channel:<id>)." });
  });

  it("applies disabled-DM policy after resolving the current user target", async () => {
    await expect(
      readReactions({
        cfg: {
          channels: {
            discord: { accounts: { work: { token: "test-token", dmPolicy: "disabled" } } },
          },
        },
      }),
    ).rejects.toThrow("Discord read target channel is not allowed.");

    expect(loopback.requests.map(({ method, path }) => [method, path])).toEqual([
      ["GET", "/v10/channels/111"],
    ]);
  });

  it("retains direct-operator DM resolution for reaction reads", async () => {
    const result = await readReactions({
      conversationReadOrigin: "direct-operator",
      requesterAccountId: undefined,
      toolContext: undefined,
    });

    expect(result.details).toEqual({ ok: true, reactions: [] });
    expect(loopback.requests.map(({ method, path }) => [method, path])).toEqual([
      ["POST", "/v10/users/@me/channels"],
      ["GET", "/v10/channels/111"],
      ["GET", "/v10/channels/111/messages/444"],
    ]);
    expect(loopback.requests[0]).toMatchObject({ body: JSON.stringify({ recipient_id: "222" }) });
  });
});

describe("handleDiscordAction presence", () => {
  const mockUpdatePresence = vi.fn();
  const defaultDiscordConfig: OpenClawConfig = {
    channels: { discord: { token: "test-token", actions: { presence: true } } },
  };
  function createMockGateway(connected = true): GatewayPlugin {
    return {
      isConnected: connected,
      updatePresence: mockUpdatePresence,
    } as unknown as GatewayPlugin;
  }
  function setActionPresence(params: Record<string, unknown>) {
    return handleDiscordAction({ ...params, action: "setPresence" }, defaultDiscordConfig);
  }

  afterEach(() => clearGateways());
  beforeEach(() => {
    mockUpdatePresence.mockClear();
    clearGateways();
    registerGateway("default", createMockGateway());
  });

  it.each([
    {
      name: "mixed-case streaming activity with URL",
      params: {
        activityType: "StReAmInG",
        activityName: "My Stream",
        activityUrl: "https://twitch.tv/example",
      },
      activities: [{ name: "My Stream", type: 1, url: "https://twitch.tv/example" }],
    },
    {
      name: "custom activity using state",
      params: { activityType: "custom", activityState: "Vibing" },
      activities: [{ name: "", type: 4, state: "Vibing" }],
    },
  ])("sets $name", async ({ params, activities }) => {
    const result = await setActionPresence(params);
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities,
      status: "online",
      afk: false,
    });
    expect(result.details).toEqual({ ok: true, status: "online", activities });
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ["invalid status", { status: "offline" }, /Invalid status/],
    [
      "inherited constructor activityType",
      { activityType: "constructor", activityName: "x" },
      /Invalid activityType/,
    ],
    ["missing activityType", { activityName: "My Game" }, /activityType is required/],
  ])("rejects %s before sending to the gateway", async (_name, params, error) => {
    await expect(setActionPresence(params)).rejects.toThrow(error);
    expect(mockUpdatePresence).not.toHaveBeenCalled();
  });

  it("respects presence gating", async () => {
    await expect(
      handleDiscordAction(
        { action: "setPresence", status: "online" },
        { channels: { discord: { actions: { presence: false } } } },
      ),
    ).rejects.toThrow(/disabled/);
  });

  it.each([false, true])("rejects an unavailable gateway (registered: %s)", async (registered) => {
    clearGateways();
    if (registered) {
      registerGateway("default", createMockGateway(false));
    }
    await expect(setActionPresence({ status: "dnd" })).rejects.toThrow(
      registered ? /not connected/ : /not available/,
    );
  });

  it("routes the full presence action to the configured named default account", async () => {
    clearGateways();
    registerGateway("ops", createMockGateway());
    await handleDiscordAction(
      { action: "setPresence", status: "idle" },
      {
        channels: {
          discord: {
            actions: { presence: true },
            defaultAccount: "ops",
            accounts: { ops: { token: "ops-token" } },
          },
        },
      },
    );
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities: [],
      status: "idle",
      afk: false,
    });
  });

  it("rejects unknown actions", async () => {
    await expect(
      handleDiscordAction({ action: "unknownAction" }, defaultDiscordConfig),
    ).rejects.toThrow(/Unknown action/);
  });
});
