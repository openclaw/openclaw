import { describe, expect, it } from "vitest";
import { evaluateTelegramGroupPolicyAccess } from "./group-access.js";
const baseCfg = {
  channels: { telegram: {} }
};
const baseTelegramCfg = {
  groupPolicy: "allowlist"
};
const emptyAllow = { entries: [], hasWildcard: false, hasEntries: false, invalidEntries: [] };
const senderAllow = {
  entries: ["111"],
  hasWildcard: false,
  hasEntries: true,
  invalidEntries: []
};
const DEFAULT_GROUP_ACCESS_PARAMS = {
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
    groupConfig: { requireMention: false }
  }),
  enforcePolicy: true,
  useTopicAndGroupOverrides: false,
  enforceAllowlistAuthorization: true,
  allowEmptyAllowlistEntries: false,
  requireSenderForAllowlistAuthorization: true,
  checkChatAllowlist: true
};
function runAccess(overrides) {
  return evaluateTelegramGroupPolicyAccess({
    ...DEFAULT_GROUP_ACCESS_PARAMS,
    ...overrides,
    resolveGroupPolicy: overrides.resolveGroupPolicy ?? DEFAULT_GROUP_ACCESS_PARAMS.resolveGroupPolicy
  });
}
describe("evaluateTelegramGroupPolicyAccess \u2013 chat allowlist vs sender allowlist ordering", () => {
  it("allows a group explicitly listed in groups config even when no allowFrom entries exist", () => {
    const result = runAccess({
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: { requireMention: false }
        // dedicated entry — not just wildcard
      })
    });
    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });
  it("still blocks when only wildcard match and no allowFrom entries", () => {
    const result = runAccess({
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: void 0
        // wildcard match only — no dedicated entry
      })
    });
    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-allowlist-empty",
      groupPolicy: "allowlist"
    });
  });
  it("rejects a group NOT in groups config", () => {
    const result = runAccess({
      chatId: "-100999999",
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: false
      })
    });
    expect(result).toEqual({
      allowed: false,
      reason: "group-chat-not-allowed",
      groupPolicy: "allowlist"
    });
  });
  it("still enforces sender allowlist when checkChatAllowlist is disabled", () => {
    const result = runAccess({
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: { requireMention: false }
      }),
      checkChatAllowlist: false
    });
    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-allowlist-empty",
      groupPolicy: "allowlist"
    });
  });
  it("blocks unauthorized sender even when chat is explicitly allowed and sender entries exist", () => {
    const result = runAccess({
      effectiveGroupAllow: senderAllow,
      // entries: ["111"]
      senderId: "222",
      // not in senderAllow.entries
      senderUsername: "other",
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: { requireMention: false }
      })
    });
    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-allowlist-unauthorized",
      groupPolicy: "allowlist"
    });
  });
  it("allows when groupPolicy is open regardless of allowlist state", () => {
    const result = runAccess({
      telegramCfg: { groupPolicy: "open" },
      resolveGroupPolicy: () => ({
        allowlistEnabled: false,
        allowed: false
      })
    });
    expect(result).toEqual({ allowed: true, groupPolicy: "open" });
  });
  it("rejects when groupPolicy is disabled", () => {
    const result = runAccess({
      telegramCfg: { groupPolicy: "disabled" },
      resolveGroupPolicy: () => ({
        allowlistEnabled: false,
        allowed: false
      })
    });
    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-disabled",
      groupPolicy: "disabled"
    });
  });
  it("allows non-group messages without any checks", () => {
    const result = runAccess({
      isGroup: false,
      chatId: "12345",
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: false
      })
    });
    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });
  it("blocks allowlist groups without sender identity before sender matching", () => {
    const result = runAccess({
      senderId: void 0,
      senderUsername: void 0,
      effectiveGroupAllow: senderAllow,
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: { requireMention: false }
      })
    });
    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-allowlist-no-sender",
      groupPolicy: "allowlist"
    });
  });
  it("allows authorized sender in wildcard-matched group with sender entries", () => {
    const result = runAccess({
      effectiveGroupAllow: senderAllow,
      // entries: ["111"]
      senderId: "111",
      // IS in senderAllow.entries
      resolveGroupPolicy: () => ({
        allowlistEnabled: true,
        allowed: true,
        groupConfig: void 0
        // wildcard only
      })
    });
    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });
});
