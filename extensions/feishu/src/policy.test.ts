import { describe, expect, it } from "vitest";
import { isFeishuGroupAllowed, resolveFeishuAllowlistMatch } from "./policy.js";

describe("feishu policy", () => {
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
  });
});
