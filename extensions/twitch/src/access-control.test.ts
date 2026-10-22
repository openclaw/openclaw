import { describe, expect, it } from "vitest";
import { checkTwitchMessageThroughMonitor } from "./monitor-access.test-support.js";
import type { TwitchAccountConfig, TwitchChatMessage } from "./types.js";

describe("Twitch monitor access control", () => {
  const mockAccount: TwitchAccountConfig = {
    username: "testbot",
    accessToken: "test",
    clientId: "test-client-id",
    channel: "testchannel",
  };

  const mockMessage: TwitchChatMessage = {
    id: "message-1",
    username: "testuser",
    userId: "123456",
    message: "hello bot",
    channel: "testchannel",
  };

  function runAccessCheck(params: {
    account?: Partial<TwitchAccountConfig>;
    message?: Partial<TwitchChatMessage>;
  }) {
    return checkTwitchMessageThroughMonitor({
      accountId: "secondary",
      message: {
        ...mockMessage,
        ...params.message,
      },
      account: {
        ...mockAccount,
        ...params.account,
      },
    });
  }

  it.each<[string, Partial<TwitchAccountConfig>, Partial<TwitchChatMessage>, boolean]>([
    ["requires mention by default", {}, { message: "hello bot" }, false],
    ["blocks missing allowlisted ID", { allowFrom: ["123456"] }, { userId: undefined }, false],
    ["allows wildcard roles without ID", { allowedRoles: ["all"] }, { userId: undefined }, true],
    [
      "does not confuse IDs with roles",
      { allowedRoles: ["moderator"] },
      { userId: "moderator" },
      false,
    ],
    ["keeps empty roles open", { allowedRoles: [] }, { userId: undefined }, true],
    [
      "blocks unmentioned unauthorized chat",
      { requireMention: true, allowedRoles: ["moderator"] },
      { message: "ordinary chat", isMod: false },
      false,
    ],
    [
      "checks allowlist before roles",
      { allowFrom: ["123456"], allowedRoles: ["owner"] },
      { isOwner: false },
      true,
    ],
  ])("%s", async (_name, account, message, allowed) => {
    const result = await runAccessCheck({
      account,
      message: { message: "@testbot hello", ...message },
    });
    expect(result.allowed).toBe(allowed);
  });

  it.each([
    { role: "moderator", flag: "isMod" },
    { role: "owner", flag: "isOwner" },
    { role: "vip", flag: "isVip" },
    { role: "subscriber", flag: "isSub" },
  ] as const)(
    "admits only the matching $role alias, including absent native IDs",
    async ({ role, flag }) => {
      for (const userId of ["123456", undefined]) {
        for (const matching of [false, true]) {
          const result = await runAccessCheck({
            account: { allowedRoles: [role] },
            message: { message: "@testbot hello", userId, [flag]: matching },
          });
          expect(result.allowed).toBe(matching);
        }
      }
    },
  );
});
