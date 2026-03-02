import { describe, expect, it } from "vitest";
import { checkTwitchAccessControl, extractMentions } from "./access-control.js";
import type { TwitchAccountConfig, TwitchChatMessage } from "./types.js";

describe("checkTwitchAccessControl", () => {
  const mockAccount: TwitchAccountConfig = {
    username: "testbot",
    accessToken: "test",
    clientId: "test-client-id",
    channel: "testchannel",
  };

  const mockMessage: TwitchChatMessage = {
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

  function expectSingleRoleAllowed(params: {
    role: NonNullable<TwitchAccountConfig["allowedRoles"]>[number];
    message: Partial<TwitchChatMessage>;
  }) {
    const result = runAccessCheck({
      account: { allowedRoles: [params.role] },
      message: {
        message: "@testbot hello",
        ...params.message,
      },
    });
    expect(result.allowed).toBe(true);
    return result;
  }

  describe("when no restrictions are configured", () => {
    it("allows messages that mention the bot (default requireMention)", () => {
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
      };
      const result = checkTwitchAccessControl({
        message,
        account: mockAccount,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("requireMention default", () => {
    it("defaults to true when undefined", () => {
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "hello bot",
      };

      const result = checkTwitchAccessControl({
        message,
        account: mockAccount,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not mention the bot");
    });

    it("allows mention when requireMention is undefined", () => {
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
      };

      const result = checkTwitchAccessControl({
        message,
        account: mockAccount,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("requireMention", () => {
    it("allows messages that mention the bot", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        requireMention: true,
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
    });

    it("blocks messages that don't mention the bot", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        requireMention: true,
      };

      const result = checkTwitchAccessControl({
        message: mockMessage,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not mention the bot");
    });

    it("is case-insensitive for bot username", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        requireMention: true,
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@TestBot hello",
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("allowFrom allowlist", () => {
    it("allows users in the allowlist", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowFrom: ["123456", "789012"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
      expect(result.matchKey).toBe("123456");
      expect(result.matchSource).toBe("allowlist");
    });

    it("blocks users not in allowlist when allowFrom is set", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowFrom: ["789012"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("allowFrom");
    });

    it("blocks messages without userId", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowFrom: ["123456"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
        userId: undefined,
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("user ID not available");
    });

    it("bypasses role checks when user is in allowlist", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowFrom: ["123456"],
        allowedRoles: ["owner"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
        isOwner: false,
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
    });

    it("blocks user with role when not in allowlist", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowFrom: ["789012"],
        allowedRoles: ["moderator"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
        userId: "123456",
        isMod: true,
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("allowFrom");
    });

    it("blocks user not in allowlist even when roles configured", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowFrom: ["789012"],
        allowedRoles: ["moderator"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
        userId: "123456",
        isMod: false,
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("allowFrom");
    });
  });

  describe("allowedRoles", () => {
    it("allows users with matching role", () => {
      const result = expectSingleRoleAllowed({
        role: "moderator",
        message: { isMod: true },
      });
      expect(result.matchSource).toBe("role");
    });

    it("allows users with any of multiple roles", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowedRoles: ["moderator", "vip", "subscriber"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
        isVip: true,
        isMod: false,
        isSub: false,
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
    });

    it("blocks users without matching role", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowedRoles: ["moderator"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
        isMod: false,
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not have any of the required roles");
    });

    it("allows all users when role is 'all'", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        allowedRoles: ["all"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "@testbot hello",
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(true);
      expect(result.matchKey).toBe("all");
    });

    it("handles moderator role", () => {
      expectSingleRoleAllowed({
        role: "moderator",
        message: { isMod: true },
      });
    });

    it("handles subscriber role", () => {
      expectSingleRoleAllowed({
        role: "subscriber",
        message: { isSub: true },
      });
    });

    it("handles owner role", () => {
      expectSingleRoleAllowed({
        role: "owner",
        message: { isOwner: true },
      });
    });

    it("handles vip role", () => {
      expectSingleRoleAllowed({
        role: "vip",
        message: { isVip: true },
      });
    });
  });

  describe("combined restrictions", () => {
    it("checks requireMention before allowlist", () => {
      const account: TwitchAccountConfig = {
        ...mockAccount,
        requireMention: true,
        allowFrom: ["123456"],
      };
      const message: TwitchChatMessage = {
        ...mockMessage,
        message: "hello", // No mention
      };

      const result = checkTwitchAccessControl({
        message,
        account,
        botUsername: "testbot",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not mention the bot");
    });

    it("checks allowlist before allowedRoles", () => {
      const result = runAccessCheck({
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
      expect(result.matchSource).toBe("allowlist");
    });
  });
});

describe("extractMentions", () => {
  it("extracts single mention", () => {
    const mentions = extractMentions("hello @testbot");
    expect(mentions).toEqual(["testbot"]);
  });

  it("extracts multiple mentions", () => {
    const mentions = extractMentions("hello @testbot and @otheruser");
    expect(mentions).toEqual(["testbot", "otheruser"]);
  });

  it("returns empty array when no mentions", () => {
    const mentions = extractMentions("hello everyone");
    expect(mentions).toEqual([]);
  });

  it("handles mentions at start of message", () => {
    const mentions = extractMentions("@testbot hello");
    expect(mentions).toEqual(["testbot"]);
  });

  it("handles mentions at end of message", () => {
    const mentions = extractMentions("hello @testbot");
    expect(mentions).toEqual(["testbot"]);
  });

  it("converts mentions to lowercase", () => {
    const mentions = extractMentions("hello @TestBot");
    expect(mentions).toEqual(["testbot"]);
  });

  it("extracts alphanumeric usernames", () => {
    const mentions = extractMentions("hello @user123");
    expect(mentions).toEqual(["user123"]);
  });

  it("handles underscores in usernames", () => {
    const mentions = extractMentions("hello @test_user");
    expect(mentions).toEqual(["test_user"]);
  });

  it("handles empty string", () => {
    const mentions = extractMentions("");
    expect(mentions).toEqual([]);
  });
});
