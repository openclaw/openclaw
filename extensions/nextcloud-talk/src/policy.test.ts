import { describe, expect, it } from "vitest";
import { resolveNextcloudTalkAllowlistMatch, resolveNextcloudTalkGroupAllow } from "./policy.js";

describe("nextcloud-talk policy", () => {
  describe("resolveNextcloudTalkAllowlistMatch", () => {
    it("allows wildcard", () => {
      expect(
        resolveNextcloudTalkAllowlistMatch({
          allowFrom: ["*"],
          senderId: "user-id",
        }).allowed,
      ).toBe(true);
    });

    it("allows sender id match with normalization", () => {
      expect(
        resolveNextcloudTalkAllowlistMatch({
          allowFrom: ["nc:User-Id"],
          senderId: "user-id",
        }),
      ).toEqual({ allowed: true, matchKey: "user-id", matchSource: "id" });
    });

    it("blocks when sender id does not match", () => {
      expect(
        resolveNextcloudTalkAllowlistMatch({
          allowFrom: ["allowed"],
          senderId: "other",
        }).allowed,
      ).toBe(false);
    });
  });

  describe("resolveNextcloudTalkGroupAllow", () => {
    it("blocks disabled policy", () => {
      expect(
        resolveNextcloudTalkGroupAllow({
          groupPolicy: "disabled",
          outerAllowFrom: ["owner"],
          innerAllowFrom: ["room-user"],
          senderId: "owner",
        }),
      ).toEqual({
        allowed: false,
        outerMatch: { allowed: false },
        innerMatch: { allowed: false },
      });
    });

    it("allows open policy", () => {
      expect(
        resolveNextcloudTalkGroupAllow({
          groupPolicy: "open",
          outerAllowFrom: [],
          innerAllowFrom: [],
          senderId: "owner",
        }),
      ).toEqual({
        allowed: true,
        outerMatch: { allowed: true },
        innerMatch: { allowed: true },
      });
    });

    it("blocks allowlist mode when both outer and inner allowlists are empty", () => {
      expect(
        resolveNextcloudTalkGroupAllow({
          groupPolicy: "allowlist",
          outerAllowFrom: [],
          innerAllowFrom: [],
          senderId: "owner",
        }),
      ).toEqual({
        allowed: false,
        outerMatch: { allowed: false },
        innerMatch: { allowed: false },
      });
    });

    it("requires inner match when only room-specific allowlist is configured", () => {
      expect(
        resolveNextcloudTalkGroupAllow({
          groupPolicy: "allowlist",
          outerAllowFrom: [],
          innerAllowFrom: ["room-user"],
          senderId: "room-user",
        }),
      ).toEqual({
        allowed: true,
        outerMatch: { allowed: false },
        innerMatch: { allowed: true, matchKey: "room-user", matchSource: "id" },
      });
    });

    it("blocks when outer allowlist misses even if inner allowlist matches", () => {
      expect(
        resolveNextcloudTalkGroupAllow({
          groupPolicy: "allowlist",
          outerAllowFrom: ["team-owner"],
          innerAllowFrom: ["room-user"],
          senderId: "room-user",
        }),
      ).toEqual({
        allowed: false,
        outerMatch: { allowed: false },
        innerMatch: { allowed: true, matchKey: "room-user", matchSource: "id" },
      });
    });

    it("allows when both outer and inner allowlists match", () => {
      expect(
        resolveNextcloudTalkGroupAllow({
          groupPolicy: "allowlist",
          outerAllowFrom: ["team-owner"],
          innerAllowFrom: ["room-user"],
          senderId: "team-owner",
        }),
      ).toEqual({
        allowed: false,
        outerMatch: { allowed: true, matchKey: "team-owner", matchSource: "id" },
        innerMatch: { allowed: false },
      });

      expect(
        resolveNextcloudTalkGroupAllow({
          groupPolicy: "allowlist",
          outerAllowFrom: ["shared-user"],
          innerAllowFrom: ["shared-user"],
          senderId: "shared-user",
        }),
      ).toEqual({
        allowed: true,
        outerMatch: { allowed: true, matchKey: "shared-user", matchSource: "id" },
        innerMatch: { allowed: true, matchKey: "shared-user", matchSource: "id" },
      });
    });
  });
});
