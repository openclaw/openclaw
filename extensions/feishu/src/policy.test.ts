import { describe, expect, it } from "vitest";
import {
  isFeishuGroupAllowed,
  resolveFeishuAllowlistMatch,
  resolveFeishuGroupConfig,
  resolveFeishuReplyPolicy,
} from "./policy.js";
import type { FeishuConfig, FeishuGroupConfig } from "./types.js";

describe("feishu policy", () => {
  describe("resolveFeishuGroupConfig", () => {
    it("falls back to wildcard group config when direct match is missing", () => {
      const cfg = {
        groups: {
          "*": { requireMention: false },
          "oc-explicit": { requireMention: true },
        },
      } as unknown as FeishuConfig;

      const resolved = resolveFeishuGroupConfig({
        cfg,
        groupId: "oc-missing",
      });

      expect(resolved).toEqual({ requireMention: false });
    });

    it("prefers exact group config over wildcard", () => {
      const cfg = {
        groups: {
          "*": { requireMention: false },
          "oc-explicit": { requireMention: true },
        },
      } as unknown as FeishuConfig;

      const resolved = resolveFeishuGroupConfig({
        cfg,
        groupId: "oc-explicit",
      });

      expect(resolved).toEqual({ requireMention: true });
    });

    it("keeps case-insensitive matching for explicit group ids", () => {
      const cfg = {
        groups: {
          "*": { requireMention: false },
          OC_UPPER: { requireMention: true },
        },
      } as unknown as FeishuConfig;

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

  describe("resolveFeishuReplyPolicy", () => {
    it("does not require mention for DMs", () => {
      expect(resolveFeishuReplyPolicy({ isDirectMessage: true })).toEqual({
        requireMention: false,
      });
    });

    it("requires mention in group by default", () => {
      expect(resolveFeishuReplyPolicy({ isDirectMessage: false })).toEqual({
        requireMention: true,
      });
    });

    it("respects group-level requireMention override", () => {
      expect(
        resolveFeishuReplyPolicy({
          isDirectMessage: false,
          groupConfig: { requireMention: false } as FeishuGroupConfig,
        }),
      ).toEqual({ requireMention: false });
    });

    it("still requires mention for thread replies when no thread override is set", () => {
      expect(
        resolveFeishuReplyPolicy({
          isDirectMessage: false,
          isThreadReply: true,
        }),
      ).toEqual({ requireMention: true });
    });

    it("skips mention for thread replies when requireMentionInThread is false (global)", () => {
      expect(
        resolveFeishuReplyPolicy({
          isDirectMessage: false,
          isThreadReply: true,
          globalConfig: { requireMentionInThread: false } as FeishuConfig,
        }),
      ).toEqual({ requireMention: false });
    });

    it("skips mention for thread replies when requireMentionInThread is false (group)", () => {
      expect(
        resolveFeishuReplyPolicy({
          isDirectMessage: false,
          isThreadReply: true,
          groupConfig: { requireMentionInThread: false } as FeishuGroupConfig,
        }),
      ).toEqual({ requireMention: false });
    });

    it("group-level requireMentionInThread overrides global", () => {
      expect(
        resolveFeishuReplyPolicy({
          isDirectMessage: false,
          isThreadReply: true,
          globalConfig: { requireMentionInThread: false } as FeishuConfig,
          groupConfig: { requireMentionInThread: true } as FeishuGroupConfig,
        }),
      ).toEqual({ requireMention: true });
    });

    it("requireMentionInThread tightens when base requireMention is false", () => {
      expect(
        resolveFeishuReplyPolicy({
          isDirectMessage: false,
          isThreadReply: true,
          globalConfig: { requireMention: false } as FeishuConfig,
          groupConfig: { requireMentionInThread: true } as FeishuGroupConfig,
        }),
      ).toEqual({ requireMention: true });
    });

    it("does not apply thread override for non-thread messages", () => {
      expect(
        resolveFeishuReplyPolicy({
          isDirectMessage: false,
          isThreadReply: false,
          globalConfig: { requireMentionInThread: false } as FeishuConfig,
        }),
      ).toEqual({ requireMention: true });
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
});
