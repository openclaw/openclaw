import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import {
  isFeishuGroupAllowed,
  resolveFeishuAllowlistMatch,
  resolveFeishuGroupConfig,
  resolveFeishuReplyPolicy,
} from "./policy.js";
import type { FeishuConfig } from "./types.js";

function createCfg(feishu: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      feishu,
    },
  } as OpenClawConfig;
}

describe("resolveFeishuReplyPolicy", () => {
  it("defaults open groups to no mention when unset", () => {
    expect(
      resolveFeishuReplyPolicy({
        isDirectMessage: false,
        cfg: createCfg({ groupPolicy: "open" }),
        groupPolicy: "open",
        groupId: "oc_1",
      }),
    ).toEqual({ requireMention: false });
  });

  it("keeps explicit top-level mention gating in open groups", () => {
    expect(
      resolveFeishuReplyPolicy({
        isDirectMessage: false,
        cfg: createCfg({ groupPolicy: "open", requireMention: true }),
        groupPolicy: "open",
        groupId: "oc_1",
      }),
    ).toEqual({ requireMention: true });
  });

  it("keeps explicit account mention gating in open groups", () => {
    expect(
      resolveFeishuReplyPolicy({
        isDirectMessage: false,
        cfg: createCfg({
          groupPolicy: "allowlist",
          requireMention: false,
          accounts: {
            work: {
              groupPolicy: "open",
              requireMention: true,
            },
          },
        }),
        accountId: "work",
        groupPolicy: "open",
        groupId: "oc_1",
      }),
    ).toEqual({ requireMention: true });
  });

  it("keeps explicit per-group mention gating in open groups", () => {
    expect(
      resolveFeishuReplyPolicy({
        isDirectMessage: false,
        cfg: createCfg({
          groupPolicy: "open",
          groups: { oc_1: { requireMention: true } },
        }),
        groupPolicy: "open",
        groupId: "oc_1",
      }),
    ).toEqual({ requireMention: true });
  });

  it("defaults allowlist groups to require mentions", () => {
    expect(
      resolveFeishuReplyPolicy({
        isDirectMessage: false,
        cfg: createCfg({ groupPolicy: "allowlist" }),
        groupPolicy: "allowlist",
        groupId: "oc_1",
      }),
    ).toEqual({ requireMention: true });
  });
});

describe("resolveFeishuGroupConfig", () => {
  it("falls back to wildcard group config when direct match is missing", () => {
    const cfg: FeishuConfig = {
      groups: {
        "*": { requireMention: false },
        "oc-explicit": { requireMention: true },
      },
    };

    const resolved = resolveFeishuGroupConfig({
      cfg,
      groupId: "oc-missing",
    });

    expect(resolved).toEqual({ requireMention: false });
  });

  it("prefers exact group config over wildcard", () => {
    const cfg: FeishuConfig = {
      groups: {
        "*": { requireMention: false },
        "oc-explicit": { requireMention: true },
      },
    };

    const resolved = resolveFeishuGroupConfig({
      cfg,
      groupId: "oc-explicit",
    });

    expect(resolved).toEqual({ requireMention: true });
  });

  it("keeps case-insensitive matching for explicit group ids", () => {
    const cfg: FeishuConfig = {
      groups: {
        "*": { requireMention: false },
        OC_UPPER: { requireMention: true },
      },
    };

    const resolved = resolveFeishuGroupConfig({
      cfg,
      groupId: "oc_upper",
    });

    expect(resolved).toEqual({ requireMention: true });
  });
});

describe("resolveFeishuAllowlistMatch", () => {
  it("allows wildcard", () => {
    expect(
      resolveFeishuAllowlistMatch({
        allowFrom: ["*"],
        senderId: "ou-attacker",
      }),
    ).toEqual({ allowed: true, matchKey: "*", matchSource: "wildcard" });
  });

  it("matches normalized ID entries", () => {
    expect(
      resolveFeishuAllowlistMatch({
        allowFrom: ["feishu:user:OU_ALLOWED"],
        senderId: "ou_allowed",
      }),
    ).toEqual({ allowed: true, matchKey: "ou_allowed", matchSource: "id" });
  });

  it("supports user_id as an additional immutable sender candidate", () => {
    expect(
      resolveFeishuAllowlistMatch({
        allowFrom: ["on_user_123"],
        senderId: "ou_other",
        senderIds: ["on_user_123"],
      }),
    ).toEqual({ allowed: true, matchKey: "on_user_123", matchSource: "id" });
  });

  it("does not authorize based on display-name collision", () => {
    const victimOpenId = "ou_4f4ec5aa111122223333444455556666";

    expect(
      resolveFeishuAllowlistMatch({
        allowFrom: [victimOpenId],
        senderId: "ou_attacker_real_open_id",
        senderIds: ["on_attacker_user_id"],
        senderName: victimOpenId,
      }),
    ).toEqual({ allowed: false });
  });
});

describe("isFeishuGroupAllowed", () => {
  it("matches group IDs with chat: prefix", () => {
    expect(
      isFeishuGroupAllowed({
        groupPolicy: "allowlist",
        allowFrom: ["chat:oc_group_123"],
        senderId: "oc_group_123",
      }),
    ).toBe(true);
  });

  it("allows group when groupPolicy is 'open'", () => {
    expect(
      isFeishuGroupAllowed({
        groupPolicy: "open",
        allowFrom: [],
        senderId: "oc_group_999",
      }),
    ).toBe(true);
  });

  it("treats 'allowall' as equivalent to 'open'", () => {
    expect(
      isFeishuGroupAllowed({
        groupPolicy: "allowall",
        allowFrom: [],
        senderId: "oc_group_999",
      }),
    ).toBe(true);
  });

  it("rejects group when groupPolicy is 'disabled'", () => {
    expect(
      isFeishuGroupAllowed({
        groupPolicy: "disabled",
        allowFrom: ["oc_group_999"],
        senderId: "oc_group_999",
      }),
    ).toBe(false);
  });

  it("rejects group when groupPolicy is 'allowlist' and allowFrom is empty", () => {
    expect(
      isFeishuGroupAllowed({
        groupPolicy: "allowlist",
        allowFrom: [],
        senderId: "oc_group_999",
      }),
    ).toBe(false);
  });
});
