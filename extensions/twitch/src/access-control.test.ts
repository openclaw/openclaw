import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it } from "vitest";
import { checkTwitchAccessControl } from "./access-control.js";
import { setTwitchRuntime } from "./runtime.js";
import type { TwitchAccountConfig, TwitchChatMessage } from "./types.js";

describe("checkTwitchAccessControl", () => {
  beforeEach(() => {
    setTwitchRuntime(createPluginRuntimeMock());
  });

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
    return checkTwitchAccessControl({
      accountId: "secondary",
      message: {
        ...mockMessage,
        ...params.message,
      },
      account: {
        ...mockAccount,
        ...params.account,
      },
      botUsername: "testbot",
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
    reason: string;
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
    expect(result.reason).toContain(params.reason);
  }

  describe("requireMention default", () => {
    it("defaults to true when undefined", async () => {
      const result = await runAccessCheck({
        message: {
          message: "hello bot",
        },
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not mention the bot");
    });
  });

  describe("requireMention", () => {
    it("is case-insensitive for bot username", async () => {
      const result = await runAccessCheck({
        account: { requireMention: true },
        message: { message: "@TestBot hello" },
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("allowFrom allowlist", () => {
    it("blocks everyone when allowFrom is explicitly empty", async () => {
      await expectAllowFromBlocked({
        allowFrom: [],
        reason: "allowFrom",
      });
    });

    it("blocks messages without userId", async () => {
      await expectAllowFromBlocked({
        allowFrom: ["123456"],
        message: { userId: undefined },
        reason: "user ID not available",
      });
    });

    it("blocks user with role when not in allowlist", async () => {
      await expectAllowFromBlocked({
        allowFrom: ["789012"],
        allowedRoles: ["moderator"],
        message: { userId: "123456", isMod: true },
        reason: "allowFrom",
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
            if (matching) {
              expect(result.matchSource).toBe("role");
            } else {
              expect(result.reason).toContain("does not have any of the required roles");
            }
          }
        }
      },
    );

    it("allows users with any of multiple roles", async () => {
      const result = await runAccessCheck({
        account: { allowedRoles: ["moderator", "vip", "subscriber"] },
        message: { message: "@testbot hello", isVip: true, isMod: false, isSub: false },
      });
      expect(result.allowed).toBe(true);
    });

    it.each(["123456", undefined])(
      "allows wildcard roles without requiring a native ID (%s)",
      async (userId) => {
        const result = await expectAllowedAccessCheck({
          account: {
            allowedRoles: ["all"],
          },
          message: { userId },
        });
        expect(result.matchKey).toBe("all");
      },
    );

    it("does not treat a native ID spelling a role as role membership", async () => {
      const result = await runAccessCheck({
        account: { allowedRoles: ["moderator"] },
        message: { message: "@testbot hello", userId: "moderator" },
      });
      expect(result.allowed).toBe(false);
    });

    it.each([undefined, []])(
      "keeps an open policy for absent or empty roles (%s)",
      async (allowedRoles) => {
        await expectAllowedAccessCheck({
          account: { allowedRoles },
          message: { userId: undefined },
        });
      },
    );
  });

  describe("combined restrictions", () => {
    it("checks requireMention before sender allowlists for unauthorized chat", async () => {
      const result = await runAccessCheck({
        account: {
          requireMention: true,
          allowFrom: ["789012"],
        },
        message: {
          message: "ordinary chat",
          userId: "123456",
        },
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not mention the bot");
    });

    it("checks requireMention before role gates for unauthorized chat", async () => {
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
      expect(result.reason).toContain("does not mention the bot");
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
      expect(result.matchKey).toBe("123456");
      expect(result.matchSource).toBe("allowlist");
    });
  });
});
