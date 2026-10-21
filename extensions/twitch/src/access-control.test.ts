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

  async function expectAllowedAccessCheck(params: {
    account?: Partial<TwitchAccountConfig>;
    message?: Partial<TwitchChatMessage>;
  }) {
    const result = await runAccessCheck({
      account: params.account,
      message: {
        message: "@testbot hello",
        ...params.message,
      },
    });
    expect(result.allowed).toBe(true);
    return result;
  }

  async function expectAllowFromBlocked(params: {
    allowFrom: string[];
    allowedRoles?: NonNullable<TwitchAccountConfig["allowedRoles"]>;
    message?: Partial<TwitchChatMessage>;
  }) {
    const result = await runAccessCheck({
      account: {
        allowFrom: params.allowFrom,
        allowedRoles: params.allowedRoles,
      },
      message: {
        message: "@testbot hello",
        ...params.message,
      },
    });
    expect(result.allowed).toBe(false);
  }

  describe("requireMention default", () => {
    it("defaults to true when undefined", async () => {
      const result = await runAccessCheck({
        message: {
          message: "hello bot",
        },
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe("allowFrom allowlist", () => {
    it("blocks messages without userId", async () => {
      await expectAllowFromBlocked({
        allowFrom: ["123456"],
        message: { userId: undefined },
      });
    });
  });

  describe("allowedRoles", () => {
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

    it("allows wildcard roles without requiring a native ID", async () => {
      await expectAllowedAccessCheck({
        account: {
          allowedRoles: ["all"],
        },
        message: { userId: undefined },
      });
    });

    it("does not treat a native ID spelling a role as role membership", async () => {
      const result = await runAccessCheck({
        account: { allowedRoles: ["moderator"] },
        message: { message: "@testbot hello", userId: "moderator" },
      });
      expect(result.allowed).toBe(false);
    });

    it("keeps an open policy for empty roles", async () => {
      await expectAllowedAccessCheck({
        account: { allowedRoles: [] },
        message: { userId: undefined },
      });
    });
  });

  describe("combined restrictions", () => {
    it("does not dispatch unmentioned unauthorized chat", async () => {
      const result = await runAccessCheck({
        account: {
          requireMention: true,
          allowedRoles: ["moderator"],
        },
        message: {
          message: "ordinary chat",
          isMod: false,
        },
      });

      expect(result.allowed).toBe(false);
    });

    it("checks allowlist before allowedRoles", async () => {
      const result = await runAccessCheck({
        account: {
          allowFrom: ["123456"],
          allowedRoles: ["owner"],
        },
        message: {
          message: "@testbot hello",
          isOwner: false,
        },
      });
      expect(result.allowed).toBe(true);
    });
  });
});
