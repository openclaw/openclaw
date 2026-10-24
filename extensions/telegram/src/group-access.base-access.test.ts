import { resolveChannelGroupPolicy } from "openclaw/plugin-sdk/channel-policy";
import { validateTestChannelConfig } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import { mergeTelegramAccountConfig } from "./account-config.js";
import { normalizeAllowFrom, type NormalizedAllowFrom } from "./bot-access.js";
import { TelegramConfigSchema } from "./config-schema.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
} from "./group-access.js";

function allow(entries: string[], hasWildcard = false): NormalizedAllowFrom {
  return {
    entries,
    hasWildcard,
    hasEntries: entries.length > 0 || hasWildcard,
    invalidEntries: [],
  };
}

function runBaseAccess(overrides: Partial<Parameters<typeof evaluateTelegramGroupBaseAccess>[0]>) {
  return evaluateTelegramGroupBaseAccess({
    hasGroupAllowOverride: true,
    effectiveGroupAllow: allow([]),
    senderId: "12345",
    enforceAllowOverride: true,
    requireSenderForAllowOverride: true,
    ...overrides,
  });
}

describe("evaluateTelegramGroupBaseAccess", () => {
  it("normalizes sender-only allowlist entries and rejects group ids", () => {
    const result = normalizeAllowFrom(["-1001234567890", " tg:-100999 ", "745123456", "@someone"]);

    expect(result).toEqual({
      entries: ["745123456"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: ["-1001234567890", "-100999", "@someone"],
    });
  });

  it.each<
    [
      Partial<Parameters<typeof evaluateTelegramGroupBaseAccess>[0]>,
      ReturnType<typeof evaluateTelegramGroupBaseAccess>,
    ]
  >([
    [{}, { allowed: false, reason: "group-override-unauthorized" }],
    [{ hasGroupAllowOverride: false }, { allowed: true }],
    [{ effectiveGroupAllow: allow(["12345"]) }, { allowed: true }],
  ])("applies explicit sender overrides %j", (overrides, expected) => {
    expect(runBaseAccess(overrides)).toEqual(expected);
  });
});

type GroupAccessParams = Parameters<typeof evaluateTelegramGroupPolicyAccess>[0];

const DEFAULT_GROUP_ACCESS_PARAMS: GroupAccessParams = {
  isGroup: true,
  chatId: "-100123456",
  cfg: { channels: { telegram: {} } },
  telegramCfg: { groupPolicy: "allowlist" },
  effectiveGroupAllow: allow([]),
  senderId: "999",
  resolveGroupPolicy: () => ({
    allowlistEnabled: true,
    allowed: true,
    groupConfig: { requireMention: false },
  }),
  enforceAllowlistAuthorization: true,
  allowEmptyAllowlistEntries: false,
};

function runAccess(overrides: Partial<GroupAccessParams>) {
  return evaluateTelegramGroupPolicyAccess({
    ...DEFAULT_GROUP_ACCESS_PARAMS,
    ...overrides,
  });
}

const groupPolicy =
  (allowed: boolean, explicit = false) =>
  () => ({
    allowlistEnabled: true,
    allowed,
    groupConfig: explicit ? { requireMention: false } : undefined,
  });

describe("evaluateTelegramGroupPolicyAccess", () => {
  it.each([
    ["allowlist", "222", false],
    ["allowlist", "111", true],
    ["open", "222", true],
  ] as const)(
    "enforces inherited %s for sender %s after named-account validation",
    async (policy, senderId, allowed) => {
      const channel = TelegramConfigSchema.parse({
        groupPolicy: policy,
        groupAllowFrom: ["111"],
        groups: { "*": { requireMention: false } },
        accounts: { work: {} },
      });
      const cfg = await validateTestChannelConfig("telegram", channel);
      const telegramCfg = mergeTelegramAccountConfig(cfg, "work");

      expect(
        runAccess({
          cfg,
          telegramCfg,
          senderId,
          effectiveGroupAllow: normalizeAllowFrom(telegramCfg.groupAllowFrom),
          resolveGroupPolicy: (chatId, turnCfg) =>
            resolveChannelGroupPolicy({
              cfg: turnCfg,
              channel: "telegram",
              accountId: "work",
              groupId: String(chatId),
            }),
        }),
      ).toEqual({
        allowed,
        ...(!allowed ? { reason: "group-policy-allowlist-unauthorized" } : {}),
      });
    },
  );

  it.each<[string, Partial<GroupAccessParams>, string?]>([
    ["explicit group with no sender entries", {}],
    ["empty wildcard", { resolveGroupPolicy: groupPolicy(true) }, "group-policy-allowlist-empty"],
    [
      "unlisted group",
      { chatId: "-100999999", resolveGroupPolicy: groupPolicy(false) },
      "group-chat-not-allowed",
    ],
    [
      "unauthorized explicit-group sender",
      {
        effectiveGroupAllow: allow(["111"]),
        senderId: "222",
        resolveGroupPolicy: groupPolicy(true, true),
      },
      "group-policy-allowlist-unauthorized",
    ],
    [
      "open policy",
      {
        telegramCfg: { groupPolicy: "open" },
        resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: false }),
      },
      undefined,
    ],
    [
      "disabled policy",
      {
        telegramCfg: { groupPolicy: "disabled" },
        resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: false }),
      },
      "group-policy-disabled",
    ],
    [
      "non-group bypass",
      { isGroup: false, chatId: "12345", resolveGroupPolicy: groupPolicy(false) },
    ],
    [
      "missing sender",
      { senderId: undefined, effectiveGroupAllow: allow(["111"]) },
      "group-policy-allowlist-no-sender",
    ],
    [
      "authorized wildcard sender",
      {
        effectiveGroupAllow: allow(["111"]),
        senderId: "111",
        resolveGroupPolicy: groupPolicy(true),
      },
    ],
  ])("enforces %s", (_name, overrides, reason) => {
    expect(runAccess(overrides)).toEqual({
      allowed: !reason,
      ...(reason ? { reason } : {}),
    });
  });

  it("uses topic policy before group and account policy", () => {
    expect(
      runAccess({
        telegramCfg: { groupPolicy: "open" },
        groupConfig: { groupPolicy: "open" },
        topicConfig: { groupPolicy: "disabled" },
      }),
    ).toEqual({
      allowed: false,
      reason: "group-policy-disabled",
    });
    expect(
      runAccess({
        telegramCfg: { groupPolicy: "open" },
        groupConfig: { groupPolicy: "disabled" },
        topicConfig: { groupPolicy: "open" },
      }),
    ).toEqual({ allowed: true });
  });
});
