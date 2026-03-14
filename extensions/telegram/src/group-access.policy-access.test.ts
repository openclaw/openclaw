import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { TelegramAccountConfig } from "../../../src/config/types.js";
import { evaluateTelegramGroupPolicyAccess } from "./group-access.js";

/**
 * Minimal stubs shared across tests.
 */
const baseCfg = {
  channels: { telegram: {} },
} as unknown as OpenClawConfig;

const baseTelegramCfg: TelegramAccountConfig = {
  groupPolicy: "allowlist",
} as unknown as TelegramAccountConfig;

const emptyAllow = { entries: [], hasWildcard: false, hasEntries: false, invalidEntries: [] };
const senderAllow = {
  entries: ["111"],
  hasWildcard: false,
  hasEntries: true,
  invalidEntries: [],
};

type GroupAccessParams = Parameters<typeof evaluateTelegramGroupPolicyAccess>[0];

const DEFAULT_GROUP_ACCESS_PARAMS: GroupAccessParams = {
  isGroup: true,
  chatId: "-100123456",
  cfg: baseCfg,
  telegramCfg: baseTelegramCfg,
  effectiveGroupAllow: emptyAllow,
  senderId: "999",
  senderUsername: "user",
  resolveGroupPolicy: () => ({
    allowlistEnabled: true,
    allowed: true,
    groupConfig: { requireMention: false },
  }),
  enforcePolicy: true,
  useTopicAndGroupOverrides: false,
  enforceAllowlistAuthorization: true,
  allowEmptyAllowlistEntries: false,
  requireSenderForAllowlistAuthorization: true,
  checkChatAllowlist: true,
};

function runAccess(overrides: Partial<GroupAccessParams>) {
  return evaluateTelegramGroupPolicyAccess({
    ...DEFAULT_GROUP_ACCESS_PARAMS,
    ...overrides,
    resolveGroupPolicy:
      overrides.resolveGroupPolicy ?? DEFAULT_GROUP_ACCESS_PARAMS.resolveGroupPolicy,
  });
}

describe("evaluateTelegramGroupPolicyAccess – chat allowlist vs sender allowlist ordering", () => {
  it("allows a group explicitly listed in groups config even when no allowFrom entries exist", () => {
    // Issue #30613: a group configured with a dedicated entry (groupConfig set)
    // should be allowed even without any allowFrom / groupAllowFrom entries.
    const result = runAccess({
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: { requireMention: false }, // dedicated entry — not just wildcard
      }),
    });

    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });

  it("still blocks when only wildcard match and no allowFrom entries", () => {
    // groups: { "*": ... } with no allowFrom → wildcard does NOT bypass sender checks.
    const result = runAccess({
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: undefined, // wildcard match only — no dedicated entry
      }),
    });

    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-allowlist-empty",
      groupPolicy: "allowlist",
    });
  });

  it("rejects a group NOT in groups config", () => {
    const result = runAccess({
      chatId: "-100999999",
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: false,
      }),
    });

    expect(result).toEqual({
      allowed: false,
      reason: "group-chat-not-allowed",
      groupPolicy: "allowlist",
    });
  });

  it("still enforces sender allowlist when checkChatAllowlist is disabled", () => {
    const result = runAccess({
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: { requireMention: false },
      }),
      checkChatAllowlist: false,
    });

    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-allowlist-empty",
      groupPolicy: "allowlist",
    });
  });

  it("blocks unauthorized sender even when chat is explicitly allowed and sender entries exist", () => {
    const result = runAccess({
      effectiveGroupAllow: senderAllow, // entries: ["111"]
      senderId: "222", // not in senderAllow.entries
      senderUsername: "other",
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: { requireMention: false },
      }),
    });

    // Chat is explicitly allowed, but sender entries exist and sender is not in them.
    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-allowlist-unauthorized",
      groupPolicy: "allowlist",
    });
  });

  it("allows when groupPolicy is open regardless of allowlist state", () => {
    const result = runAccess({
      telegramCfg: { groupPolicy: "open" } as unknown as TelegramAccountConfig,
      resolveGroupPolicy: () => ({
        allowlistEnabled: false,
        allowed: false,
      }),
    });

    expect(result).toEqual({ allowed: true, groupPolicy: "open" });
  });

  it("rejects when groupPolicy is disabled", () => {
    const result = runAccess({
      telegramCfg: { groupPolicy: "disabled" } as unknown as TelegramAccountConfig,
      resolveGroupPolicy: () => ({
        allowlistEnabled: false,
        allowed: false,
      }),
    });

    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-disabled",
      groupPolicy: "disabled",
    });
  });

  it("allows non-group messages without any checks", () => {
    const result = runAccess({
      isGroup: false,
      chatId: "12345",
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: false,
      }),
    });

    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });

  it("blocks allowlist groups without sender identity before sender matching", () => {
    const result = runAccess({
      senderId: undefined,
      senderUsername: undefined,
      effectiveGroupAllow: senderAllow,
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: { requireMention: false },
      }),
    });

    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-allowlist-no-sender",
      groupPolicy: "allowlist",
    });
  });

  it("allows authorized sender in wildcard-matched group with sender entries", () => {
    const result = runAccess({
      effectiveGroupAllow: senderAllow, // entries: ["111"]
      senderId: "111", // IS in senderAllow.entries
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: undefined, // wildcard only
      }),
    });

    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });
});
