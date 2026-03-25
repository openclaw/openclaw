import { describe, expect, it } from "vitest";
import {
  evaluateSynologyChatGroupAccess,
  resolveSynologyChatGroupRequireMention,
} from "./group-access.js";
import type { ResolvedSynologyChatAccount } from "./types.js";

function makeAccount(
  overrides: Partial<ResolvedSynologyChatAccount> = {},
): ResolvedSynologyChatAccount {
  return {
    accountId: "default",
    enabled: true,
    token: "t",
    incomingUrl: "https://nas/incoming",
    nasHost: "nas",
    webhookPath: "/webhook/synology",
    webhookPathSource: "default",
    dangerouslyAllowNameMatching: false,
    dangerouslyAllowInheritedWebhookPath: false,
    dmPolicy: "allowlist",
    allowedUserIds: ["4"],
    groupPolicy: "disabled",
    groupAllowFrom: [],
    channels: {},
    rateLimitPerMinute: 30,
    botName: "Bot",
    allowInsecureSsl: false,
    ...overrides,
  };
}

describe("evaluateSynologyChatGroupAccess", () => {
  it("blocks when groupPolicy is disabled", () => {
    const result = evaluateSynologyChatGroupAccess({
      account: makeAccount({ groupPolicy: "disabled" }),
      senderId: "4",
      channelId: "chan1",
    });
    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-disabled",
      groupPolicy: "disabled",
    });
  });

  it("allows all senders when groupPolicy is open", () => {
    const result = evaluateSynologyChatGroupAccess({
      account: makeAccount({ groupPolicy: "open" }),
      senderId: "999",
      channelId: "chan1",
    });
    expect(result).toEqual({ allowed: true, groupPolicy: "open" });
  });

  it("allows authorized sender with allowlist policy", () => {
    const result = evaluateSynologyChatGroupAccess({
      account: makeAccount({
        groupPolicy: "allowlist",
        groupAllowFrom: ["4", "5"],
      }),
      senderId: "4",
      channelId: "chan1",
    });
    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });

  it("blocks unauthorized sender with allowlist policy", () => {
    const result = evaluateSynologyChatGroupAccess({
      account: makeAccount({
        groupPolicy: "allowlist",
        groupAllowFrom: ["4"],
      }),
      senderId: "999",
      channelId: "chan1",
    });
    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-allowlist-unauthorized",
      groupPolicy: "allowlist",
    });
  });

  it("blocks when allowlist is empty", () => {
    const result = evaluateSynologyChatGroupAccess({
      account: makeAccount({
        groupPolicy: "allowlist",
        groupAllowFrom: [],
      }),
      senderId: "4",
      channelId: "chan1",
    });
    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-allowlist-empty",
      groupPolicy: "allowlist",
    });
  });

  it("blocks when no senderId with allowlist policy", () => {
    const result = evaluateSynologyChatGroupAccess({
      account: makeAccount({
        groupPolicy: "allowlist",
        groupAllowFrom: ["4"],
      }),
      senderId: undefined,
      channelId: "chan1",
    });
    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-allowlist-no-sender",
      groupPolicy: "allowlist",
    });
  });

  it("allows wildcard '*' in groupAllowFrom", () => {
    const result = evaluateSynologyChatGroupAccess({
      account: makeAccount({
        groupPolicy: "allowlist",
        groupAllowFrom: ["*"],
      }),
      senderId: "anyone",
      channelId: "chan1",
    });
    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });

  it("normalizes sender ID for case-insensitive matching", () => {
    const result = evaluateSynologyChatGroupAccess({
      account: makeAccount({
        groupPolicy: "allowlist",
        groupAllowFrom: ["User1"],
      }),
      senderId: "user1",
      channelId: "chan1",
    });
    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });

  describe("per-channel overrides", () => {
    it("uses per-channel allowFrom when matching by channel_id", () => {
      const result = evaluateSynologyChatGroupAccess({
        account: makeAccount({
          groupPolicy: "allowlist",
          groupAllowFrom: [], // account-level empty
          channels: {
            chan1: { allowFrom: ["42"] },
          },
        }),
        senderId: "42",
        channelId: "chan1",
      });
      expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
    });

    it("uses per-channel allowFrom when matching by channel_name", () => {
      const result = evaluateSynologyChatGroupAccess({
        account: makeAccount({
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          channels: {
            general: { allowFrom: ["42"] },
          },
        }),
        senderId: "42",
        channelName: "general",
      });
      expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
    });

    it("falls back to wildcard channel config", () => {
      const result = evaluateSynologyChatGroupAccess({
        account: makeAccount({
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          channels: {
            "*": { allowFrom: ["42"] },
          },
        }),
        senderId: "42",
        channelId: "unknown-channel",
      });
      expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
    });

    it("channel_id takes precedence over channel_name", () => {
      const result = evaluateSynologyChatGroupAccess({
        account: makeAccount({
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          channels: {
            chan1: { allowFrom: ["allowed-user"] },
            general: { allowFrom: ["other-user"] },
          },
        }),
        senderId: "allowed-user",
        channelId: "chan1",
        channelName: "general",
      });
      expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
    });
  });
});

describe("resolveSynologyChatGroupRequireMention", () => {
  it("defaults to true (require mention)", () => {
    const result = resolveSynologyChatGroupRequireMention({
      account: makeAccount(),
    });
    expect(result).toBe(true);
  });

  it("uses per-channel requireMention when set", () => {
    const result = resolveSynologyChatGroupRequireMention({
      account: makeAccount({
        channels: {
          chan1: { requireMention: false },
        },
      }),
      channelId: "chan1",
    });
    expect(result).toBe(false);
  });

  it("falls back to wildcard requireMention", () => {
    const result = resolveSynologyChatGroupRequireMention({
      account: makeAccount({
        channels: {
          "*": { requireMention: false },
        },
      }),
      channelId: "unknown",
    });
    expect(result).toBe(false);
  });

  it("specific channel overrides wildcard", () => {
    const result = resolveSynologyChatGroupRequireMention({
      account: makeAccount({
        channels: {
          "*": { requireMention: false },
          chan1: { requireMention: true },
        },
      }),
      channelId: "chan1",
    });
    expect(result).toBe(true);
  });
});
