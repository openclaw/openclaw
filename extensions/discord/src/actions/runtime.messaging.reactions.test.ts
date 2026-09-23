import { ChannelType } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as discordRequestClient from "../proxy-request-client.js";
import { createDiscordLoopbackRest } from "../send.test-harness.js";
import { handleDiscordMessageAction } from "./handle-action.js";

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
    vi.spyOn(discordRequestClient, "createDiscordRequestClient").mockReturnValue(loopback.rest);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await loopback.close();
  });

  it.each(["user:222", "<@222>"])(
    "reads reactions for current DM target %s without creating it",
    async (to) => {
      const result = await readReactions({ params: { to, messageId: "444" } });

      expect(result.details).toEqual({ ok: true, reactions: [] });
      expect(loopback.requests.map(({ method, path }) => [method, path])).toEqual([
        ["GET", "/v10/channels/111"],
        ["GET", "/v10/channels/111/messages/444"],
      ]);
    },
  );

  it.each([
    {
      name: "a user outside the current conversation",
      overrides: { params: { to: "user:999", messageId: "444" } },
    },
    {
      name: "another account's current conversation",
      overrides: { requesterAccountId: "other" },
    },
    {
      name: "another provider's current conversation",
      overrides: {
        toolContext: { ...currentDmContext, currentChannelProvider: "slack" },
      },
    },
    {
      name: "a group conversation",
      overrides: {
        toolContext: { ...currentDmContext, currentChatType: "group" },
      },
    },
    {
      name: "a context without the native channel ID",
      overrides: {
        toolContext: { ...currentDmContext, currentChannelId: "user:222" },
      },
    },
    {
      name: "a context without the current user target",
      overrides: {
        toolContext: { ...currentDmContext, currentMessagingTarget: undefined },
      },
    },
    {
      name: "an unattested user target",
      overrides: {
        conversationReadOrigin: undefined,
        requesterAccountId: undefined,
        toolContext: undefined,
      },
    },
  ] satisfies Array<{ name: string; overrides: Partial<DiscordActionContext> }>)(
    "rejects $name before resolving a Discord DM",
    async ({ overrides }) => {
      const error = await readReactions(overrides).catch((caught: unknown) => caught);
      expect(loopback.requests).toEqual([]);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        message: "Discord channel id is required (use channel:<id>).",
      });
    },
  );

  it("applies disabled-DM policy after resolving the current user target", async () => {
    await expect(
      readReactions({
        cfg: {
          channels: {
            discord: {
              accounts: { work: { token: "test-token", dmPolicy: "disabled" } },
            },
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
    expect(loopback.requests[0]).toMatchObject({
      body: JSON.stringify({ recipient_id: "222" }),
    });
  });
});
