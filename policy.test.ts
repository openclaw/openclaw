import { describe, expect, it } from "vitest";
import {
  isFeishuGroupAllowed,
  resolveFeishuAllowlistMatch,
  resolveFeishuGroupConfig,
  resolveFeishuGroupToolPolicy,
} from "./policy.js";
import type { FeishuConfig } from "./types.js";
import type { ChannelGroupContext } from "openclaw/plugin-sdk/feishu";

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

    // New tests for group ID normalization
    it("matches group config with group: prefix in config but not in query", () => {
      const cfg = {
        groups: {
          "group:oc_test_group": { requireMention: false },
        },
      } as unknown as FeishuConfig;

      const resolved = resolveFeishuGroupConfig({
        cfg,
        groupId: "oc_test_group",
      });

      expect(resolved).toEqual({ requireMention: false });
    });

    it("matches group config without group: prefix when query has prefix", () => {
      const cfg = {
        groups: {
          "oc_test_group": { requireMention: true },
        },
      } as unknown as FeishuConfig;

      const resolved = resolveFeishuGroupConfig({
        cfg,
        groupId: "group:oc_test_group",
      });

      expect(resolved).toEqual({ requireMention: true });
    });

    it("matches group config with both having group: prefix", () => {
      const cfg = {
        groups: {
          "group:oc_test_group": { requireMention: false },
        },
      } as unknown as FeishuConfig;

      const resolved = resolveFeishuGroupConfig({
        cfg,
        groupId: "group:oc_test_group",
      });

      expect(resolved).toEqual({ requireMention: false });
    });

    it("handles feishu: prefix along with group: prefix", () => {
      const cfg = {
        groups: {
          "feishu:group:oc_test_group": { requireMention: true },
        },
      } as unknown as FeishuConfig;

      const resolved = resolveFeishuGroupConfig({
        cfg,
        groupId: "oc_test_group",
      });

      expect(resolved).toEqual({ requireMention: true });
    });

    it("prefers exact match over normalized match", () => {
      const cfg = {
        groups: {
          "oc_test": { requireMention: true },
          "group:oc_test": { requireMention: false },
        },
      } as unknown as FeishuConfig;

      // Direct match should take precedence
      const resolvedDirect = resolveFeishuGroupConfig({
        cfg,
        groupId: "oc_test",
      });
      expect(resolvedDirect).toEqual({ requireMention: true });

      // Direct match for the prefixed one
      const resolvedPrefixed = resolveFeishuGroupConfig({
        cfg,
        groupId: "group:oc_test",
      });
      expect(resolvedPrefixed).toEqual({ requireMention: false });
    });
  });

  describe("resolveFeishuGroupToolPolicy", () => {
    it("returns tools config for group with group: prefix in binding", () => {
      const cfg = {
        channels: {
          feishu: {
            groups: {
              "group:oc_test_group": {
                tools: {
                  enabled: ["doc", "wiki"],
                  disabled: [],
                },
              },
            },
          },
        },
      } as unknown as ChannelGroupContext["cfg"];

      const context: ChannelGroupContext = {
        cfg,
        groupId: "oc_test_group",
        peer: { kind: "group", id: "oc_test_group" },
      };

      const policy = resolveFeishuGroupToolPolicy(context);
      expect(policy).toEqual({
        enabled: ["doc", "wiki"],
        disabled: [],
      });
    });

    it("returns tools config for group without prefix in binding", () => {
      const cfg = {
        channels: {
          feishu: {
            groups: {
              "oc_test_group": {
                tools: {
                  enabled: ["chat"],
                  disabled: ["drive"],
                },
              },
            },
          },
        },
      } as unknown as ChannelGroupContext["cfg"];

      const context: ChannelGroupContext = {
        cfg,
        groupId: "group:oc_test_group",
        peer: { kind: "group", id: "group:oc_test_group" },
      };

      const policy = resolveFeishuGroupToolPolicy(context);
      expect(policy).toEqual({
        enabled: ["chat"],
        disabled: ["drive"],
      });
    });

    it("returns undefined when no matching group config exists", () => {
      const cfg = {
        channels: {
          feishu: {
            groups: {
              "oc_other_group": {
                tools: {
                  enabled: ["doc"],
                },
              },
            },
          },
        },
      } as unknown as ChannelGroupContext["cfg"];

      const context: ChannelGroupContext = {
        cfg,
        groupId: "oc_unmatched_group",
        peer: { kind: "group", id: "oc_unmatched_group" },
      };

      const policy = resolveFeishuGroupToolPolicy(context);
      expect(policy).toBeUndefined();
    });

    it("returns undefined when feishu config is missing", () => {
      const cfg = {
        channels: {},
      } as unknown as ChannelGroupContext["cfg"];

      const context: ChannelGroupContext = {
        cfg,
        groupId: "oc_test_group",
        peer: { kind: "group", id: "oc_test_group" },
      };

      const policy = resolveFeishuGroupToolPolicy(context);
      expect(policy).toBeUndefined();
    });

    it("falls back to wildcard group config", () => {
      const cfg = {
        channels: {
          feishu: {
            groups: {
              "*": {
                tools: {
                  enabled: ["default"],
                },
              },
            },
          },
        },
      } as unknown as ChannelGroupContext["cfg"];

      const context: ChannelGroupContext = {
        cfg,
        groupId: "oc_unmatched_group",
        peer: { kind: "group", id: "oc_unmatched_group" },
      };

      const policy = resolveFeishuGroupToolPolicy(context);
      expect(policy).toEqual({
        enabled: ["default"],
      });
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
});
